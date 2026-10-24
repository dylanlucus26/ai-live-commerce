import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { once } from 'node:events'
import { getObsStreamStatus, getObsSceneInfo, getObsStreamServiceInfo } from '../electron/main/services/ObsService.ts'
import { LiveOutputServer } from '../electron/main/services/LiveOutputServer.ts'
import { ManagedObsSceneController } from '../electron/main/services/ManagedObsSceneController.ts'
import { VisualPreviewController } from '../electron/main/services/VisualPreviewController.ts'
import { ObsStreamSession } from '../electron/main/services/ObsStreamSession.ts'
import { LiveBroadcastController } from '../electron/main/services/LiveBroadcastController.ts'

// Hard gate: this test kills only the CI runner's *own* OBS.exe process.
assert.equal(process.env.GITHUB_ACTIONS,'true','OBS crash simulation is CI-only')
assert.equal(process.platform,'win32','Dedicated OBS crash test only supports isolated Windows CI')
const originalPid=Number(process.env.AI_LIVE_OBS_TEST_PID)
assert.ok(Number.isSafeInteger(originalPid)&&originalPid>0,'Owned test OBS process PID required')
const obsBinary=join(process.env.ProgramFiles??'C:\\Program Files','obs-studio','bin','64bit','obs64.exe')
assert.ok(existsSync(obsBinary),'Official OBS executable missing')
const recordings=process.env.AI_LIVE_RTMP_RECORD_DIR
assert.ok(recordings,'Isolated RTMP recording directory required')
const config={port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD??''}
assert.ok(config.password,'CI OBS password missing')
const accountId='obs-crash-ci',opts={...config,accountId,mediaIds:['image']}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const folder=join(tmpdir(),'obs-crash-'+createHash('sha256').update(String(process.pid)).digest('hex').slice(0,12))
mkdirSync(folder,{recursive:true})
const image=join(folder,'fixture.png')
const ff=spawnSync('ffmpeg',['-loglevel','error','-y','-f','lavfi',
  '-i','color=c=yellow:s=640x360','-frames:v','1',image],{timeout:30000})
