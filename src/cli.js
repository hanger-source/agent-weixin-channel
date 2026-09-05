#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'

import {
  acknowledgeAgentMessage,
  claimAgentMessage,
  enqueueMessage,
  getAgent,
  getMessage,
  getMeta,
  listAgentInbox,
  listAgents,
  listMessages,
  listRecipients,
  openDatabase,
  queueCounts,
  registerAgent,
  renameRecipient,
  setMeta,
  updateAgent,
  upsertRecipient,
  validateAgentDescription,
  validateAgentName,
} from './database.js'
import { daemonStatus, runDaemon, startDaemon, stopDaemon } from './daemon.js'
import { performLogin, providerPackage } from './provider.js'
import { statePaths } from './paths.js'

const program = new Command()
program
  .name('agent-weixin-channel')
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
  else process.stderr.write(`agent-weixin-channel: ${message}\n`)
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
      agents: listAgents(db).length,
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

const agents = program.command('agents').description('管理共享通道中的隔离 Agent 身份')
agents.command('register')
  .argument('<agent-name>')
  .requiredOption('--description <text>', '每条微信消息中显示的当前任务描述')
  .option('--codex-thread <thread-id>', '收到 @名称 时立即排入这个 Codex task')
  .action((agentName, opts) => action(async () => {
    validateAgentName(agentName)
    const description = validateAgentDescription(opts.description)
    const adapter = opts.codexThread ? 'codex' : 'mailbox'
    const adapterTarget = opts.codexThread || null
    const db = openDatabase()
    try { output(registerAgent(db, { name: agentName, description, adapter, adapterTarget })) } finally { db.close() }
  }))
agents.command('list').action(() => action(async () => {
  const db = openDatabase(); try { output(listAgents(db)) } finally { db.close() }
}))
agents.command('get').argument('<agent-name>').action((agentName) => action(async () => {
  const db = openDatabase()
  try {
    const agent = getAgent(db, agentName)
    if (!agent) throw new Error(`未知 Agent“${agentName}”`)
    output(agent)
  } finally { db.close() }
}))
agents.command('update')
  .argument('<current-name>')
  .requiredOption('--name <agent-name>', '新的两字中文名称')
  .requiredOption('--description <text>', '新的当前任务描述')
  .action((currentName, opts) => action(async () => {
    validateAgentName(opts.name)
    const description = validateAgentDescription(opts.description)
    const db = openDatabase()
    try { output(updateAgent(db, currentName, { name: opts.name, description })) } finally { db.close() }
  }))

program.command('send')
  .description('把一条通知提交到 durable outbox')
  .option('--to <alias>', '收件人别名', 'hang')
  .requiredOption('--from <agent-name>', '已注册的两字 Agent 名称')
  .option('--message <text>', '消息文本')
  .option('--message-file <path>', '从文件读取消息')
  .option('--stdin', '从 stdin 读取消息')
  .option('--file <path>', '发送图片、视频或普通文件')
  .option('--caption <text>', '媒体消息说明')
  .option('--dedupe-key <key>', '幂等键；重复提交返回原消息')
  .option('--dry-run', '只解析并验证，不写入队列')
  .action((opts) => action(async () => {
    validateAgentName(opts.from)
    const hasTextSource = opts.message != null || opts.messageFile != null || opts.stdin === true
    if (opts.file && hasTextSource) throw new Error('媒体消息使用 --file 和可选 --caption，不要同时传文本来源')
    if (!opts.file && opts.caption != null) throw new Error('--caption 只用于 --file')
    const text = opts.file ? String(opts.caption || '').trim() : readMessage(opts).trim()
    if (!opts.file && !text) throw new Error('消息不能为空')
    const mediaPath = opts.file ? path.resolve(opts.file) : null
    if (mediaPath && !fs.statSync(mediaPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`媒体文件不存在或不是普通文件：${mediaPath}`)
    }
    const db = openDatabase()
    try {
      const recipient = listRecipients(db).find((item) => item.alias === opts.to)
      if (!recipient) throw new Error(`未知收件人别名 ${opts.to}`)
      if (!recipient.ready) throw new Error(`收件人 ${opts.to} 尚未建立可发送会话`)
      if (opts.dryRun) {
        if (!getAgent(db, opts.from)) throw new Error(`未知 Agent ${opts.from}`)
        output({ dryRun: true, recipient: opts.to, agentName: opts.from, text, mediaPath })
        return
      }
      const result = enqueueMessage(db, {
        recipientAlias: opts.to,
        agentName: opts.from,
        text,
        mediaPath,
        dedupeKey: opts.dedupeKey,
      })
      output(result, `${result.status}: ${result.id}${result.deduplicated ? ' (deduplicated)' : ''}`)
    } finally { db.close() }
  }))

const inbox = program.command('inbox').description('读取按 @两字名称 路由的隔离收件箱')
inbox.command('list')
  .requiredOption('--agent <agent-name>')
  .option('--status <status>', 'unread、claimed、acknowledged、dispatched 或 dispatch_failed')
  .option('--limit <number>', '最多返回条数', '20')
  .action((opts) => action(async () => {
    const db = openDatabase()
    try { output(listAgentInbox(db, opts.agent, { status: opts.status, limit: opts.limit })) } finally { db.close() }
  }))
inbox.command('claim').requiredOption('--agent <agent-name>').action((opts) => action(async () => {
  const db = openDatabase(); try { output(claimAgentMessage(db, opts.agent)) } finally { db.close() }
}))
inbox.command('ack')
  .argument('<message-id>')
  .requiredOption('--agent <agent-name>')
  .action((messageId, opts) => action(async () => {
    const db = openDatabase()
    try { output(acknowledgeAgentMessage(db, opts.agent, messageId)) } finally { db.close() }
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

program.command('_daemon-run', { hidden: true }).action(() => action(runDaemon))

await program.parseAsync()
