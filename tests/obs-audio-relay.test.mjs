import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ObsAudioRelay } from '../electron/main/services/ObsAudioRelay.ts'

function wav(){
  const buffer=Buffer.alloc(44)
  buffer.write('RIFF',0,'ascii')
  buffer.writeUInt32LE(36,4)
  buffer.write('WAVE',8,'ascii')
  buffer.write('fmt ',12,'ascii')
  buffer.writeUInt32LE(16,16)
  buffer.writeUInt16LE(1,20)
  buffer.writeUInt16LE(1,22)
  buffer.writeUInt32LE(24000,24)
  buffer.writeUInt32LE(48000,28)
  buffer.writeUInt16LE(2,32)
  buffer.writeUInt16LE(16,34)
  buffer.write('data',36,'ascii')
  return buffer.toString('base64')
}
test('OBS audio waits for Browser Source completion instead of assuming API call succeeded',async()=>{
  const relay=new ObsAudioRelay()
  const task=relay.play(wav())
  const id=relay.status().id
  assert.ok(id)
  assert.equal(relay.data(id).subarray(0,4).toString(),'RIFF')
  assert.equal(relay.complete('wrong',true),false)
  assert.equal(relay.complete(id,true),true)
  await task
  assert.equal(relay.status().id,null)
})
test('OBS audio stops on output errors and explicit emergency cancellation',async()=>{
  const relay=new ObsAudioRelay()
  const failed=relay.play(wav())
  const id=relay.status().id
  assert.ok(id)
  relay.complete(id,false)
  await assert.rejects(failed,/无法播放/)
  const cancelled=relay.play(wav())
  relay.cancel()
  await assert.rejects(cancelled,/已取消/)
  assert.equal(relay.status().id,null)
})
test('rejects malformed audio, overlap, and missing completion without leaking pending clips',async()=>{
  const relay=new ObsAudioRelay()
  await assert.rejects(relay.play('UklGRg=='),/有效的 WAV/)
  await assert.rejects(relay.play('not-base64'),/无效/)
  const pending=relay.play(wav(),1000)
  await assert.rejects(relay.play(wav()),/忙碌/)
  relay.cancel()
  await assert.rejects(pending,/已取消/)
  assert.equal(relay.data('missing'),null)
})
