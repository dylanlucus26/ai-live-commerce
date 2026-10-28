import assert from 'node:assert/strict'
import { toneWav, validateRtmpCapture as validateCapture } from './validate-real-rtmp.mjs'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

import { obsAuthentication, getObsSceneInfo, getObsStreamStatus } from '../electron/main/services/ObsService.ts'
import { LiveOutputServer } from '../electron/main/services/LiveOutputServer.ts'
import { ManagedObsSceneController } from '../electron/main/services/ManagedObsSceneController.ts'
import { VisualPreviewController } from '../electron/main/services/VisualPreviewController.ts'
import { ObsStreamSession } from '../electron/main/services/ObsStreamSession.ts'
import { LiveBroadcastController } from '../electron/main/services/LiveBroadcastController.ts'

// Real OBS + Nginx RTMP only on 127.0.0.1; never contact a real streaming platform.
const obsConfig = {port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD ?? ''}
const recordings = process.env.AI_LIVE_RTMP_RECORD_DIR
assert.ok(obsConfig.password && recordings, 'CI requires local OBS password and RTMP directory')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function run(executable,args,maxMs=120000) {
  const p=spawnSync(executable,args,{timeout:maxMs,maxBuffer:32*1024*1024})
  if(p.error || p.status!==0)throw Error(executable+' failed: '+String(p.stderr).slice(-3500))
  return p.stdout
}
function check(value,msg){assert.ok(value,msg)}
async function rawObsRequest(requestType,requestData={}) {
  const requestId=randomUUID()
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:'+obsConfig.port,{handshakeTimeout:5000})
    let finished=false
    const watchdog=setTimeout(()=>finish(Error('OBS request timeout: '+requestType)),15000)
    function finish(error,result){
      if(finished)return
      finished=true
      clearTimeout(watchdog)
      ws.close()
      if(error)reject(error)
      else resolve(result??{})
    }
    ws.on('message',raw=>{
      try {
        const message=JSON.parse(String(raw)),d=message.d??{}
        if(message.op===0){
          const identify={rpcVersion:1}
          if(d.authentication){
            identify.authentication=obsAuthentication(obsConfig.password,
              d.authentication.challenge,d.authentication.salt)
          }
          ws.send(JSON.stringify({op:1,d:identify}))
        }else if(message.op===2){
          ws.send(JSON.stringify({op:6,d:{requestType,requestId,requestData}}))
        }else if(message.op===7 && d.requestId===requestId){
          if(d.requestStatus?.result!==true)
            throw Error('OBS '+requestType+': '+d.requestStatus?.code+' '+d.requestStatus?.comment)
          finish(null,d.responseData)
        }
      } catch(err){finish(err)}
    })
    ws.on('error',finish)
    ws.on('close',()=>{if(!finished)finish(Error('OBS websocket closed during '+requestType))})
  })
}
async function waitForObs(){
  let latest
  for(let n=0;n<100;n++){
    try{return await rawObsRequest('GetVersion')}catch(err){latest=err;await sleep(500)}
  }
  throw Error('Real OBS Studio WebSocket failed: '+latest)
}

async function recordedFile(){
  for(let i=0;i<80;i++){
    const names=readdirSync(recordings).filter(name=>name.endsWith('.flv'))
    if(names.length)return join(recordings,names[0])
    await sleep(250)
  }
  throw Error('No FLV recording written by actual Nginx RTMP receiver')
}

const dir=mkdtempSync(join(tmpdir(),'real-obs-fixture-'))
const image=join(dir,'product-red.png'),movie=join(dir,'product-blue.mp4')
const ids={accountId:'obs-loopback-ci',port:4455,password:obsConfig.password,
  mediaIds:['image','video']}
