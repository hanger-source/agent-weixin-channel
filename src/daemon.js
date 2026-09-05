import fs from 'node:fs'
import { spawn } from 'node:child_process'

import {
  claimNextCodexBatch,
  claimNextMessage,
  getMeta,
  markAgentMessagesDispatched,
  markAgentMessagesDispatchFailed,
  markAccepted,
  markFailed,
  markRetrying,
  observeRecipient,
  openDatabase,
  recordInbound,
  resetInterruptedAgentDeliveries,
  resetInterruptedMessages,
  setMeta,
} from './database.js'
import { dispatchToCodex } from './adapters/codex.js'
import { ensureStateHome, statePaths } from './paths.js'
import { downloadInboundMedia, extractText, loadProvider } from './provider.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const CODEX_BATCH_SETTLE_MS = 1500

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function daemonStatus() {
  const paths = statePaths()
  let pid = null
  let readyPid = null
  try { pid = Number(fs.readFileSync(paths.pid, 'utf8').trim()) } catch {}
  try { readyPid = Number(JSON.parse(fs.readFileSync(paths.ready, 'utf8')).pid) } catch {}
  const running = processAlive(pid)
  return {
    running,
    ready: running && readyPid === pid,
    pid: running ? pid : null,
    log: paths.log,
  }
}

export async function startDaemon() {
  const current = daemonStatus()
  if (current.running && current.ready) return current
  if (current.running) throw new Error(`daemon ${current.pid} 正在启动但尚未 ready`)
  const paths = ensureStateHome()
  try { fs.unlinkSync(paths.ready) } catch {}
  const log = fs.openSync(paths.log, 'a', 0o600)
  const child = spawn(process.execPath, [new URL('./cli.js', import.meta.url).pathname, '_daemon-run'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, AGENT_WEIXIN_CHANNEL_HOME: paths.home },
  })
  let exitCode
  child.once('exit', (code) => { exitCode = code })
  child.unref()
  fs.closeSync(log)
  const startedAt = Date.now()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const status = daemonStatus()
    if (status.running && status.ready) return status
    if (exitCode !== undefined || (!status.running && Date.now() - startedAt > 500)) {
      throw new Error(`微信通道 daemon 启动失败（exit=${exitCode ?? 'unknown'}）；查看 ${paths.log}`)
    }
    await sleep(100)
  }
  throw new Error(`微信通道 daemon 未能启动；查看 ${paths.log}`)
}

export async function stopDaemon() {
  const current = daemonStatus()
  if (!current.running) return current
  process.kill(current.pid, 'SIGTERM')
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (!daemonStatus().running) return daemonStatus()
    await sleep(100)
  }
  throw new Error(`daemon ${current.pid} 未在 8 秒内退出`)
}

function acquirePidFile() {
  const paths = ensureStateHome()
  try {
    const fd = fs.openSync(paths.pid, 'wx', 0o600)
    fs.writeFileSync(fd, String(process.pid))
    fs.closeSync(fd)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const status = daemonStatus()
    if (status.running) throw new Error(`daemon 已运行，PID ${status.pid}`)
    fs.unlinkSync(paths.pid)
    return acquirePidFile()
  }
  return () => {
    try {
      if (Number(fs.readFileSync(paths.pid, 'utf8').trim()) === process.pid) fs.unlinkSync(paths.pid)
    } catch {}
    try { fs.unlinkSync(paths.ready) } catch {}
  }
}

