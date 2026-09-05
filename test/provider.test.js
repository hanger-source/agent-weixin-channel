import assert from 'node:assert/strict'
import test from 'node:test'

import { extractText, providerPackage } from '../src/provider.js'

test('provider dependency is pinned to the inspected protocol implementation', () => {
  assert.deepEqual(providerPackage(), { name: 'dsh-weixin-gateway', version: '0.5.13' })
})

test('inbound text extraction preserves item order', () => {
  assert.equal(extractText({ item_list: [
    { type: 1, text_item: { text: 'first' } },
    { type: 2, image_item: {} },
    { type: 1, text_item: { text: 'second' } },
  ] }), 'first\nsecond')
})
