import assert from 'node:assert/strict'
import test from 'node:test'

import { codexInboundPrompt } from '../src/adapters/codex.js'

test('codex prompt preserves a consecutive message batch and one acknowledgement command', () => {
  const prompt = codexInboundPrompt({
    agentName: '悟空',
    messages: [
      { id: 'm1', text: '先做这个', media: [] },
      { id: 'm2', text: '再补一句', media: [{ kind: 'image', localPath: '/tmp/input.png' }] },
    ],
  })

  assert.match(prompt, /连续发送了 2 条消息/)
  assert.ok(prompt.indexOf('先做这个') < prompt.indexOf('再补一句'))
  assert.match(prompt, /inbox ack m1 m2 --agent 悟空/)
  assert.match(prompt, /image=\/tmp\/input\.png/)
})