async function dispatchLoop({ db, account, provider, signal }) {
  while (!signal.aborted) {
    const message = claimNextMessage(db)
    if (!message) { await sleep(300); continue }
    try {
      if (message.accountId !== account.accountId) {
        throw new Error(`收件人属于账号 ${message.accountId}，当前 daemon 账号为 ${account.accountId}`)
      }
      const opts = {
        baseUrl: account.baseUrl,
        token: account.token,
        contextToken: message.contextToken,
      }
      const result = message.mediaPath
        ? await provider.sendMedia.sendWeixinMediaFile({
            filePath: message.mediaPath,
            to: message.userId,
            text: message.renderedText,
            opts,
          })
        : await provider.send.sendMessageWeixin({
            to: message.userId,
            text: message.renderedText,
            opts,
          })
      markAccepted(db, message.id, result.messageId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (error?.contextFrozen || message.attempts >= 5) markFailed(db, message.id, detail)
      else markRetrying(db, message.id, message.attempts, detail)
    }
  }
}

async function pollingLoop({ db, account, provider, signal }) {
  let cursor = getMeta(db, `cursor:${account.accountId}`) || ''
  let invalidCount = 0
  while (!signal.aborted) {
    try {
      const response = await provider.api.getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: cursor,
        timeoutMs: 35_000,
        abortSignal: signal,
      })
      if (signal.aborted) break
      if (response.errcode === -14) {
        invalidCount += 1
        if (invalidCount >= 3) {
          setMeta(db, 'channel_health', 'reauth-required')
          setMeta(db, 'channel_error', '微信会话已失效（-14）；需要重新登录')
          throw new Error('微信会话已失效（-14）；需要重新登录')
        }
        await sleep(5000)
        continue
      }
      invalidCount = 0
      setMeta(db, 'channel_health', 'healthy')
      setMeta(db, 'channel_error', '')
      if (typeof response.get_updates_buf === 'string' && response.get_updates_buf !== cursor) {
        cursor = response.get_updates_buf
        setMeta(db, `cursor:${account.accountId}`, cursor)
      }
      const ownerUserId = getMeta(db, 'owner_user_id')
      for (const message of response.msgs || []) {
        const userId = message.from_user_id || ''
        if (!userId) continue
        const contextToken = message.context_token || null
        observeRecipient(db, { userId, accountId: account.accountId, contextToken, ownerUserId })
        const messageId = String(message.message_id || message.client_id || `${Date.now()}-${Math.random()}`)
        const text = extractText(message)
        const media = await downloadInboundMedia(message, provider, account)
        recordInbound(db, {
          id: messageId,
          accountId: account.accountId,
          userId,
          text,
          media,
          contextToken,
          messageCreatedAt: message.create_time_ms ? new Date(message.create_time_ms).toISOString() : null,
        })
      }
    } catch (error) {
      if (signal.aborted) break
      const detail = error instanceof Error ? error.message : String(error)
      if (!detail.includes('-14')) {
        setMeta(db, 'channel_health', 'degraded')
        setMeta(db, 'channel_error', detail.slice(0, 2000))
      }
      console.error(new Date().toISOString(), 'polling failed:', detail)
      await sleep(detail.includes('-14') ? 60_000 : 2000)
    }
  }
}

async function codexDispatchLoop({ db, signal }) {
  while (!signal.aborted) {
    const settleBefore = new Date(Date.now() - CODEX_BATCH_SETTLE_MS).toISOString()
    const batch = claimNextCodexBatch(db, settleBefore)
    if (!batch) {
      await sleep(200)
      continue
    }
    const ids = batch.messages.map((message) => message.id)
    try {
      await dispatchToCodex({
        threadId: batch.threadId,
        agentName: batch.agentName,
        messages: batch.messages,
      })
      markAgentMessagesDispatched(db, batch.id, ids)
    } catch (error) {
      markAgentMessagesDispatchFailed(db, batch.id, ids, error)
      console.error(new Date().toISOString(), `codex batch dispatch failed agent=${batch.agentName}:`, String(error))
    }
  }
}

export async function runDaemon() {
  const releasePid = acquirePidFile()
  let db
  let provider
  let account
  let controller
  let stop
  try {
    db = openDatabase()
    resetInterruptedMessages(db)
    resetInterruptedAgentDeliveries(db)
    provider = await loadProvider()
    const accountId = getMeta(db, 'account_id')
    if (!accountId) throw new Error('尚未登录；先运行 agent-weixin-channel login')
    const stored = provider.accounts.loadWeixinAccount(accountId)
    if (!stored?.token) throw new Error(`账号 ${accountId} 缺少登录凭据`)
    account = {
      accountId,
      token: stored.token,
      baseUrl: stored.baseUrl || provider.accounts.DEFAULT_BASE_URL,
      cdnBaseUrl: provider.accounts.CDN_BASE_URL,
    }
    controller = new AbortController()
    stop = () => controller.abort()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    const start = await provider.api.notifyStart({ baseUrl: account.baseUrl, token: account.token })
    if (start.ret != null && start.ret !== 0) throw new Error(`notifyStart ret=${start.ret} ${start.errmsg || ''}`)
    setMeta(db, 'channel_health', 'starting')
    setMeta(db, 'channel_error', '')
    setMeta(db, 'daemon_ready_at', new Date().toISOString())
    fs.writeFileSync(statePaths().ready, JSON.stringify({ pid: process.pid, readyAt: new Date().toISOString() }), { mode: 0o600 })
    console.log(new Date().toISOString(), `agent-weixin-channel daemon ready account=${accountId}`)
    await Promise.all([
      pollingLoop({ db, account, provider, signal: controller.signal }),
      dispatchLoop({ db, account, provider, signal: controller.signal }),
      codexDispatchLoop({ db, signal: controller.signal }),
    ])
    await provider.api.notifyStop({ baseUrl: account.baseUrl, token: account.token }).catch(() => {})
  } finally {
    try {
      if (stop) {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
      }
      if (db) {
        setMeta(db, 'channel_health', 'stopped')
        db.close()
      }
    } finally {
      releasePid()
    }
  }
}
