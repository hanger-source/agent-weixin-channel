#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'

import {
  enqueueMessage,
  getMessage,
  getMeta,
  listMessages,
  listRecipients,
  openDatabase,
  queueCounts,
  renameRecipient,
  setMeta,
  upsertRecipient,
} from './database.js'
import { daemonStatus, runDaemon, startDaemon, stopDaemon } from './daemon.js'
import { performLogin, providerPackage } from './provider.js'
import { statePaths } from './paths.js'

const program = new Command()
program
  .name('weixin-channel')
  .description('宿主无关的 Agent 微信通知通道')
  .version('0.1.0')
  .option('--json', '只向 stdout 输出稳定 JSON')

function jsonMode() {
  return Boolean(program.opts().json)
}

function output(value, human) {
  if (jsonMode()) process.stdout.write(`${JSON.stringify({ ok: true, data: value })}\n`)
  else process.stdout.write(`${human ?? JSON.stringify(value, null, 2)}\n`)
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (jsonMode()) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: 'WEIXIN_CHANNEL_ERROR', message } })}\n`)
  else process.stderr.write(`weixin-channel: ${message}\n`)
  process.exitCode = 1
}

async function action(fn) {
  try { await fn() } catch (error) { fail(error) }
}

function readMessage(opts) {
  const sources = [opts.message != null, opts.messageFile != null, opts.stdin === true].filter(Boolean).length
  if (sources !== 1) throw new Error('必须且只能使用 --message、--message-file 或 --stdin 之一')
  if (opts.message != null) return String(opts.message)
  if (opts.messageFile != null) return fs.readFileSync(path.resolve(opts.messageFile), 'utf8')
  return fs.readFileSync(0, 'utf8')
}

program.command('doctor').description('检查依赖、登录、daemon、收件人与队列状态').action(() => action(async () => {
  const db = openDatabase()
  try {
    const provider = providerPackage()
    const accountId = getMeta(db, 'account_id') || null
    const recipients = listRecipients(db)
    const daemon = daemonStatus()
    const channelHealth = getMeta(db, 'channel_health') || 'not-started'
    const channelError = getMeta(db, 'channel_error') || null
    const data = {
      version: program.version(),
      node: process.version,
      provider,
      stateHome: statePaths().home,
      accountId,
      daemon,
      channelHealth,
      channelError,
      recipients: recipients.length,
      readyRecipients: recipients.filter((recipient) => recipient.ready).length,
      queue: queueCounts(db),
      ready: Boolean(
        accountId && daemon.running && daemon.ready && channelHealth === 'healthy' &&
        recipients.some((recipient) => recipient.ready),
      ),
    }
    output(data, [
      `provider: ${provider.name}@${provider.version}`,
      `account: ${accountId || '未登录'}`,
      `daemon: ${daemon.running ? `运行中 (${daemon.pid})` : '未运行'}`,
      `channel: ${channelHealth}${channelError ? ` (${channelError})` : ''}`,
      `recipients: ${data.readyRecipients}/${data.recipients} ready`,
      `ready: ${data.ready ? 'yes' : 'no'}`,
    ].join('\n'))
  } finally { db.close() }
}))

program.command('login').description('交互式扫码登录；成功后启动常驻 daemon').action(() => action(async () => {
  if (jsonMode()) throw new Error('login 是交互式二维码流程，请去掉 --json 后运行')
  if (daemonStatus().running) await stopDaemon()
  const result = await performLogin()
  const db = openDatabase()
  try {
    setMeta(db, 'account_id', result.accountId)
    if (result.userId) {
      setMeta(db, 'owner_user_id', result.userId)
      upsertRecipient(db, { alias: 'hang', userId: result.userId, accountId: result.accountId })
    }
  } finally { db.close() }
  const daemon = await startDaemon()
  output({ ...result, daemon }, `登录成功，账号 ${result.accountId}；daemon PID ${daemon.pid}`)
}))

const daemon = program.command('daemon').description('管理唯一微信长轮询与发送进程')
daemon.command('start').action(() => action(async () => output(await startDaemon(), 'daemon 已启动')))
daemon.command('stop').action(() => action(async () => output(await stopDaemon(), 'daemon 已停止')))
daemon.command('status').action(() => action(async () => output(daemonStatus())))

const recipients = program.command('recipients').description('发现并命名微信收件人')
recipients.command('list').action(() => action(async () => {
  const db = openDatabase(); try { output(listRecipients(db)) } finally { db.close() }
}))
recipients.command('alias')
  .description('把已发现的微信用户 ID 绑定为稳定别名')
  .argument('<user-id>')
  .argument('<alias>')
  .action((userId, alias) => action(async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(alias)) throw new Error('别名只允许字母、数字、下划线、连字符，长度 1-32')
    const db = openDatabase(); try { output(renameRecipient(db, userId, alias)) } finally { db.close() }
  }))

program.command('send')
  .description('把一条通知提交到 durable outbox')
  .option('--to <alias>', '收件人别名', 'hang')
  .option('--message <text>', '消息文本')
  .option('--message-file <path>', '从文件读取消息')
  .option('--stdin', '从 stdin 读取消息')
  .option('--source <name>', '发送 Agent 或任务名')
  .option('--dedupe-key <key>', '幂等键；重复提交返回原消息')
  .option('--dry-run', '只解析并验证，不写入队列')
  .action((opts) => action(async () => {
    const text = readMessage(opts).trim()
    if (!text) throw new Error('消息不能为空')
    const db = openDatabase()
    try {
      const recipient = listRecipients(db).find((item) => item.alias === opts.to)
      if (!recipient) throw new Error(`未知收件人别名 ${opts.to}`)
      if (!recipient.ready) throw new Error(`收件人 ${opts.to} 尚未建立可发送会话`)
      if (opts.dryRun) {
        output({ dryRun: true, recipient: opts.to, source: opts.source || null, text })
        return
      }
      const result = enqueueMessage(db, {
        recipientAlias: opts.to,
        text,
        source: opts.source,
        dedupeKey: opts.dedupeKey,
      })
      output(result, `${result.status}: ${result.id}${result.deduplicated ? ' (deduplicated)' : ''}`)
    } finally { db.close() }
  }))

const messages = program.command('messages').description('检查通知队列与微信接受状态')
messages.command('list').option('--limit <number>', '最多返回条数', '20').action((opts) => action(async () => {
  const db = openDatabase(); try { output(listMessages(db, opts.limit)) } finally { db.close() }
}))
messages.command('get').argument('<message-id>').action((id) => action(async () => {
  const db = openDatabase()
  try {
    const message = getMessage(db, id)
    if (!message) throw new Error(`没有消息 ${id}`)
    output(message)
  } finally { db.close() }
}))

const skill = program.command('skill').description('安装或检查共享 Agent Skill')
skill.command('install').action(() => action(async () => {
  const script = new URL('../scripts/install-skill.js', import.meta.url)
  const { installSkill } = await import(script.href)
  const target = installSkill()
  output({ installed: true, path: target }, `Skill 已安装到 ${target}`)
}))
skill.command('status').action(() => action(async () => {
  const target = path.join(os.homedir(), '.agents', 'skills', 'weixin-channel', 'SKILL.md')
  output({ installed: fs.existsSync(target), path: target })
}))

program.command('_daemon-run', { hidden: true }).action(() => action(runDaemon))

await program.parseAsync()
