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
    const [message] = database.listAgentInbox(db, '悟空', { status: 'unread' })
    assert.equal(message.text, '继续处理')
    assert.equal(message.deliveryStatus, 'dispatched')
    assert.equal(database.acknowledgeAgentMessage(db, '悟空', 'm2').status, 'acknowledged')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('outbound send atomically yields pending inbox before enqueueing', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-send-barrier`)
  const db = database.openDatabase()
  try {
    database.upsertRecipient(db, {
      alias: 'hang', userId: 'wx-user', accountId: 'bot', contextToken: 'ctx',
    })
    const agent = database.registerAgent(db, {
      name: '悟空', description: '处理微信请求', adapter: 'codex', adapterTarget: 'thread-id',
    })
    database.recordInbound(db, {
      id: 'm3', accountId: 'bot', userId: 'hang', text: '@悟空 先看这条', contextToken: 'ctx',
    })
    database.markAgentMessageDispatched(db, agent.id, 'm3')

    const blocked = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentName: '悟空', text: '旧回复', dedupeKey: 'reply-m3',
    })
    assert.equal(blocked.status, 'inbox_pending')
    assert.equal(blocked.blocked, true)
    assert.equal(blocked.inbox[0].text, '先看这条')
    assert.equal(database.listMessages(db).length, 0)

    database.acknowledgeAgentMessage(db, '悟空', 'm3')
    const queued = database.enqueueMessage(db, {
      recipientAlias: 'hang', agentName: '悟空', text: '新回复', dedupeKey: 'reply-m3',
    })
    assert.equal(queued.status, 'queued')
    assert.equal(database.listMessages(db).length, 1)
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('codex adapter claims and acknowledges consecutive messages as one batch', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-codex-batch`)
  const db = database.openDatabase()
  try {
    database.registerAgent(db, {
      name: '悟空', description: '处理微信请求', adapter: 'codex', adapterTarget: 'thread-id',
    })
    for (const [id, text] of [['m4', '第一条'], ['m5', '第二条']]) {
      database.recordInbound(db, {
        id, accountId: 'bot', userId: 'hang', text: `@悟空 ${text}`, contextToken: 'ctx',
      })
    }

    const batch = database.claimNextCodexBatch(db, new Date(Date.now() + 1000).toISOString())
    assert.equal(batch.agentName, '悟空')
    assert.equal(batch.threadId, 'thread-id')
    assert.deepEqual(batch.messages.map(({ id, text }) => ({ id, text })), [
      { id: 'm4', text: '第一条' },
      { id: 'm5', text: '第二条' },
    ])
    database.markAgentMessagesDispatched(db, batch.id, ['m4', 'm5'])
    assert.deepEqual(
      database.listAgentInbox(db, '悟空').map(({ status, deliveryStatus }) => ({ status, deliveryStatus })),
      [
        { status: 'unread', deliveryStatus: 'dispatched' },
        { status: 'unread', deliveryStatus: 'dispatched' },
      ],
    )
    assert.deepEqual(database.acknowledgeAgentMessages(db, '悟空', ['m4', 'm5']), {
      ids: ['m4', 'm5'], agentName: '悟空', status: 'acknowledged', count: 2,
    })
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('batch acknowledgement is all-or-nothing', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-ack-batch`)
  const db = database.openDatabase()
  try {
    database.registerAgent(db, { name: '悟空', description: '处理微信请求' })
    database.recordInbound(db, {
      id: 'm6', accountId: 'bot', userId: 'hang', text: '@悟空 保留未读', contextToken: 'ctx',
    })
    assert.throws(
      () => database.acknowledgeAgentMessages(db, '悟空', ['m6', 'missing']),
      /本次未确认任何消息/,
    )
    assert.equal(database.listAgentInbox(db, '悟空')[0].status, 'unread')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('acknowledged messages are never replayed to the codex adapter', async () => {
  const home = isolatedHome()
  const database = await import(`../src/database.js?test=${Date.now()}-no-replay`)
  const db = database.openDatabase()
  try {
    database.registerAgent(db, {
      name: '悟空', description: '处理微信请求', adapter: 'codex', adapterTarget: 'thread-id',
    })
    database.recordInbound(db, {
      id: 'm7', accountId: 'bot', userId: 'hang', text: '@悟空 已处理', contextToken: 'ctx',
    })
    database.acknowledgeAgentMessage(db, '悟空', 'm7')
    assert.equal(
      database.claimNextCodexBatch(db, new Date(Date.now() + 1000).toISOString()),
      null,
    )
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
