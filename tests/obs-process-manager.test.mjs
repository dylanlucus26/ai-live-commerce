import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ObsProcessManager } from '../electron/main/services/ObsProcessManager.ts'
const config={port:4455,password:''}
test('already connected OBS is reused without spawning a second process',async()=>{
  let launched=0,probed=0
  const m=new ObsProcessManager({
    probe:async()=>{probed++},launch:async()=>{launched++},
  })
  await m.ensureReady(config,1,0)
  assert.equal(probed,1)
  assert.equal(launched,0)
})
test('launches OBS once and waits for WebSocket readiness',async()=>{
  let launched=0,probes=0
  const m=new ObsProcessManager({
    probe:async()=>{probes++;if(probes<3)throw Error('connection refused')},
    launch:async()=>{launched++},
  })
  await m.ensureReady(config,4,1)
  assert.equal(launched,1)
  assert.equal(probes,3)
})
test('incorrect password fails without spawning a second OBS instance',async()=>{
  let launched=0
  const m=new ObsProcessManager({
    probe:async()=>{throw Error('OBS 密码错误')},launch:async()=>{launched++},
  })
  await assert.rejects(m.ensureReady(config,1,1),/密码错误/)
  assert.equal(launched,0)
})
