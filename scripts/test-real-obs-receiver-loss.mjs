import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'

import { LiveOutputServer } from '../electron/main/services/LiveOutputServer.ts'
import { ManagedObsSceneController } from '../electron/main/services/ManagedObsSceneController.ts'
import { VisualPreviewController } from '../electron/main/services/VisualPreviewController.ts'
import { ObsStreamSession } from '../electron/main/services/ObsStreamSession.ts'
import { LiveBroadcastController } from '../electron/main/services/LiveBroadcastController.ts'
import { getObsStreamStatus, getObsStreamServiceInfo, getObsSceneInfo } from '../electron/main/services/ObsService.ts'

// Intentional fault injection only on isolated GitHub Actions runner.
// We kill ONLY this test's local FFmpeg RTMP receiver (never real Douyin or OBS).
assert.equal(process.env.GITHUB_ACTIONS,'true','RTMP fault injection is restricted to disposable CI runners')
const config={port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD??''}
const accountId='fault-ci'
const dir=mkdtempSync(join(tmpdir(),'ai-real-obs-loss-'))
const image=join(dir,'green.png')
const records=process.env.AI_LIVE_RTMP_RECORD_DIR
assert.ok(records&&config.password,'Missing isolated OBS / RTMP environment')
mkdirSync(records,{recursive:true})
const snooze=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function ff(exe,args){
  const res=spawnSync(exe,args,{timeout:60000})
  if(res.error||res.status!==0)
    throw Error('Failed to generate offline image fixture: '+String(res.stderr).slice(-1400))
}
ff('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i',
  'color=c=green:s=640x360','-frames:v','1',image])

const output=new LiveOutputServer((account,id)=>{
  if(account!==accountId||id!=='product')return null
  const st=statSync(image)
  return {id,kind:'image',mime:'image/png',absolutePath:image,size:st.size}
})
const preview=new VisualPreviewController(output,new ManagedObsSceneController(),getObsStreamStatus)
const stream=new ObsStreamSession()
const broadcast=new LiveBroadcastController(preview,stream)
const before=await getObsSceneInfo(config)
const options={...config,accountId,mediaIds:['product']}
let receiver
let receiverLog=''
try{
  const initial=await getObsStreamStatus(config)
  assert.equal(initial.active,false,'Cannot inject faults while another OBS stream is running')
  assert.equal((await getObsStreamServiceInfo(config)).configured,true,
    'CI-only OBS RTMP stream service must already be configured')

  receiver=spawn('ffmpeg',[
    '-nostdin','-hide_banner','-loglevel','warning','-listen','1',
    '-i','rtmp://127.0.0.1:1935/live/ci-validation-only',
    '-c','copy','-f','flv','-y',join(records,'receiver-loss.flv'),
  ],{stdio:['ignore','ignore','pipe'],windowsHide:true})
  receiver.stderr.on('data',x=>{
    receiverLog=(receiverLog+String(x)).slice(-5000)
  })
  await snooze(1200)
  assert.equal(receiver.exitCode,null,'Test RTMP listener exited early: '+receiverLog)

  assert.equal((await broadcast.start(options)).phase,'streaming')
  assert.equal((await getObsStreamStatus(config)).active,true,
    'Real OBS never reached active RTMP output before failure')
  await assert.rejects(broadcast.stop('other-account'),/无法停止其他账号/)
  assert.equal((await getObsStreamStatus(config)).active,true,
    'Unauthorized stop changed the actual OBS output')

  console.log('ACTUAL OBS STREAM READY; terminating only this test RTMP receiver')
  const killed=receiver.kill('SIGKILL')
  assert.equal(killed,true,'Cannot terminate test-controlled RTMP receiver')
  await Promise.race([
    once(receiver,'exit'),
    snooze(9000).then(()=>{throw Error('RTMP receiver process never terminated')}),
  ])
  receiver=null

  let failure=null,last=null,reconnectSeen=false
  for(let i=0;i<44;i++){
    const actual=await getObsStreamStatus(config)
    if(actual.reconnecting)reconnectSeen=true
    last=await broadcast.refresh()
    if(last.phase==='failed'){
      failure={obs:actual,state:last}
      break
    }
    await snooze(350)
  }
  assert.ok(failure,'RTMP receiver disappeared but managed broadcast stayed healthy: '+JSON.stringify(last))
  assert.match(failure.state.error??'',/重连|中断|断开|OBS|RTMP/u)
  console.log('PASS actual OBS receiver loss detected:',
    JSON.stringify({reconnectSeen,obs:failure.obs,phase:failure.state.phase,
      ownedByApp:stream.snapshot().ownedByApp}))

  // A connected OBS that is attempting to reconnect must still be stopped by
  // the account that started it. Never acquire or stop someone else's stream.
  const stopped=await broadcast.stop(accountId)
  assert.equal(stopped.phase,'idle')
  assert.equal((await getObsStreamStatus(config)).active,false)
  const finalScene=await getObsSceneInfo(config)
  assert.equal(finalScene.currentScene,before.currentScene)
  assert.deepEqual(finalScene.scenes,before.scenes)
  console.log('PASS real OBS RTMP failure recovery: owner stop, restored scene, no leaked sources')
}catch(error){
  console.error('REAL OBS RECEIVER LOSS TEST FAILED:',error)
  process.exitCode=1
}finally{
  if(receiver?.exitCode===null){
    receiver.kill('SIGKILL')
    await Promise.race([once(receiver,'exit').catch(()=>{}),snooze(5000)])
  }
  if(broadcast.snapshot().phase!=='idle'||preview.snapshot().previewing||stream.snapshot().ownedByApp){
    try{await broadcast.stop(accountId)}catch(error){console.error('Fault-test OBS cleanup:',error)}
  }
  await output.stop()
  rmSync(dir,{recursive:true,force:true})
}
