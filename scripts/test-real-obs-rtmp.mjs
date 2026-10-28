import assert from 'node:assert/strict'
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
function toneWav(seconds=3.5,rate=24000){
  const samples=Math.floor(seconds*rate),b=Buffer.alloc(44+samples*2)
  b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVE',8)
  b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20)
  b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28)
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34)
  b.write('data',36);b.writeUInt32LE(samples*2,40)
  for(let i=0;i<samples;i++){
    const fade=Math.min(1,i/600,(samples-i)/600)
    b.writeInt16LE(Math.round(12000*fade*Math.sin(i*2*Math.PI*440/rate)),44+2*i)
  }
  return b.toString('base64')
}
async function recordedFile(){
  for(let i=0;i<80;i++){
    const names=readdirSync(recordings).filter(name=>name.endsWith('.flv'))
    if(names.length)return join(recordings,names[0])
    await sleep(250)
  }
  throw Error('No FLV recording written by actual Nginx RTMP receiver')
}
function validateCapture(filename){
  const info=JSON.parse(run('ffprobe',['-v','error','-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height','-of','json',filename]).toString())
  const v=info.streams?.find(x=>x.codec_type==='video')
  const a=info.streams?.find(x=>x.codec_type==='audio')
  check(v,'Actual RTMP recording has no video track')
  check(a,'Actual RTMP recording has no audio track')
  check(v.width>=320&&v.height>=240,'Actual OBS video dimensions invalid')
  check(Number(info.format?.duration)>=7,'RTMP recording duration shorter than 7 seconds')

  const pcm=run('ffmpeg',['-loglevel','error','-i',filename,'-map','0:a:0',
    '-ar','8000','-ac','1','-f','s16le','pipe:1'])
  let sumSq=0,peak=0
  for(let i=0;i+1<pcm.length;i+=2){
    const sample=pcm.readInt16LE(i)
    sumSq+=sample*sample
    peak=Math.max(peak,Math.abs(sample))
  }
  const rms=Math.sqrt(sumSq/Math.max(1,pcm.length/2))
  check(peak>250&&rms>45,'Actual RTMP AUDIO IS SILENT: peak='+peak+' rms='+rms)

  // Nonzero energy alone could be unrelated desktop/microphone noise. The
  // injected Browser Source verification WAV is a 440 Hz tone; confirm that
  // frequency is present in the actual OBS -> RTMP -> AAC decoded recording.
  const spectralPeak = hz => {
    const rate = 8000
    const windowSize = rate // 1 second, integer bin alignment at 440 Hz
    const frames = Math.floor(pcm.length / (windowSize*2))
    let largest = 0
    for (let frame=0;frame<frames;frame++) {
      let real=0,imag=0
      const start=frame*windowSize
      for (let i=0;i<windowSize;i++) {
        const v=pcm.readInt16LE((start+i)*2)
        const radians=2*Math.PI*hz*i/rate
        real+=v*Math.cos(radians)
        imag+=v*Math.sin(radians)
      }
      largest=Math.max(largest,2*Math.hypot(real,imag)/windowSize)
    }
    return largest
  }
  const tone440=spectralPeak(440)
  const other620=spectralPeak(620)
  check(tone440>Math.max(200,rms*0.3) && tone440>other620*3,
    'RTMP audio lacks injected 440Hz OBS Browser Source tone: '+
    JSON.stringify({tone440,other620,rms}))
  console.log('PASS injected 440Hz Browser Source tone detected in recorded RTMP AAC:',
    JSON.stringify({tone440:Math.round(tone440),other620:Math.round(other620)}))

  const rgb=run('ffmpeg',['-loglevel','error','-i',filename,'-map','0:v:0',
    '-vf','fps=1,scale=32:32','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
  const frames=Math.floor(rgb.length/(32*32*3))
  check(frames>=5,'Actual RTMP recording contains too few decoded video frames: '+frames)
  const palette=new Set()
  let visible=0
  for(let f=0;f<frames;f++){
    let red=0,green=0,blue=0
    for(let i=f*3072;i<(f+1)*3072;i+=3){
      red+=rgb[i];green+=rgb[i+1];blue+=rgb[i+2]
    }
    const color=[red/1024,green/1024,blue/1024]
    if(Math.max(...color)>35)visible++
    palette.add(color.map(n=>Math.floor(n/18)).join('-'))
  }
  check(visible>=3,'RTMP video is black or has missing visual content')
  check(palette.size>=2,'RTMP video does not show image-to-video change')
  console.log('PASS real RTMP capture:',JSON.stringify({
    duration:info.format.duration,videoCodec:v.codec_name,audioCodec:a.codec_name,
    audioPeak:peak,audioRms:rms.toFixed(1),decodedFrames:frames,colors:palette.size
  }))
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
  while(Date.now()-startedAt<soakSeconds*1000){
    await sleep(Math.min(5000,soakSeconds*1000-(Date.now()-startedAt)))
    const observed=await getObsStreamStatus(obsConfig)
    check(observed.active && !observed.reconnecting,
      'Actual OBS output lost RTMP service during soak check: '+JSON.stringify(observed))
  }
  console.log('PASS sustained OBS stream for '+soakSeconds+' sec without reconnect/stop')
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
