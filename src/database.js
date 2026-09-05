import crypto from 'node:crypto'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { ensureStateHome } from './paths.js'

function now() {
  return new Date().toISOString()
}

export function validateAgentName(name) {
  if (!/^\p{Script=Han}{2}$/u.test(String(name || ''))) {
    throw new Error('Agent 名称必须恰好是两个汉字，例如“悟空”或“黛玉”')
  }
  return name
}

export function validateAgentDescription(description) {
  const value = String(description || '').trim()
  if (!value || [...value].length > 40 || /[\r\n]/.test(value)) {
    throw new Error('任务描述必须是 1-40 个字符的单行文本')
  }
  return value
}

export function openDatabase() {
  const paths = ensureStateHome()
  const db = new DatabaseSync(paths.database)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipients (
      alias TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      account_id TEXT NOT NULL,
      context_token TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      adapter TEXT NOT NULL DEFAULT 'mailbox',
      adapter_target TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      context_token TEXT,
      message_created_at TEXT,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_inbox (
      message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_at TEXT,
      dispatched_at TEXT,
      acknowledged_at TEXT,
      last_error TEXT,
      PRIMARY KEY (message_id, agent_id),
      FOREIGN KEY (message_id) REFERENCES inbox(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      recipient_alias TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT,
      dedupe_key TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      provider_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      accepted_at TEXT,
      FOREIGN KEY (recipient_alias) REFERENCES recipients(alias) ON UPDATE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedupe_key
      ON outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS agents_name
      ON agents(display_name);
    CREATE INDEX IF NOT EXISTS outbox_dispatch
      ON outbox(status, next_attempt_at, created_at);
  `)
  ensureColumn(db, 'inbox', 'route_key', 'TEXT')
  ensureColumn(db, 'inbox', 'media_json', 'TEXT')
  ensureColumn(db, 'agents', 'adapter', "TEXT NOT NULL DEFAULT 'mailbox'")
  ensureColumn(db, 'agents', 'adapter_target', 'TEXT')
  ensureColumn(db, 'agents', 'description', 'TEXT')
  ensureColumn(db, 'agent_inbox', 'dispatched_at', 'TEXT')
  ensureColumn(db, 'agent_inbox', 'last_error', 'TEXT')
  ensureColumn(db, 'outbox', 'agent_id', 'TEXT')
  ensureColumn(db, 'outbox', 'rendered_text', 'TEXT')
  ensureColumn(db, 'outbox', 'media_path', 'TEXT')
  try { fs.chmodSync(paths.database, 0o600) } catch {}
  return db
}

function ensureColumn(db, table, column, declaration) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
}

export function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value))
}

export function registerAgent(db, { name, description, adapter = 'mailbox', adapterTarget = null }) {
  validateAgentName(name)
  description = validateAgentDescription(description)
  const existing = getAgent(db, name)
  if (existing) {
    if (
      existing.description !== description ||
      existing.adapter !== adapter ||
      existing.adapterTarget !== adapterTarget
    ) {
      throw new Error(`Agent 名称“${name}”已绑定其他宿主；请选择另一个名称`)
    }
    return existing
  }
  const id = crypto.randomUUID()
  const timestamp = now()
  db.prepare(`
    INSERT INTO agents(id, display_name, description, adapter, adapter_target, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, description, adapter, adapterTarget, timestamp, timestamp)
  return getAgent(db, name)
}

export function getAgent(db, name) {
  return db.prepare(`
    SELECT id, display_name AS name, description, adapter, adapter_target AS adapterTarget,
           created_at AS createdAt, updated_at AS updatedAt
    FROM agents WHERE display_name = ?
  `).get(name) || null
}

export function getAgentById(db, id) {
  return db.prepare(`
    SELECT id, display_name AS name, description, adapter, adapter_target AS adapterTarget,
           created_at AS createdAt, updated_at AS updatedAt
    FROM agents WHERE id = ?
  `).get(id) || null
}

export function updateAgent(db, currentName, { name, description }) {
  validateAgentName(name)
  description = validateAgentDescription(description)
  const agent = getAgent(db, currentName)
  if (!agent) throw new Error(`未知 Agent“${currentName}”`)
  const namedAgent = getAgent(db, name)
  if (namedAgent && namedAgent.id !== agent.id) throw new Error(`Agent 名称“${name}”已被使用`)
  db.prepare('UPDATE agents SET display_name = ?, description = ?, updated_at = ? WHERE id = ?')
    .run(name, description, now(), agent.id)
  return getAgent(db, name)
}

export function listAgents(db) {
  return db.prepare(`
    SELECT id, display_name AS name, description, adapter, adapter_target AS adapterTarget,
           created_at AS createdAt, updated_at AS updatedAt
    FROM agents ORDER BY display_name
  `).all()
}

export function listRecipients(db) {
  return db.prepare(`
    SELECT alias, user_id AS userId, account_id AS accountId,
           context_token IS NOT NULL AS ready,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
    FROM recipients ORDER BY alias
  `).all().map((row) => ({ ...row, ready: Boolean(row.ready) }))
}

export function getRecipient(db, alias) {
  const row = db.prepare(`
    SELECT alias, user_id AS userId, account_id AS accountId,
           context_token AS contextToken,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
    FROM recipients WHERE alias = ?
  `).get(alias)
  return row || null
}

export function upsertRecipient(db, { alias, userId, accountId, contextToken }) {
  const timestamp = now()
  db.prepare(`
    INSERT INTO recipients(alias, user_id, account_id, context_token, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET
      user_id = excluded.user_id,
      account_id = excluded.account_id,
      context_token = COALESCE(excluded.context_token, recipients.context_token),
      last_seen_at = excluded.last_seen_at
  `).run(alias, userId, accountId, contextToken || null, timestamp, timestamp)
  return getRecipient(db, alias)
}

export function observeRecipient(db, { userId, accountId, contextToken, ownerUserId }) {
  const existing = db.prepare('SELECT alias FROM recipients WHERE user_id = ?').get(userId)
  const alias = existing?.alias || (ownerUserId && ownerUserId === userId ? 'hang' : `user-${userId.slice(0, 8)}`)
  return upsertRecipient(db, { alias, userId, accountId, contextToken })
}

export function renameRecipient(db, userId, alias) {
  const current = db.prepare('SELECT alias FROM recipients WHERE user_id = ?').get(userId)
  if (!current) throw new Error(`没有发现微信用户 ${userId}`)
  db.prepare('UPDATE recipients SET alias = ?, last_seen_at = ? WHERE user_id = ?')
    .run(alias, now(), userId)
  return getRecipient(db, alias)
}

export function parseAgentRoute(text) {
  const match = String(text || '').match(/^\s*@([^\s:：@]+)(?:(?:\s*[:：]\s*|\s+)([\s\S]*))?$/)
  if (!match || [...match[1]].length > 24) return null
  return { agentName: match[1], body: (match[2] || '').trim() }
}

export function recordInbound(db, {
  id, accountId, userId, text, contextToken, messageCreatedAt, media = [],
}) {
  const route = parseAgentRoute(text)
  const knownAgent = route ? getAgent(db, route.agentName) : null
  db.prepare(`
    INSERT OR IGNORE INTO inbox(
      id, account_id, user_id, text, context_token, message_created_at, received_at, route_key, media_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, accountId, userId, route?.body ?? text, contextToken || null,
    messageCreatedAt || null, now(), route?.agentName || null, JSON.stringify(media),
  )
  if (knownAgent) {
    db.prepare(`
      INSERT OR IGNORE INTO agent_inbox(message_id, agent_id, status) VALUES (?, ?, 'unread')
    `).run(id, knownAgent.id)
  }
  return {
    routeName: route?.agentName || null,
    agentId: knownAgent?.id || null,
    body: route?.body ?? text,
    routed: Boolean(knownAgent),
  }
}

export function listAgentInbox(db, agentName, { limit = 20, status } = {}) {
  const agent = getAgent(db, agentName)
  if (!agent) throw new Error(`未知 Agent“${agentName}”`)
  if (status && !['unread', 'claimed', 'acknowledged', 'dispatched', 'dispatch_failed'].includes(status)) {
    throw new Error(`未知 inbox 状态 ${status}`)
  }
  const bounded = Math.max(1, Math.min(200, Number(limit) || 20))
  const statusClause = status ? 'AND d.status = ?' : ''
  const args = status ? [agent.id, status, bounded] : [agent.id, bounded]
  return db.prepare(`
    SELECT i.id, a.display_name AS agentName, d.status, i.user_id AS userId,
           i.text, i.media_json AS mediaJson, i.message_created_at AS messageCreatedAt,
           i.received_at AS receivedAt, d.claimed_at AS claimedAt,
           d.dispatched_at AS dispatchedAt, d.acknowledged_at AS acknowledgedAt,
           d.last_error AS lastError
    FROM agent_inbox d
    JOIN inbox i ON i.id = d.message_id
    JOIN agents a ON a.id = d.agent_id
    WHERE d.agent_id = ? ${statusClause}
    ORDER BY i.received_at DESC LIMIT ?
  `).all(...args).map(({ mediaJson, ...row }) => ({ ...row, media: JSON.parse(mediaJson || '[]') }))
}

export function claimAgentMessage(db, agentName) {
  const agent = getAgent(db, agentName)
  if (!agent) throw new Error(`未知 Agent“${agentName}”`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(`
      SELECT d.message_id AS messageId FROM agent_inbox d
      JOIN inbox i ON i.id = d.message_id
      WHERE d.agent_id = ? AND d.status = 'unread' ORDER BY i.received_at LIMIT 1
    `).get(agent.id)
    if (!row) { db.exec('COMMIT'); return null }
    db.prepare(`
      UPDATE agent_inbox SET status = 'claimed', claimed_at = ?
      WHERE message_id = ? AND agent_id = ? AND status = 'unread'
    `).run(now(), row.messageId, agent.id)
    db.exec('COMMIT')
    return listAgentInbox(db, agentName, { limit: 200, status: 'claimed' })
      .find((message) => message.id === row.messageId) || null
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function acknowledgeAgentMessage(db, agentName, messageId) {
  const agent = getAgent(db, agentName)
  if (!agent) throw new Error(`未知 Agent“${agentName}”`)
  const changed = db.prepare(`
    UPDATE agent_inbox SET status = 'acknowledged', acknowledged_at = ?
    WHERE message_id = ? AND agent_id = ? AND status = 'claimed'
  `).run(now(), messageId, agent.id)
  if (changed.changes !== 1) throw new Error(`消息 ${messageId} 不属于“${agentName}”的 claimed inbox`)
  return { id: messageId, agentName, status: 'acknowledged' }
}

export function markAgentMessageDispatched(db, agentId, messageId) {
  const changed = db.prepare(`
    UPDATE agent_inbox SET status = 'dispatched', dispatched_at = ?, last_error = NULL
    WHERE message_id = ? AND agent_id = ? AND status = 'unread'
  `).run(now(), messageId, agentId)
  if (changed.changes !== 1) throw new Error(`消息 ${messageId} 无法标记为已触发`)
}

export function markAgentMessageDispatchFailed(db, agentId, messageId, error) {
  const changed = db.prepare(`
    UPDATE agent_inbox SET status = 'dispatch_failed', last_error = ?
    WHERE message_id = ? AND agent_id = ? AND status = 'unread'
  `).run(String(error).slice(0, 2000), messageId, agentId)
  if (changed.changes !== 1) throw new Error(`消息 ${messageId} 无法标记为触发失败`)
}

export function enqueueMessage(db, { recipientAlias, agentName, text, mediaPath, dedupeKey }) {
  const recipient = getRecipient(db, recipientAlias)
  if (!recipient) throw new Error(`未知收件人别名 ${recipientAlias}；先运行 recipients list`)
  const agent = getAgent(db, agentName)
  if (!agent) throw new Error(`未知 Agent“${agentName}”；先运行 agents register`)
  if (!recipient.contextToken) {
    throw new Error(`收件人 ${recipientAlias} 尚未建立可发送会话；请先从微信给机器人发一条消息`)
  }
  if (!text && !mediaPath) throw new Error('消息正文和媒体文件不能同时为空')
  if (dedupeKey) {
    const existing = db.prepare(`
      SELECT id, status FROM outbox WHERE dedupe_key = ?
    `).get(dedupeKey)
    if (existing) return { id: existing.id, status: existing.status, deduplicated: true }
  }
  const id = crypto.randomUUID()
  const timestamp = now()
  const renderedText = `【${agent.name}】\n${agent.description}\n${text || ''}`
  if ([...renderedText].length > 1500) {
    throw new Error('名称、任务描述和正文合计超过 1500 个字符；请拆成有独立含义的多条通知')
  }
  db.prepare(`
    INSERT INTO outbox(
      id, recipient_alias, user_id, text, source, dedupe_key, agent_id, rendered_text, media_path,
      status, attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
  `).run(
    id, recipient.alias, recipient.userId, text || '', null, dedupeKey || null,
    agent.id, renderedText, mediaPath || null, timestamp, timestamp,
  )
  return { id, status: 'queued', deduplicated: false }
}

export function resetInterruptedMessages(db) {
  db.prepare(`
    UPDATE outbox SET status = 'queued', updated_at = ?, last_error = 'daemon restarted during send'
    WHERE status = 'sending'
  `).run(now())
}

export function claimNextMessage(db) {
  const row = db.prepare(`
    SELECT o.id, o.recipient_alias AS recipientAlias, o.user_id AS userId,
           o.text, o.agent_id AS agentId, o.rendered_text AS renderedText,
           o.media_path AS mediaPath, o.attempts, r.context_token AS contextToken,
           r.account_id AS accountId
    FROM outbox o
    JOIN recipients r ON r.alias = o.recipient_alias
    WHERE o.status IN ('queued', 'retrying')
      AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
    ORDER BY o.created_at
    LIMIT 1
  `).get(now())
  if (!row) return null
  const changed = db.prepare(`
    UPDATE outbox SET status = 'sending', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'retrying')
  `).run(now(), row.id)
  return changed.changes === 1 ? { ...row, attempts: Number(row.attempts) + 1 } : null
}

export function markAccepted(db, id, providerMessageId) {
  const timestamp = now()
  db.prepare(`
    UPDATE outbox SET status = 'accepted', provider_message_id = ?, last_error = NULL,
      accepted_at = ?, updated_at = ? WHERE id = ?
  `).run(providerMessageId || null, timestamp, timestamp, id)
}

export function markFailed(db, id, error) {
  db.prepare(`
    UPDATE outbox SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
  `).run(String(error).slice(0, 2000), now(), id)
}

export function markRetrying(db, id, attempts, error) {
  const delayMs = Math.min(60_000, 1000 * (2 ** Math.max(0, attempts - 1)))
  const next = new Date(Date.now() + delayMs).toISOString()
  db.prepare(`
    UPDATE outbox SET status = 'retrying', next_attempt_at = ?, last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(next, String(error).slice(0, 2000), now(), id)
}

export function getMessage(db, id) {
  return db.prepare(`
    SELECT o.id, o.recipient_alias AS recipient, o.user_id AS userId, o.text,
           a.display_name AS agentName, o.rendered_text AS renderedText, o.media_path AS mediaPath,
           o.dedupe_key AS dedupeKey, o.status, o.attempts,
           o.provider_message_id AS providerMessageId, o.last_error AS lastError,
           o.created_at AS createdAt, o.updated_at AS updatedAt, o.accepted_at AS acceptedAt
    FROM outbox o LEFT JOIN agents a ON a.id = o.agent_id WHERE o.id = ?
  `).get(id) || null
}

export function listMessages(db, limit = 20) {
  return db.prepare(`
    SELECT o.id, o.recipient_alias AS recipient, o.text, o.status, o.attempts,
           a.display_name AS agentName, o.media_path AS mediaPath,
           o.last_error AS lastError, o.created_at AS createdAt, o.updated_at AS updatedAt
    FROM outbox o LEFT JOIN agents a ON a.id = o.agent_id
    ORDER BY o.created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(200, Number(limit) || 20)))
}

export function queueCounts(db) {
  return Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all()
      .map((row) => [row.status, Number(row.count)]),
  )
}
