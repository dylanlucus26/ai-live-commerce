import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveBroadcastController } from '../electron/main/services/LiveBroadcastController.ts'
const opts={accountId:'merchant',port:4455,password:'fake',mediaIds:['clip']}
function harness(){
  const calls=[]
  const p={accountId:null,previewing:false,visualReady:false,obsScene:null,error:null}
  const s={phase:'idle',accountId:null,obsStreaming:false,ownedByApp:false,startedAt:null,error:null}
  let failStream=false
  const preview={
    snapshot:()=>({...p}),
    start:async()=>{calls.push('prepare-media');p.accountId='merchant';p.previewing=true;p.visualReady=true;return {...p}},
    stop:async()=>{calls.push('restore-scene');p.previewing=false;p.visualReady=false;return {...p}},
  }
  const stream={
    snapshot:()=>({...s}),
    start:async()=>{calls.push('start-stream');if(failStream)throw new Error('OBS reject');s.obsStreaming=true;s.ownedByApp=true;return {...s}},
    stop:async()=>{calls.push('stop-stream');s.obsStreaming=false;s.ownedByApp=false;return {...s}},
  }
  return {controller:new LiveBroadcastController(preview,stream),calls,fail:()=>{failStream=true}}
}
test('single action starts visual output before OBS stream; stop reverses order',async()=>{
  const a=harness()
  assert.equal((await a.controller.start(opts)).phase,'streaming')
  assert.deepEqual(a.calls,['prepare-media','start-stream'])
  await a.controller.start(opts)
  assert.deepEqual(a.calls,['prepare-media','start-stream'])
  await assert.rejects(a.controller.stop('other'),/无法停止/)
  assert.equal((await a.controller.stop('merchant')).phase,'idle')
  assert.deepEqual(a.calls,['prepare-media','start-stream','stop-stream','restore-scene'])
})
test('stream refusal rolls back prepared OBS scene',async()=>{
  const a=harness();a.fail()
  await assert.rejects(a.controller.start(opts),/OBS reject/)
  assert.deepEqual(a.calls,['prepare-media','start-stream','restore-scene'])
  assert.equal(a.controller.snapshot().phase,'failed')
  assert.equal(a.controller.snapshot().obsStreaming,false)
})