assert.equal(ff.status,0,'Cannot generate offline product image: '+String(ff.stderr))
const output=new LiveOutputServer((account,id)=>{
  if(account!==accountId||id!=='image')return null
  return {id,kind:'image',mime:'image/png',absolutePath:image,size:statSync(image).size}
})
const scene=new ManagedObsSceneController()
const preview=new VisualPreviewController(output,scene,getObsStreamStatus)
const stream=new ObsStreamSession()
const broadcast=new LiveBroadcastController(preview,stream)
let receiver=null,obsRestart=null
const original=await getObsSceneInfo(config)
let confirmedOriginalStreamWasStopped=false
try {
  assert.equal((await getObsStreamStatus(config)).active,false,'Do not crash existing external live stream')
  assert.equal((await getObsStreamServiceInfo(config)).configured,true,'CI-only local RTMP stream service missing')
  receiver=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','warning','-listen','1',
    '-i','rtmp://127.0.0.1:1935/live/ci-validation-only','-c','copy',
    '-f','flv','-y',join(recordings,'before-obs-crash.flv')],
  {stdio:['ignore','ignore','pipe'],windowsHide:true})
  await pause(1400)
  assert.equal(receiver.exitCode,null,'CI-owned RTMP listener exited before OBS crash')
  const started=await broadcast.start(opts)
  assert.equal(started.phase,'streaming')
  assert.equal((await getObsStreamStatus(config)).active,true)
  console.log('PASS CI-owned OBS/RTMP stream running before intentional OBS crash')

  process.kill(originalPid,'SIGKILL')
  let unreachable=false
  for(let i=0;i<30;i++){
    try {await getObsStreamStatus(config)}catch{unreachable=true;break}
    await pause(300)
  }
  assert.equal(unreachable,true,'Test OBS process did not actually crash or close its WebSocket')
  console.log('PASS CI-owned OBS process terminated; WebSocket no longer responds')
  const fail=await broadcast.refresh()
  assert.equal(fail.phase,'failed')
  assert.match(fail.error??'',/OBS|连接|断开|超时|网络/)
  assert.equal(stream.snapshot().ownedByApp,true,
    'Do not discard proof of owned stream before operator can clean up')
  await assert.rejects(broadcast.stop(accountId))
  assert.equal(broadcast.snapshot().phase,'failed')
  console.log('PASS crash detected; safe stop refused while OBS unavailable; ownership retained')

  if(receiver.exitCode===null){
    receiver.kill('SIGKILL')
    for(let i=0;i<50&&receiver.exitCode===null;i++)await pause(100)
  }
  receiver=null
  await pause(1000)

  obsRestart=spawn(obsBinary,['--multi','--disable-updater','--disable-missing-files-check',
    '--profile','AI-Live-CI','--collection','AI-Live-CI',
    '--websocket_port','4455','--websocket_password',config.password,
    '--websocket_ipv4_only'],{
      cwd:dirname(obsBinary),stdio:['ignore','ignore','pipe'],windowsHide:true,
    })
  let ready=false
  for(let i=0;i<85;i++){
    try{
      const status=await getObsStreamStatus(config)
      if(!status.active){ready=true;break}
    }catch{}
    await pause(350)
  }
  assert.equal(ready,true,'New official OBS instance failed to come up after crash')
  console.log('PASS official OBS restarted independently and WebSocket became ready')

  // The abandoned owner can now be released because this new OBS instance has
  // confirmed *idle*. It must not accidentally kill a stream of another user.
  const idle=await broadcast.stop(accountId)
  assert.equal(idle.phase,'idle')
  confirmedOriginalStreamWasStopped=true
  assert.deepEqual((await getObsSceneInfo(config)).scenes,original.scenes)
  console.log('PASS stale managed session and preview cleaned after OBS restart')

  receiver=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','warning','-listen','1',
    '-i','rtmp://127.0.0.1:1935/live/ci-validation-only','-c','copy',
    '-f','flv','-y',join(recordings,'after-obs-crash-restart.flv')],
  {stdio:['ignore','ignore','pipe'],windowsHide:true})
  await pause(1400)
  assert.equal(receiver.exitCode,null,'Recovery RTMP receiver failed to start')
  const restarted=await broadcast.start(opts)
  assert.equal(restarted.phase,'streaming')
  await pause(4500)
  assert.equal((await broadcast.refresh()).phase,'streaming')
  assert.equal((await broadcast.stop(accountId)).phase,'idle')
  assert.deepEqual((await getObsSceneInfo(config)).scenes,original.scenes)
  for(let i=0;i<60&&receiver.exitCode===null;i++)await pause(150)
  assert.notEqual(receiver.exitCode,null,'FFmpeg did not finalize recovered OBS crash FLV')
  const media=spawnSync('ffprobe',['-v','error','-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height','-of','json',
    join(recordings,'after-obs-crash-restart.flv')],{encoding:'utf8',timeout:30000})
  assert.equal(media.status,0,'OBS crash recovery RTMP file unreadable: '+media.stderr)
  const decoded=JSON.parse(media.stdout)
  assert.ok(Number(decoded.format?.duration)>=3,'Recovered stream recorded fewer than 3 seconds')
  const track=decoded.streams?.find(x=>x.codec_type==='video')
  assert.ok(track&&track.width>=320,'Recovered stream lacks a real video track')
  console.log('PASS OBS process crash -> safe stop -> OBS restart -> fresh RTMP H264 video:',
    JSON.stringify({duration:decoded.format.duration,video:track.codec_name}))
}catch(error){
  console.error('REAL OBS PROCESS CRASH TEST FAILED:',error)
  process.exitCode=1
}finally{
  if(receiver?.exitCode===null){
    receiver.kill('SIGKILL')
    for(let i=0;i<35&&receiver.exitCode===null;i++)await pause(100)
  }
  if(obsRestart&&obsRestart.exitCode===null){
    // Keep the restarted OBS up until any owner cleanup is attempted.
    if(!confirmedOriginalStreamWasStopped){
      try{await broadcast.stop(accountId)}catch{}
    }
    obsRestart.kill('SIGKILL')
  }
  await output.stop()
  rmSync(folder,{recursive:true,force:true})
}
