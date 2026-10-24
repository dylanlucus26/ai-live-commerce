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

function toneWav(seconds=2,rate=24000){
  const count=Math.round(seconds*rate),samples=Buffer.alloc(44+count*2)
  samples.write('RIFF',0);samples.writeUInt32LE(samples.length-8,4)
  samples.write('WAVE',8);samples.write('fmt ',12)
  samples.writeUInt32LE(16,16);samples.writeUInt16LE(1,20)
  samples.writeUInt16LE(1,22);samples.writeUInt32LE(rate,24)
  samples.writeUInt32LE(rate*2,28);samples.writeUInt16LE(2,32)
  samples.writeUInt16LE(16,34);samples.write('data',36)
  samples.writeUInt32LE(count*2,40)
  for(let i=0;i<count;i++){
    const fade=Math.min(1,i/600,(count-i)/600)
    samples.writeInt16LE(Math.round(fade*11000*Math.sin(2*Math.PI*440*i/rate)),44+2*i)
  }
  return samples.toString('base64')
}

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
  let firstBytes=null,lastBytes=null
  const readings=[]
  for(let i=0;i<36;i++){
    const actual=await getObsStreamStatus(config)
    if(actual.reconnecting)reconnectSeen=true
    if(firstBytes===null && actual.outputBytes!==undefined)firstBytes=actual.outputBytes
    if(actual.outputBytes!==undefined)lastBytes=actual.outputBytes
    last=await broadcast.refresh()
    if(i%3===0 || last.phase==='failed'){
      const observation={second:i,active:actual.active,reconnecting:actual.reconnecting,
        bytes:actual.outputBytes,congestion:actual.congestion,phase:last.phase}
      readings.push(observation)
      console.log('RTMP receiver-lost transport:',JSON.stringify(observation))
    }
    if(last.phase==='failed'){
      failure={obs:actual,state:last}
      break
    }
    await snooze(1000)
  }
  console.log('RTMP receiver-lost bytes summary:',JSON.stringify({firstBytes,lastBytes,
    samples:readings}))
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

  // A fault is only fully recoverable when the SAME app controller can
  // start a *new* healthy stream without relaunching OBS or the Electron app.
  // The previous listener is dead. Start an isolated fresh receiver; never
  // reconnect to a remote service, and never inherit the old output session.
  receiver=spawn('ffmpeg',[
    '-nostdin','-hide_banner','-loglevel','warning','-listen','1',
    '-i','rtmp://127.0.0.1:1935/live/ci-validation-only',
    '-c','copy','-f','flv','-y',join(records,'receiver-recovered.flv'),
  ],{stdio:['ignore','ignore','pipe'],windowsHide:true})
  receiver.stderr.on('data',x=>{receiverLog=(receiverLog+String(x)).slice(-5000)})
  await snooze(1200)
  assert.equal(receiver.exitCode,null,'Recovered RTMP receiver could not bind: '+receiverLog)
  const restarted=await broadcast.start(options)
  assert.equal(restarted.phase,'streaming')
  assert.equal(restarted.obsStreaming,true)
  assert.equal(stream.snapshot().ownedByApp,true)
  await output.playAudio(toneWav())
  console.log('PASS recovered OBS Browser Source acknowledged 440Hz WAV playback')
  await snooze(4000)
  assert.equal((await broadcast.refresh()).phase,'streaming',
    'Recovered local RTMP receiver was not recognized as healthy')
  assert.equal((await getObsStreamStatus(config)).active,true)
  console.log('PASS restart from failed RTMP receiver without restarting OBS or app')
  assert.equal((await broadcast.stop(accountId)).phase,'idle')
  assert.equal((await getObsStreamStatus(config)).active,false)
  const afterRestart=await getObsSceneInfo(config)
  assert.deepEqual(afterRestart.scenes,before.scenes,
    'Repeated stream start/stop leaked a managed scene')
  assert.equal(afterRestart.currentScene,before.currentScene)
  // OBS state alone is insufficient: confirm that the *new* receiver actually
  // wrote decodable RTMP video after the session was restarted.
  for(let i=0;i<60&&receiver.exitCode===null;i++)await snooze(200)
  assert.notEqual(receiver.exitCode,null,
    'Recovered RTMP receiver did not finish after second StopStream: '+receiverLog)
  const recoveredFile=join(records,'receiver-recovered.flv')
  const probe=spawnSync('ffprobe',['-v','error','-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height',
    '-of','json',recoveredFile],{timeout:30000,encoding:'utf8'})
  if(probe.error||probe.status!==0)
    throw Error('Recovered RTMP recording unreadable: '+String(probe.stderr).slice(-1500))
  const media=JSON.parse(probe.stdout)
  const video=media.streams?.find(item=>item.codec_type==='video')
  assert.ok(video&&video.width>=320&&video.height>=240,
    'Recovered RTMP recording contains no decodable OBS video track')
  assert.ok(Number(media.format?.duration)>=3,
    'Recovered RTMP recording lacks 3 seconds of real streamed media')
  const audio=media.streams?.find(item=>item.codec_type==='audio')
  assert.ok(audio,'Recovered RTMP recording lost its OBS audio track')
  const samples=spawnSync('ffmpeg',['-loglevel','error','-i',recoveredFile,
    '-map','0:a:0','-ac','1','-ar','8000','-f','s16le','pipe:1'],
    {timeout:30000,maxBuffer:20*1024*1024})
  if(samples.error||samples.status!==0)
    throw Error('Recovered RTMP AAC audio undecodable: '+String(samples.stderr).slice(-1200))
  let peak=0,real=0,imag=0
  const pcm=samples.stdout,rate=8000,window=Math.min(8000,Math.floor(pcm.length/2))
  for(let i=0;i+1<pcm.length;i+=2)
    peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)))
  // A 440 Hz synthetic fixture was played into the *recovered* OBS browser.
  // Look for it in the actual second RTMP recording, not only in an IPC ack.
  let matchedTone=false
  for(let off=0;off+window*2<=pcm.length;off+=window*2){
    real=0;imag=0
    for(let i=0;i<window;i++){
      const v=pcm.readInt16LE(off+i*2)
      const angle=2*Math.PI*440*i/rate
      real+=v*Math.cos(angle);imag+=v*Math.sin(angle)
    }
    if(2*Math.hypot(real,imag)/window>250){matchedTone=true;break}
  }
  assert.ok(peak>300&&matchedTone,
    'Recovered RTMP recording did not contain non-silent injected 440Hz OBS audio')
  console.log('PASS recovered RTMP recorded real video AND synthetic OBS audio:',
    JSON.stringify({duration:media.format.duration,codec:video.codec_name,
      audio:audio.codec_name,audioPeak:peak}))
  console.log('PASS actual OBS RTMP recovery then repeat stop: original scene restored; no leaked assets')
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
