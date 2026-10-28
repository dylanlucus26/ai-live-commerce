import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,statSync,writeFileSync} from 'node:fs'
import {tmpdir,cpus} from 'node:os'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import WebSocket from 'ws'
import {obsAuthentication,getObsStreamStatus,getObsSceneInfo} from '../electron/main/services/ObsService.ts'
import {LiveOutputServer} from '../electron/main/services/LiveOutputServer.ts'
import {ManagedObsSceneController} from '../electron/main/services/ManagedObsSceneController.ts'
import {VisualPreviewController} from '../electron/main/services/VisualPreviewController.ts'
import {ObsStreamSession} from '../electron/main/services/ObsStreamSession.ts'
import {LiveBroadcastController} from '../electron/main/services/LiveBroadcastController.ts'
import {toneWav,validateRtmpCapture} from './validate-real-rtmp.mjs'

// Diagnostic comparison only: no new acceptance threshold or product tuning.
assert.equal(process.env.GITHUB_ACTIONS,'true','Render diagnostic is isolated-cloud only')
assert.equal(process.platform,'darwin','Render diagnostic requires a cloud Mac')
const config={port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD??''}
const logDir=process.env.AI_LIVE_OBS_LOG_DIR
const records=process.env.AI_LIVE_RTMP_RECORD_DIR
assert.ok(config.password&&logDir&&records,'Missing CI-owned OBS environment')
mkdirSync(records,{recursive:true})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function obs(requestType,requestData={}){
  const requestId=randomUUID()
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:'+config.port,{handshakeTimeout:4000})
    let done=false
    const deadline=setTimeout(()=>finish(new Error('OBS request timeout: '+requestType)),12000)
    const finish=(error,value)=>{
      if(done)return
      done=true;clearTimeout(deadline)
      ws.close()
      if(error)reject(error)
      else resolve(value??{})
    }
    ws.on('message',raw=>{
      try{
        const packet=JSON.parse(String(raw)),d=packet.d??{}
        if(packet.op===0){
          const id={rpcVersion:1}
          if(d.authentication)id.authentication=obsAuthentication(config.password,
            d.authentication.challenge,d.authentication.salt)
          ws.send(JSON.stringify({op:1,d:id}))
        }else if(packet.op===2)
          ws.send(JSON.stringify({op:6,d:{requestType,requestId,requestData}}))
        else if(packet.op===7&&d.requestId===requestId){
          if(!d.requestStatus?.result)
            throw Error('OBS '+requestType+' rejected: '+d.requestStatus?.code+' '+d.requestStatus?.comment)
          finish(null,d.responseData)
        }
      }catch(e){finish(e)}
    })
    ws.on('error',e=>finish(e))
    ws.on('close',()=>{if(!done)finish(Error('OBS socket closed'))})
  })
}
const dir=mkdtempSync(join(tmpdir(),'obs-render-comparison-'))
const image=join(dir,'red.png'),movie=join(dir,'blue.mp4'),nativeMedia=join(dir,'native-tone.mp4')
function ff(args){
  const r=spawnSync('ffmpeg',['-nostdin','-loglevel','error','-y',...args],
    {timeout:120000,maxBuffer:8*1024*1024})
  if(r.error||r.status!==0)throw Error('Fixture generation failed: '+String(r.stderr).slice(-2000))
}
const ids={accountId:'render-diagnostic',...config,mediaIds:['image','video']}
const output=new LiveOutputServer((account,id)=>{
  if(account!==ids.accountId)return null
  const path=id==='image'?image:id==='video'?movie:null
  return path?{id,kind:id==='image'?'image':'video',mime:id==='image'?'image/png':'video/mp4',
    absolutePath:path,size:statSync(path).size}:null
})
const managedScenes=new ManagedObsSceneController()
const visual=new VisualPreviewController(output,managedScenes,getObsStreamStatus)
const broadcast=new LiveBroadcastController(visual,new ObsStreamSession())
const report={purpose:'render-diagnostic-only',platform:process.platform,arch:process.arch,
  cpuModel:cpus()[0]?.model,cpuCount:cpus().length,phases:[]}
