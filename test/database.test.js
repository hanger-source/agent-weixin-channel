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
    database.registerAgent(db, { name: '悟空', description: '发布当前版本' })
    const first = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentName: '悟空', text: 'done', dedupeKey: 'task-1',
    })
    const second = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentName: '悟空', text: 'done again', dedupeKey: 'task-1',
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
    database.registerAgent(db, { name: '悟空', description: '发布当前版本' })
    assert.throws(
      () => database.enqueueMessage(db, { recipientAlias: 'hang', agentName: '悟空', text: 'hello' }),
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
    database.registerAgent(db, { name: '悟空', description: '发布当前版本' })
    const queued = database.enqueueMessage(db, { recipientAlias: 'hang', agentName: '悟空', text: 'hello' })
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
    database.registerAgent(db, { name: '悟空', description: '发布当前版本' })
    const queued = database.enqueueMessage(db, { recipientAlias: 'owner', agentName: '悟空', text: 'hello' })
    database.renameRecipient(db, 'wx-user', 'hang')
    assert.equal(database.getMessage(db, queued.id).recipient, 'hang')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('one public agent name aligns routing and outbound display', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-identity`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, {
      alias: 'hang', userId: 'wx-user', accountId: 'bot', contextToken: 'ctx',
    })
    database.registerAgent(db, { name: '悟空', description: '发布当前版本' })
    assert.throws(
      () => database.registerAgent(db, { name: '悟空', description: '审阅当前版本' }),
      /已绑定其他宿主/,
    )
    const queued = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentName: '悟空', text: '完成', mediaPath: '/tmp/report.pdf',
    })
    assert.deepEqual(
      { agentName: database.getMessage(db, queued.id).agentName, renderedText: database.getMessage(db, queued.id).renderedText },
      { agentName: '悟空', renderedText: '【悟空】\n发布当前版本\n完成' },
    )
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('agent name is exactly two Han characters and description is one line', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-name`)
  const db = database.openDatabase()
  try {
    assert.throws(
      () => database.registerAgent(db, { name: '李寻欢', description: '处理消息' }),
      /恰好是两个汉字/,
    )
    assert.throws(
      () => database.registerAgent(db, { name: '悟空', description: '第一行\n第二行' }),
      /单行文本/,
    )
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('explicit two-Han-character route is isolated and requires claim then ack', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-routing`)
  const db = database.openDatabase()
  try {
    database.registerAgent(db, { name: '悟空', description: '发布当前版本' })
    database.registerAgent(db, { name: '黛玉', description: '审阅当前版本' })
    const routed = database.recordInbound(db, {
      id: 'm1', accountId: 'bot', userId: 'hang', text: '@悟空：可以发布', contextToken: 'ctx',
    })
    assert.equal(routed.routeName, '悟空')
    assert.equal(routed.body, '可以发布')
    assert.equal(routed.routed, true)
    assert.equal(database.listAgentInbox(db, '黛玉').length, 0)
    const claimed = database.claimAgentMessage(db, '悟空')
    assert.equal(claimed.text, '可以发布')
    assert.equal(claimed.status, 'claimed')
    assert.deepEqual(database.acknowledgeAgentMessage(db, '悟空', 'm1'), {
      id: 'm1', agentName: '悟空', status: 'acknowledged',
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
    const agent = database.registerAgent(db, {
      name: '悟空', description: '处理微信请求', adapter: 'codex', adapterTarget: 'thread-id',
    })
    database.recordInbound(db, {
      id: 'm2', accountId: 'bot', userId: 'hang', text: '@悟空 继续处理', contextToken: 'ctx',
    })
    database.markAgentMessageDispatched(db, agent.id, 'm2')
    assert.equal(database.listAgentInbox(db, '悟空', { status: 'dispatched' })[0].text, '继续处理')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
