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
    refresh:async()=>({...s}),
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

test('loss of OBS output is visible as failure and stop still cleans managed preview',async()=>{
  const a=harness()
  await a.controller.start(opts)
  assert.equal((await a.controller.refresh()).phase,'streaming')
  // Exercise externally failed stream through a dedicated controllable transport.
  let active=false,visual=false
  const preview={snapshot:()=>({accountId:'merchant',previewing:visual,visualReady:visual,obsScene:'managed',error:null}),
    start:async()=>{visual=true;return {accountId:'merchant',previewing:true,visualReady:true,obsScene:'managed',error:null}},
    stop:async()=>{visual=false;return {accountId:null,previewing:false,visualReady:false,obsScene:null,error:null}}}
  const stream={snapshot:()=>({phase:'streaming',accountId:'merchant',obsStreaming:active,ownedByApp:active,startedAt:1,error:null}),
    start:async()=>{active=true;return {phase:'streaming',accountId:'merchant',obsStreaming:true,ownedByApp:true,startedAt:1,error:null}},
    refresh:async()=>({phase:'failed',accountId:'merchant',obsStreaming:active,ownedByApp:active,startedAt:1,error:active?null:'OBS 输出已经断开'}),
    stop:async()=>{active=false;return {phase:'idle',accountId:null,obsStreaming:false,ownedByApp:false,startedAt:null,error:null}}}
  const controller=new LiveBroadcastController(preview,stream)
  await controller.start(opts)
  active=false
  assert.equal((await controller.refresh()).phase,'failed')
  assert.match(controller.snapshot().error,/已经断开/)
  assert.equal((await controller.stop('merchant')).phase,'idle')
  assert.equal(visual,false)
})
