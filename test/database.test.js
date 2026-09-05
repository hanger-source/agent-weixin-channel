import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-weixin-channel-test-'))
  process.env.AGENT_WEIXIN_CHANNEL_HOME = home
  return home
}

test('durable outbox deduplicates agent retries', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, {
      alias: 'hang', userId: 'wx-user', accountId: 'bot', contextToken: 'ctx',
    })
    database.registerAgent(db, { id: 'release', displayName: '发布 Agent' })
    const first = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentId: 'release', text: 'done', dedupeKey: 'task-1',
    })
    const second = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentId: 'release', text: 'done again', dedupeKey: 'task-1',
    })
    assert.equal(second.id, first.id)
    assert.equal(second.deduplicated, true)
    assert.equal(database.listMessages(db).length, 1)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('send requires an observed context token', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-context`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, { alias: 'hang', userId: 'wx-user', accountId: 'bot' })
    database.registerAgent(db, { id: 'release', displayName: '发布 Agent' })
    assert.throws(
      () => database.enqueueMessage(db, { recipientAlias: 'hang', agentId: 'release', text: 'hello' }),
      /尚未建立可发送会话/,
    )
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('interrupted sending returns to the durable queue', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-restart`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, {
      alias: 'hang', userId: 'wx-user', accountId: 'bot', contextToken: 'ctx',
    })
    database.registerAgent(db, { id: 'release', displayName: '发布 Agent' })
    const queued = database.enqueueMessage(db, { recipientAlias: 'hang', agentId: 'release', text: 'hello' })
    assert.equal(database.claimNextMessage(db).id, queued.id)
    assert.equal(database.getMessage(db, queued.id).status, 'sending')
    database.resetInterruptedMessages(db)
    assert.equal(database.getMessage(db, queued.id).status, 'queued')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('recipient alias changes preserve queued message references', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-alias`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, {
      alias: 'owner', userId: 'wx-user', accountId: 'bot', contextToken: 'ctx',
    })
    database.registerAgent(db, { id: 'release', displayName: '发布 Agent' })
    const queued = database.enqueueMessage(db, { recipientAlias: 'owner', agentId: 'release', text: 'hello' })
    database.renameRecipient(db, 'wx-user', 'hang')
    assert.equal(database.getMessage(db, queued.id).recipient, 'hang')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('agent identity formats outbound display without collapsing routing identity', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-identity`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, {
      alias: 'hang', userId: 'wx-user', accountId: 'bot', contextToken: 'ctx',
    })
    database.registerAgent(db, { id: 'release', displayName: '发布 Agent' })
    assert.throws(
      () => database.registerAgent(db, { id: 'release', displayName: '另一个 Agent' }),
      /已由.*注册/,
    )
    const queued = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentId: 'release', text: '完成', mediaPath: '/tmp/report.pdf',
    })
    assert.deepEqual(
      { agentId: database.getMessage(db, queued.id).agentId, renderedText: database.getMessage(db, queued.id).renderedText },
      { agentId: 'release', renderedText: '【发布 Agent】完成' },
    )
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('explicit @agent route is isolated and requires claim then ack', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-routing`)
  const db = database.openDatabase()
  try {
    database.registerAgent(db, { id: 'release', displayName: '发布 Agent' })
    database.registerAgent(db, { id: 'review', displayName: '审阅 Agent' })
    const routed = database.recordInbound(db, {
      id: 'm1', accountId: 'bot', userId: 'hang', text: '@release：可以发布', contextToken: 'ctx',
    })
    assert.deepEqual(routed, { routeKey: 'release', routed: true })
    assert.equal(database.listAgentInbox(db, 'review').length, 0)
    const claimed = database.claimAgentMessage(db, 'release')
    assert.equal(claimed.text, '可以发布')
    assert.equal(claimed.status, 'claimed')
    assert.deepEqual(database.acknowledgeAgentMessage(db, 'release', 'm1'), {
      id: 'm1', agentId: 'release', status: 'acknowledged',
    })
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('host adapter delivery has an explicit dispatched state', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-adapter`)
  const db = database.openDatabase()
  try {
    database.registerAgent(db, {
      id: 'codex-task', displayName: 'Codex Task', adapter: 'codex', adapterTarget: 'thread-id',
    })
    database.recordInbound(db, {
      id: 'm2', accountId: 'bot', userId: 'hang', text: '@codex-task 继续处理', contextToken: 'ctx',
    })
    database.markAgentMessageDispatched(db, 'codex-task', 'm2')
    assert.equal(database.listAgentInbox(db, 'codex-task', { status: 'dispatched' })[0].text, '继续处理')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
