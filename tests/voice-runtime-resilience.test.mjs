import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoicePlaybackEngine } from '../src/features/voiceCommerce/VoicePlaybackEngine.ts'

const flush = () => new Promise(resolve => setImmediate(resolve))
const config = (provider = 'mimo') => ({
  provider, voiceRate: 1, mimoVoice: '冰糖', mimoStyle: '专业但不夸大',
  outputDeviceId: 'default', pitchGapMs: 0,
})
const sampleAudio = { audioBase64: Buffer.from('RIFF').toString('base64'), mimeType: 'audio/wav' }
const recording = 'app-media://library/' + 'a'.repeat(32) + '/approved-recording'

test('MiMo failure halts current pitch AND pending recording; no audio continues after error', async () => {
  const events = []
  let requests = 0
  const engine = new VoicePlaybackEngine(
    () => config(),
    async () => { requests++; throw new Error('MiMo 401 unauthorized') },
    event => events.push(event),
  )
  try {
    engine.startPitch(['商品讲解开始'])
    engine.enqueueRecording(recording)
    await flush()
    await flush()
    assert.equal(requests, 1, 'one failed API request only')
    assert.deepEqual(events.filter(e => e.type === 'error').map(e => e.detail), ['MiMo 401 unauthorized'])
    assert.equal(events.filter(e => e.type === 'playing' && e.kind === 'recording').length, 0,
      'a failed voice engine must not silently continue playing queued recordings')
  } finally {
    engine.dispose()
  }
})

test('urgent stop ignores delayed MiMo response without starting audio or emitting completion', async () => {
  const events = []
  let resolve
  const engine = new VoicePlaybackEngine(
    () => config(),
    () => new Promise(done => { resolve = done }),
    event => events.push(event),
  )
  engine.enqueueReply('等待 MiMo 接口')
  assert.equal(typeof resolve, 'function')
  engine.stopAll()
  resolve(sampleAudio)
  await flush()
  await flush()
  assert.ok(events.some(e => e.type === 'stopped'))
  assert.equal(events.filter(e => e.type === 'ended').length, 0)
  assert.equal(events.filter(e => e.type === 'error').length, 0)
  engine.dispose()
})

test('20 rapid replies keep only newest 8 pending while first audio is processing', async () => {
  const oldAudio = globalThis.Audio
  const requests = []
  const events = []
  let resolveFirst
  class FakeAudio {
    constructor() { this.onended = null; this.onerror = null; this.currentTime = 0 }
    async play() { setImmediate(() => this.onended?.()); return true }
    pause() {}
  }
  globalThis.Audio = FakeAudio
  const engine = new VoicePlaybackEngine(
    () => config(),
    ({text}) => {
      requests.push(text)
      if (text === '第一条回复') return new Promise(done => { resolveFirst = done })
      return Promise.resolve(sampleAudio)
    },
    event => events.push(event),
  )
  try {
    engine.enqueueReply('第一条回复')
    for (let i = 1; i <= 20; i++) engine.enqueueReply('第' + i + '条回复')
    resolveFirst(sampleAudio)
    const started = Date.now()
    while (events.filter(e => e.type === 'ended').length < 9 && Date.now() - started < 5000)
      await flush()
    assert.equal(events.filter(e => e.type === 'ended').length, 9)
    assert.equal(requests.length, 9, 'active first + bounded queue of 8')
    assert.equal(requests[0], '第一条回复')
    assert.deepEqual(requests.slice(1), Array.from({length:8}, (_,i)=>'第' + (i+13) + '条回复'))
  } finally {
    engine.dispose()
    globalThis.Audio = oldAudio
  }
})

test('invalid media URLs cannot enter playback queue', async () => {
  const events = []
  const engine = new VoicePlaybackEngine(() => config('system'), async () => sampleAudio, e => events.push(e))
  try {
    engine.enqueueRecording('https://outside.example/exfiltration.mp3')
    engine.enqueueRecording('file:///etc/passwd')
    engine.enqueueReply('')
    await flush()
    assert.equal(events.some(e => e.type === 'playing'), false)
  } finally {
    engine.dispose()
  }
})
