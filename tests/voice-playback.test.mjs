import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoicePlaybackEngine } from '../src/features/voiceCommerce/VoicePlaybackEngine.ts'

test('comment audio interrupts pitch and resumes only after replies', async () => {
  const utterances = []
  let cancels = 0
  const notifications = []
  const originalWindow = globalThis.window
  const originalUtterance = globalThis.SpeechSynthesisUtterance
  try {
    globalThis.SpeechSynthesisUtterance = class {
      constructor(text) { this.text = text }
    }
    globalThis.window = {
      speechSynthesis: {
        speak(utterance) { utterances.push(utterance) },
        cancel() { cancels++ },
      },
    }
    const engine = new VoicePlaybackEngine(
      () => ({ provider:'system', voiceRate:1, mimoVoice:'冰糖', mimoStyle:'', outputDeviceId:'default', pitchGapMs:0 }),
      async () => { throw new Error('MiMo should not be used') },
      message => notifications.push(message),
    )
    engine.startPitch(['第一条商品讲解', '第二条商品讲解'])
    assert.equal(utterances.at(-1).text, '第一条商品讲解')
    engine.enqueueReply('观众问尺码')
    assert.equal(cancels, 1, 'pitch should stop when new reply arrives')
    assert.equal(utterances.at(-1).text, '观众问尺码')
    engine.enqueueReply('观众问价格')
    utterances.at(-1).onend()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(utterances.at(-1).text, '观众问价格')
    utterances.at(-1).onend()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(utterances.at(-1).text, '第一条商品讲解', 'resume interrupted pitch at its original segment')
    engine.stopAll()
    assert.ok(cancels >= 2)
    assert.ok(notifications.some(m => m.type === 'stopped'))
  } finally {
    globalThis.window = originalWindow
    globalThis.SpeechSynthesisUtterance = originalUtterance
  }
})
