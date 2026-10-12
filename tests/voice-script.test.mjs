import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendBounded, makePitchPlaylist, splitSpeechText } from '../src/features/voiceCommerce/voiceScript.ts'

test('splits long TTS segments while preserving text', () => {
  const source = '开播欢迎。' + '纯棉材质亲肤舒适。'.repeat(50)
  const chunks = splitSpeechText(source, 80)
  assert.ok(chunks.length >= 5)
  assert.ok(chunks.every(x => [...x].length <= 80))
  assert.equal(chunks.join(''), source)
})

test('does not invent product prices or stock in pitch lines', () => {
  const playlist = makePitchPlaylist({ id: 'a', name: '演示衣服', price: '', stock: '', highlights: '纯棉', faq: '' })
  assert.match(playlist.join(''), /纯棉/)
  assert.doesNotMatch(playlist.join(''), /[0-9]+元/)
  assert.deepEqual(makePitchPlaylist({ id:'1', name:'', price:'', stock:'', highlights:'', faq:'' }), [])
})

test('bounded queue discards stale replies', () => {
  const q = appendBounded(['旧消息1','旧消息2'], '最新消息', 2)
  assert.deepEqual(q, ['旧消息2', '最新消息'])
})