const output=new LiveOutputServer((account,id)=>{
  if(account!==ids.accountId)return null
  if(id==='image')return {id,kind:'image',mime:'image/png',absolutePath:image,size:statSync(image).size}
  if(id==='video')return {id,kind:'video',mime:'video/mp4',absolutePath:movie,size:statSync(movie).size}
  return null
})
const visual=new VisualPreviewController(output,new ManagedObsSceneController(),getObsStreamStatus)
const session=new ObsStreamSession()
const broadcast=new LiveBroadcastController(visual,session)
let ownsStream=false
let originalStreamService=null
try{
  const ver=await waitForObs()
  console.log('ACTUAL OBS STUDIO',ver.obsVersion,'OBS WEBSOCKET',ver.obsWebSocketVersion)
  assert.ok(ver.obsVersion,'OBS did not answer GetVersion')
  const currentTransport=await getObsStreamStatus(obsConfig)
  check(!currentTransport.active && !currentTransport.reconnecting,
    'OBS is already streaming: refusing to alter its stream service or interrupt the broadcast')
  const original=await getObsSceneInfo(obsConfig)
  check(original.currentScene,'OBS has no original scene to restore')
  originalStreamService=await rawObsRequest('GetStreamServiceSettings')
  const originalSettings = originalStreamService.streamServiceSettings
  const originalCanRestore = typeof originalStreamService.streamServiceType === 'string'
    && originalStreamService.streamServiceType.length > 0
    && originalSettings !== null && typeof originalSettings === 'object'
    && Object.keys(originalSettings).length > 0
  // A disposable GitHub CI runner may start with no saved service. On a real
  // operator's OBS install, refuse any temporary RTMP change unless its
  // original configuration can be restored accurately afterward.
  if (!originalCanRestore && !process.env.GITHUB_ACTIONS) {
    throw Error('Original OBS service is empty; refusing to overwrite an operator profile')
  }
  await rawObsRequest('SetStreamServiceSettings',{
    streamServiceType:'rtmp_custom',
    streamServiceSettings:{
      server:'rtmp://127.0.0.1:1935/live',
      key:'ci-validation-only',
      use_auth:false
    }
  })
  const settings=await rawObsRequest('GetStreamServiceSettings')
  check(settings.streamServiceSettings?.server==='rtmp://127.0.0.1:1935/live',
    'OBS RTMP destination not verified as localhost')
  run('ffmpeg',['-loglevel','error','-y','-f','lavfi',
    '-i','color=c=red:s=640x360','-frames:v','1',image])
  run('ffmpeg',['-loglevel','error','-y','-f','lavfi',
    '-i','color=c=blue:s=640x360:r=20','-t','2.5','-c:v','libx264',
    '-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',movie])

  // Poll the real macOS OBS source activation while CEF loads. This checks
  // whether the source is visible/active or whether the renderer never starts.
  // It does NOT fake Browser Source readiness or alter the stream lifecycle.
  const previewOutcome=visual.start(ids).then(value=>({ok:true,value}),error=>({ok:false,error}))
  if(process.platform==='darwin'){
    for(let n=0;n<9;n++){
      await sleep(4000)
      const stats=output.diagnostics()
      let info=null,source=null
      try{
        const scenes=await getObsSceneInfo(obsConfig)
        const name=scenes.scenes.find(x=>x.startsWith('AI Live Commerce - '))
        if(name){
          const sourceName=name+' - 商品画面'
          let active=null,settings=null
          try{active=await rawObsRequest('GetSourceActive',{sourceName})}
          catch(e){active={error:String(e)}}
          try{
            const result=await rawObsRequest('GetInputSettings',{inputName:sourceName})
            const u=result.inputSettings?.url
            const url=typeof u==='string'?new URL(u):null
            settings={kind:result.inputKind,urlHost:url?.host??null,
              pathLength:url?.pathname?.length??0,reroute_audio:result.inputSettings?.reroute_audio}
          }catch(e){settings={error:String(e)}}
          source={sourceName,active,settings}
          // A screenshot asks the *actual* OBS compositor to render this
          // active source. If macOS CI has a dormant preview this can wake it.
          // Do not mark the browser ready on screenshot success; only the
          // token-protected media page's real /ready acknowledgement counts.
          if(n===2){
            try{
              const shot=await rawObsRequest('GetSourceScreenshot',{
                sourceName,imageFormat:'png',imageWidth:320,imageHeight:180,
              })
              console.log('REAL MAC OBS compositor screenshot result',JSON.stringify({
                success:typeof shot.imageData==='string',encodedLength:shot.imageData?.length??0,
              }))
            }catch(error){console.log('REAL MAC OBS compositor screenshot failed',String(error))}
          }
          if(n===5 && stats.index===0){
            try{
              await rawObsRequest('PressInputPropertiesButton',{
                inputName:sourceName,propertyName:'refreshnocache',
              })
              console.log('REAL MAC OBS requested browser source cache refresh')
            }catch(error){console.log('REAL MAC OBS browser refresh unavailable',String(error))}
          }
        }
        info={scenes:scenes.scenes,current:scenes.currentScene}
      }catch(e){info={error:String(e)}}
      console.log('REAL MAC OBS source activity',JSON.stringify({iteration:n,stats,info,source}))
      if(stats.ready>0)break
    }
  }
  const outcome=await previewOutcome
  if(!outcome.ok)throw outcome.error
  const p=outcome.value
  check(p.visualReady,'OBS CEF Browser Source did not decode the first image')
  check(!(await getObsStreamStatus(obsConfig)).active,'Offline preview unexpectedly started a stream')
  await visual.stop(ids.accountId)
  console.log('PASS actual OBS preview, first-frame readiness, no RTMP and cleanup')
  const live=await broadcast.start(ids)
  check(live.obsStreaming&&live.visualReady,'Actual OBS did not confirm the start of RTMP stream')
  ownsStream=true
  await output.playAudio(toneWav())
  console.log('PASS actual OBS Browser Source acknowledged completed PCM WAV playback')
  const soakSeconds=Number(process.env.AI_LIVE_OBS_SOAK_SECONDS??'15')
  if(!Number.isSafeInteger(soakSeconds) || soakSeconds<11 || soakSeconds>14400)
    throw Error('Soak duration must be 11–14400 seconds')
  const startedAt=Date.now()
  let nextTone=startedAt+60000,toneError=null,tonePending=null,toneAcks=1,nextReport=startedAt+300000
  while(Date.now()-startedAt<soakSeconds*1000){
    await sleep(Math.min(5000,soakSeconds*1000-(Date.now()-startedAt)))
    if(toneError)throw toneError
    const managed=await broadcast.refresh()
    check(managed.phase==='streaming'&&managed.obsStreaming&&managed.visualReady,
      'Product session became unhealthy during actual RTMP delivery: '+JSON.stringify(managed))
    const observed=await getObsStreamStatus(obsConfig)
    check(observed.active && !observed.reconnecting,
      'Actual OBS output lost RTMP service during soak check: '+JSON.stringify(observed))
    if(Date.now()>=nextTone&&Date.now()<startedAt+soakSeconds*1000-8000){
      nextTone+=60000
      tonePending=output.playAudio(toneWav()).then(()=>{toneAcks++},error=>{toneError=error})
    }
    if(Date.now()>=nextReport){
      console.log('SOAK live progress:',JSON.stringify({elapsedSeconds:Math.floor((Date.now()-startedAt)/1000),toneAcks,phase:managed.phase,active:observed.active,reconnecting:observed.reconnecting}))
      nextReport+=300000
    }
  }
  if(tonePending)await tonePending
  if(toneError)throw toneError
  console.log('PASS sustained OBS stream for '+soakSeconds+' sec with healthy product session and no reconnect/stop; audio acknowledgements='+toneAcks)
  await broadcast.stop(ids.accountId)
  ownsStream=false
  check(!(await getObsStreamStatus(obsConfig)).active,'OBS output remained active after stop')
  const after=await getObsSceneInfo(obsConfig)
  console.log('Actual OBS scenes after stop:',JSON.stringify(after.scenes))
  check(after.currentScene===original.currentScene,'OBS original scene not restored')
  check(!after.scenes.some(n=>n.startsWith('AI Live Commerce - ')),
    'OBS managed scene leaked after cleanup: '+JSON.stringify(after.scenes))
  console.log('PASS actual OBS StopStream, original scene restore and temporary scene removal')
  const capture=await recordedFile()
  validateCapture(capture)
  console.log('PASS: REAL OBS/Nginx loopback produced genuine non-black video and non-silent audio')
}catch(error){
  // No test-only synthetic readiness: retain exact counters from the real
  // token-authenticated localhost server to diagnose missing OBS CEF loads.
  console.error('REAL OBS CEF first-frame diagnostics:',JSON.stringify({
    requests:output.diagnostics(),ready:output.isReady(),platform:process.platform,
  }))
  try{console.error('Actual OBS scenes at failure:',JSON.stringify(await getObsSceneInfo(obsConfig)))}catch{}
  if(process.platform==='darwin'){
    try{console.error('macOS OBS/CEF processes:',String(run('ps',['-axo','pid,ppid,state,command'])).split('\n')
      .filter(line=>/OBS.app|OBS Helper|obs-browser|Chromium/u.test(line)).slice(0,24).join('\n'))}catch{}
  }
  console.error('REAL OBS/Nginx/FFprobe FAILURE:',error)
  process.exitCode=1
}finally{
  if(ownsStream||broadcast.snapshot().phase!=='idle'){
    try{await broadcast.stop(ids.accountId)}catch(err){console.error('OBS cleanup error:',err)}
  }
  if(originalStreamService){
    try {
      const state=await getObsStreamStatus(obsConfig)
      if(state.active)throw Error('OBS still streaming; stream service settings were not changed again')
      const saved = originalStreamService.streamServiceSettings
      // A brand-new OBS CI profile can have a nominal service type but zero
      // settings. OBS rejects SetStreamServiceSettings with an empty settings
      // object (403); do not falsely report that as a failed A/V capture.
      // Existing configured profiles MUST still be restored and verified.
      const hadValidOriginal = typeof originalStreamService.streamServiceType === 'string'
        && originalStreamService.streamServiceType.length > 0
        && saved !== null && typeof saved === 'object'
        && Object.keys(saved).length > 0
      if (hadValidOriginal) {
        await rawObsRequest('SetStreamServiceSettings', originalStreamService)
        const restored = await rawObsRequest('GetStreamServiceSettings')
        check(restored.streamServiceType === originalStreamService.streamServiceType,
          'Original OBS stream service type was not restored')
        console.log('PASS original OBS stream service restored after local RTMP test')
      } else {
        console.log('PASS clean OBS CI profile had no prior streaming service to restore')
      }
    } catch(err) {
      console.error('Failed to restore original OBS streaming service safely:',err)
      process.exitCode=1
    }
  }
  await output.stop()
  rmSync(dir,{recursive:true,force:true})
}
