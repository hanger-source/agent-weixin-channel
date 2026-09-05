import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-channel-test-'))
  process.env.WEIXIN_CHANNEL_HOME = home
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
    const first = database.enqueueMessage(db, {
      recipientAlias: 'hang', text: 'done', source: 'agent', dedupeKey: 'task-1',
    })
    const second = database.enqueueMessage(db, {
      recipientAlias: 'hang', text: 'done again', source: 'agent', dedupeKey: 'task-1',
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
    assert.throws(
      () => database.enqueueMessage(db, { recipientAlias: 'hang', text: 'hello' }),
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
    const queued = database.enqueueMessage(db, { recipientAlias: 'hang', text: 'hello' })
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
    const queued = database.enqueueMessage(db, { recipientAlias: 'owner', text: 'hello' })
    database.renameRecipient(db, 'wx-user', 'hang')
    assert.equal(database.getMessage(db, queued.id).recipient, 'hang')
  } finally {
    db.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