let receiver=null,receiverLog='',ownsNativeStream=false,ownsNativeScene=false,original=null,originalService=null
const nativeScene='AI Live Commerce - render-control-'+randomUUID().slice(0,7)
async function sample(){
  const stats=await obs('GetStats')
  for(const key of ['renderSkippedFrames','renderTotalFrames','outputSkippedFrames',
    'outputTotalFrames','activeFps','averageFrameRenderTime','cpuUsage','memoryUsage'])
    assert.ok(Number.isFinite(stats[key]),'OBS GetStats lacks actual numeric '+key)
  return {at:Date.now(),...stats}
}
async function measure(label,seconds,tick=async()=>{}){
  const start=Date.now(),samples=[await sample()]
  while(Date.now()-start<seconds*1000){
    await sleep(Math.min(5000,seconds*1000-(Date.now()-start)))
    await tick(Date.now()-start)
    samples.push(await sample())
  }
  const first=samples[0],last=samples.at(-1),delta={}
  for(const key of ['renderSkippedFrames','renderTotalFrames','outputSkippedFrames','outputTotalFrames']){
    delta[key]=last[key]-first[key]
    assert.ok(delta[key]>=0,'OBS counters reset during '+label)
  }
  assert.ok(delta.renderTotalFrames>0,'OBS renderer produced no measured frames in '+label)
  const mean=key=>samples.reduce((sum,s)=>sum+s[key],0)/samples.length
  const result={label,elapsedMs:last.at-first.at,delta,
    renderSkippedPercent:100*delta.renderSkippedFrames/delta.renderTotalFrames,
    activeFpsMean:mean('activeFps'),frameRenderMsMean:mean('averageFrameRenderTime'),
    obsCpuPercentMean:mean('cpuUsage'),obsMemoryMBFirst:first.memoryUsage,
    obsMemoryMBLast:last.memoryUsage,samples}
  report.phases.push(result)
  writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
  console.log('RENDER DIAGNOSTIC:',JSON.stringify({...result,samples:undefined}))
  return result
}
async function startReceiver(name){
  receiverLog=''
  receiver=spawn('ffmpeg',['-nostdin','-hide_banner','-nostats','-loglevel','warning',
    '-listen','1','-i','rtmp://127.0.0.1:1935/live/ci-validation-only',
    '-c','copy','-f','flv','-y',join(records,name)],{stdio:['ignore','ignore','pipe']})
  receiver.stderr.on('data',x=>{
    receiverLog=(receiverLog+String(x)).slice(-5000)
    writeFileSync(join(logDir,'render-receiver-'+name+'.log'),receiverLog)
  })
  await sleep(1200)
  assert.ok(receiver.pid&&receiver.exitCode===null&&!receiver.signalCode,
    'Owned FFmpeg receiver exited: '+receiverLog)
}
async function finishReceiver(){
  for(let n=0;n<80&&receiver.exitCode===null&&!receiver.signalCode;n++)await sleep(100)
  assert.ok(receiver.exitCode!==null||receiver.signalCode,
    'Owned receiver did not finish after StopStream: '+receiverLog)
  receiver=null
}
async function cleanupNativeScene(){
  // Reuse the product's existing ownership-safe cleanup and observed-state
  // confirmation. RemoveScene acknowledgement alone can precede UI deletion.
  await managedScenes.cleanup(config,{
    sceneName:nativeScene,sourceName:nativeScene+' media',previousScene:original.currentScene,
  })
  const actual=await getObsSceneInfo(config)
  assert.deepEqual(actual.scenes,original.scenes,'Native scene cleanup failed')
  assert.equal(actual.currentScene,original.currentScene,'Native control did not restore the original scene')
  ownsNativeScene=false
  console.log('PASS native diagnostic scene removal confirmed by actual OBS state')
}
try{
  const status=await getObsStreamStatus(config)
  assert.ok(!status.active&&!status.reconnecting,'Cannot touch an already active OBS output')
  original=await getObsSceneInfo(config)
  assert.ok(original.currentScene,'OBS original scene is missing')
  originalService=await obs('GetStreamServiceSettings')
  report.version=await obs('GetVersion')
  report.video=await obs('GetVideoSettings')
  const width=report.video.baseWidth,height=report.video.baseHeight
  assert.ok(Number.isInteger(width)&&width>=320&&Number.isInteger(height)&&height>=240,
    'Actual OBS canvas is not valid')
  await obs('SetStreamServiceSettings',{streamServiceType:'rtmp_custom',
    streamServiceSettings:{server:'rtmp://127.0.0.1:1935/live',key:'ci-validation-only',use_auth:false}})
  ff(['-f','lavfi','-i','color=c=red:s=640x360','-frames:v','1',image])
  ff(['-f','lavfi','-i','color=c=blue:s=640x360:r=20','-t','2.5',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',movie])
  ff(['-f','lavfi','-i','color=c=blue:s='+width+'x'+height+':r=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','11',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',
    '-b:a','128k','-movflags','+faststart',nativeMedia])

  assert.equal((await visual.start(ids)).visualReady,true,'Real product CEF preview did not become ready')
  await visual.stop(ids.accountId)
  await measure('blank-after-product-cef-init',30)

  await startReceiver('render-product.flv')
  assert.equal((await broadcast.start(ids)).phase,'streaming')
  await output.playAudio(toneWav())
  let playedAgain=false
  await measure('product-cef-real-rtmp',120,async elapsed=>{
    const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
    assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming,
      'Real product session failed: '+JSON.stringify(managed))
    assert.ok(actual.active&&!actual.reconnecting,'Product OBS output disconnected')
    if(elapsed>=60000&&!playedAgain){playedAgain=true;await output.playAudio(toneWav())}
  })
  await broadcast.stop(ids.accountId)
  await finishReceiver()
  report.productCapture=validateRtmpCapture(join(records,'render-product.flv'),{minDuration:115})
  assert.deepEqual((await getObsSceneInfo(config)).scenes,original.scenes,'Product scene cleanup failed')

  await obs('CreateScene',{sceneName:nativeScene})
  ownsNativeScene=true
  await obs('CreateInput',{sceneName:nativeScene,inputName:nativeScene+' media',inputKind:'ffmpeg_source',
    inputSettings:{is_local_file:true,local_file:nativeMedia,looping:true,
      restart_on_activate:true,close_when_inactive:false},sceneItemEnabled:true})
  await obs('SetCurrentProgramScene',{sceneName:nativeScene})
  await sleep(1600)
  await startReceiver('render-native.flv')
  await obs('StartStream')
  ownsNativeStream=true
  for(let n=0;n<30;n++){
    const live=await getObsStreamStatus(config)
    if(live.active&&!live.reconnecting)break
    await sleep(200)
  }
  await measure('native-ffmpeg-source-real-rtmp',120,async()=>{
    const actual=await getObsStreamStatus(config)
    assert.ok(actual.active&&!actual.reconnecting,'Native control RTMP disconnected')
  })
  await obs('StopStream')
  ownsNativeStream=false
  for(let n=0;n<40&&(await getObsStreamStatus(config)).active;n++)await sleep(250)
  assert.equal((await getObsStreamStatus(config)).active,false,'Native control did not stop')
  await finishReceiver()
  report.nativeCapture=validateRtmpCapture(join(records,'render-native.flv'),
    {minDuration:115,requireChange:false})
  await cleanupNativeScene()
  await measure('blank-after-native-control',30)
  report.completed=true
  writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
  console.log('PASS real render comparison captured; counters report performance, not a smoothness pass')
}catch(error){
  console.error('RENDER DIAGNOSTIC FAILED:',error)
  process.exitCode=1
}finally{
  if(ownsNativeStream)try{await obs('StopStream')}catch(error){console.error('Native stop:',error)}
  if(ownsNativeScene)try{await cleanupNativeScene()}
  catch(error){console.error('Native cleanup:',error);process.exitCode=1}
  if(broadcast.snapshot().phase!=='idle'||visual.snapshot().previewing)
    try{await broadcast.stop(ids.accountId)}catch(error){console.error('Product cleanup:',error);process.exitCode=1}
  if(receiver&&receiver.exitCode===null&&!receiver.signalCode){
    receiver.kill('SIGKILL')
    await Promise.race([once(receiver,'exit').catch(()=>{}),sleep(5000)])
  }
  if(originalService?.streamServiceSettings&&Object.keys(originalService.streamServiceSettings).length)
    try{await obs('SetStreamServiceSettings',originalService)}catch(error){console.error('Service restore:',error);process.exitCode=1}
  await output.stop()
  rmSync(dir,{recursive:true,force:true})
}
