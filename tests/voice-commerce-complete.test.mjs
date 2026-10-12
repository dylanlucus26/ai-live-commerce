import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoicePlaybackEngine } from '../src/features/voiceCommerce/VoicePlaybackEngine.ts'
import { metricSummary } from '../src/features/voiceCommerce/metrics.ts'

test('cloned voice account id reaches synthesizer rather than default voice', async () => {
  let sent
  const engine = new VoicePlaybackEngine(
    () => ({ provider: 'mimo', voiceRate: 1, mimoVoice: '冰糖', mimoStyle: '自然',
      outputDeviceId: 'default', pitchGapMs: 0, cloneAccountId: 'test-account' }),
    async request => { sent = request; throw new Error('intentional mocked audio failure') },
    () => {},
  )
  engine.enqueueReply('欢迎来到直播间')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent.cloneAccountId, 'test-account')
  assert.equal(sent.text, '欢迎来到直播间')
  engine.dispose()
})

test('analytics distinguish platform accepted request from delivered message', () => {
  const e = (type, durationMs) => ({ id: type, at: Date.now(), type, durationMs })
  const stats = metricSummary([
    e('comment_received'),e('reply_generated', 230),e('text_attempted'),
    e('text_accepted'),e('voice_queued'),e('voice_played'),
  ])
  assert.equal(stats.received, 1)
  assert.equal(stats.avgReplyMs, 230)
  assert.equal(stats.textAccepted, 1)
  assert.equal(stats.textFailed, 0)
})
