import assert from 'node:assert/strict'
import test from 'node:test'

import { extractMedia, extractText, providerPackage } from '../src/provider.js'

test('provider dependency is pinned to the inspected protocol implementation', () => {
  assert.deepEqual(providerPackage(), { name: 'dsh-weixin-gateway', version: '0.5.13' })
})

test('inbound media models preserve kind and useful metadata', () => {
  assert.deepEqual(extractMedia({ item_list: [
    { type: 2, image_item: {} },
    { type: 3, voice_item: { text: '语音转写' } },
    { type: 4, file_item: { file_name: 'report.pdf' } },
    { type: 5, video_item: {} },
  ] }), [
    { kind: 'image', fileName: null, transcript: null },
    { kind: 'voice', fileName: null, transcript: '语音转写' },
    { kind: 'file', fileName: 'report.pdf', transcript: null },
    { kind: 'video', fileName: null, transcript: null },
  ])
})

test('inbound text extraction preserves item order', () => {
  assert.equal(extractText({ item_list: [
    { type: 1, text_item: { text: 'first' } },
    { type: 2, image_item: {} },
    { type: 1, text_item: { text: 'second' } },
  ] }), 'first\nsecond')
})
