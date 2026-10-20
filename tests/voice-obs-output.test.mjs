import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoicePlaybackEngine } from '../src/features/voiceCommerce/VoicePlaybackEngine.ts'
const tick=()=>new Promise(done=>setImmediate(done))
const config=()=>({provider:'mimo',voiceRate:1,mimoVoice:'冰糖',mimoStyle:'',outputDeviceId:'default',pitchGapMs:0})

test('MiMo voice waits for OBS playback-complete acknowledgement',async()=>{
  const events=[]
  let resolvePlayback
  let calls=0
  const relay={
    enabled:()=>true,
    play:async()=>{calls++;return new Promise(done=>{resolvePlayback=done})},
    cancel:()=>{},
  }
  const engine=new VoicePlaybackEngine(config,
    async()=>({audioBase64:'mock',mimeType:'audio/wav'}),event=>events.push(event),relay)
  try{
    engine.enqueueReply('直播间答疑')
    await tick()
    assert.equal(calls,1)
    assert.equal(events.filter(x=>x.type==='ended').length,0)
    resolvePlayback()
    await tick()
    assert.equal(events.filter(x=>x.type==='ended').length,1)
  }finally{engine.dispose()}
})
test('emergency stop cancels OBS audio and ignores late completion',async()=>{
  const events=[]
  let cancels=0,finish
  const relay={
    enabled:()=>true,
    play:()=>new Promise(done=>{finish=done}),
    cancel:()=>{cancels++},
  }
  const engine=new VoicePlaybackEngine(config,
    async()=>({audioBase64:'mock',mimeType:'audio/wav'}),event=>events.push(event),relay)
  engine.enqueueReply('第一段')
  await tick()
  engine.stopAll()
  finish()
  await tick()
  assert.equal(cancels,1)
  assert.equal(events.filter(x=>x.type==='ended').length,0)
  engine.dispose()
})
