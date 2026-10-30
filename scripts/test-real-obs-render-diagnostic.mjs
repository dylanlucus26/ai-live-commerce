import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,statSync,writeFileSync,readFileSync,existsSync,readdirSync,copyFileSync} from 'node:fs'
import {tmpdir,cpus,homedir} from 'node:os'
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
import {createNumberedMotionFixture,decodeNumberedMotion} from './validate-numbered-motion.mjs'
import {openCefPlaybackObserver} from './inspect-obs-cef-playback.mjs'

// Diagnostic comparison only: no new acceptance threshold or product tuning.
assert.equal(process.env.GITHUB_ACTIONS,'true','Render diagnostic is isolated-cloud only')
assert.equal(process.platform,'darwin','Render diagnostic requires a cloud Mac')
const config={port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD??''}
const logDir=process.env.AI_LIVE_OBS_LOG_DIR
const records=process.env.AI_LIVE_RTMP_RECORD_DIR
const previewDiagnostic=process.env.AI_LIVE_OBS_PREVIEW_DIAGNOSTIC==='true'
const defaultSourcePolicy=process.env.AI_LIVE_OBS_DEFAULT_SOURCE_POLICY==='true'
let previewDisabled=false
let obsProcessLog=null
function resolveActualObsLog(){
  const native=join(logDir,'obs-native.log')
  if(existsSync(native))return native
  // LaunchServices does not attach OBS stdout. Use the actual official-app log,
  // as the cloud runner already does in its diagnostics cleanup.
  const internal=join(homedir(),'Library','Application Support','obs-studio','logs')
  assert.ok(existsSync(internal),'Official OBS internal log directory is missing')
  const candidates=readdirSync(internal).filter(name=>name.endsWith('.txt'))
    .map(name=>join(internal,name)).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)
  assert.ok(candidates.length>0,'Actual official OBS process log is missing')
  return candidates[0]
}
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
const image=join(dir,'red.png'),image2=join(dir,'green.png'),movie=join(dir,'blue.mp4'),nativeMedia=join(dir,'native-tone.mp4')
const numberedMotion=join(records,'numbered-motion-input.mp4')
function ff(args){
  const r=spawnSync('ffmpeg',['-nostdin','-loglevel','error','-y',...args],
    {timeout:120000,maxBuffer:8*1024*1024})
  if(r.error||r.status!==0)throw Error('Fixture generation failed: '+String(r.stderr).slice(-2000))
}
const ids={accountId:'render-diagnostic',...config,mediaIds:['image','video']}
const output=new LiveOutputServer((account,id)=>{
  if(account!==ids.accountId)return null
  const isImage=id==='image'||id==='image2'
  const path=id==='image'?image:id==='image2'?image2:id==='video'?movie:id==='motion'?numberedMotion:null
  return path?{id,kind:isImage?'image':'video',mime:isImage?'image/png':'video/mp4',
    absolutePath:path,size:statSync(path).size}:null
})
const managedScenes=new ManagedObsSceneController()
const visual=new VisualPreviewController(output,managedScenes,getObsStreamStatus)
let cadenceContext=null
let canvasContext=null
let ownedCopyContext=null
let presentationContext=null
async function verifyDefaultSourcePolicy(sceneName){
  if(!defaultSourcePolicy)return null
  assert.ok(sceneName&&sceneName.startsWith('AI Live Commerce - '))
  const inputName=sceneName+' - 商品画面'
  const actual=await obs('GetInputSettings',{inputName})
  assert.equal(actual.inputKind,'browser_source')
  assert.equal(actual.inputSettings.macos_owned_frame_queue,true,'Actual product source did not opt in')
  assert.equal(actual.inputSettings.width,report.video.baseWidth)
  assert.equal(actual.inputSettings.height,report.video.baseHeight)
  assert.deepEqual(await obs('GetVideoSettings'),report.video,'Actual canvas/output changed')
  const evidence={inputName,inputKind:actual.inputKind,setting:actual.inputSettings.macos_owned_frame_queue,
    width:actual.inputSettings.width,height:actual.inputSettings.height}
  ;(report.defaultSourcePolicyInputs??=[]).push(evidence)
  return evidence
}
async function startVisualWithCadence(options){
  if(ownedCopyContext){
    if(process.env.AI_LIVE_OBS_FRAME_LIFETIME_TRACE==='true')
      ownedCopyContext.entry.frameTraceBefore=await setFrameLifetimeProbe(true,true,false)
    if(process.env.AI_LIVE_OBS_BEGIN_FRAME_ABA==='true')
      ownedCopyContext.entry.clockBefore=await setExternalBeginFrameProbe(ownedCopyContext.externalBeginFrame,true)
    ownedCopyContext.entry.copyBefore=await setOwnedCopyProbe(ownedCopyContext.enabled,true,ownedCopyContext.gpuOnly,ownedCopyContext.queueEnabled,ownedCopyContext.deferReadback)
  }
  const ready=await visual.start(options)
  await verifyDefaultSourcePolicy(ready.obsScene)
  if(ownedCopyContext){
    ownedCopyContext.observer=await openCefPlaybackObserver(output.getUrl())
    ownedCopyContext.entry.observer=ownedCopyContext.observer.metadata
    return visual.snapshot()
  }
  if(presentationContext){
    presentationContext.observer=await openCefPlaybackObserver(output.getUrl())
    report.cefObserver=presentationContext.observer.metadata
    report.presentationTraceStart=await presentationContext.observer.startPresentationTrace()
    return visual.snapshot()
  }
  if(canvasContext){
    canvasContext.observer=await openCefPlaybackObserver(output.getUrl())
    canvasContext.entry.observer=canvasContext.observer.metadata
    if(canvasContext.canvas)
      canvasContext.entry.actualFirstCanvasFrame=await canvasContext.observer.applyCanvasVariant()
    return visual.snapshot()
  }
  if(!cadenceContext)return ready
  const {label,paint60,defaults}=cadenceContext
  const sceneName=visual.snapshot().obsScene
  assert.ok(sceneName,'Product-owned browser scene missing')
  // Exact source-name construction from ManagedObsSceneController.prepare.
  const inputName=sceneName+' - 商品画面'
  let settings=await obs('GetInputSettings',{inputName})
  assert.equal(settings.inputKind,'browser_source')
  const readyBefore=output.diagnostics().ready
  if(paint60){
    await obs('SetInputSettings',{inputName,inputSettings:{fps_custom:true,fps:60},overlay:true})
    for(let attempt=0;attempt<200&&output.diagnostics().ready<=readyBefore;attempt++)await sleep(200)
    assert.ok(output.diagnostics().ready>readyBefore,'Actual reloaded 60-paint browser did not acknowledge media')
    settings=await obs('GetInputSettings',{inputName})
  }
  const effective={...defaults.defaultInputSettings,...settings.inputSettings}
  assert.equal(effective.fps_custom,paint60)
  if(paint60)assert.equal(effective.fps,60)
  assert.deepEqual(await obs('GetVideoSettings'),report.video,'Canvas/output FPS changed during browser-paint probe')
  cadenceContext.entry={label,paint60,inputName,effectiveBrowser:{fps:effective.fps,fps_custom:effective.fps_custom,
    width:effective.width,height:effective.height,reroute_audio:effective.reroute_audio},
    readyBefore,readyAfter:output.diagnostics().ready}
  report.browserCadence.push(cadenceContext.entry)
  return visual.snapshot()
}
const broadcast=new LiveBroadcastController({
  start:startVisualWithCadence,stop:accountId=>visual.stop(accountId),snapshot:()=>visual.snapshot(),
},new ObsStreamSession())
const report={purpose:'render-diagnostic-only',platform:process.platform,arch:process.arch,
  ownedObsPID:Number(process.env.AI_LIVE_OBS_TEST_PID),
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
  if(process.env.AI_LIVE_OBS_SYSTEM_TRACE==='true'&&label==='fixed-pipeline-prime5'){
    assert.equal(process.env.GITHUB_ACTIONS,'true')
    report.systemProfileNotAcceptance=true
    const pid=Number(process.env.AI_LIVE_OBS_TEST_PID)
    assert.ok(Number.isSafeInteger(pid)&&pid>0,'Owned cloud OBS PID required for system trace trigger')
    writeFileSync(join(logDir,'system-trace','actual-measure-trigger.json'),JSON.stringify({label,pid,at:Date.now()}))
    // The workflow joins its own profiler after this script and the runner have stopped OBS.
    // Awaiting it here holds the live Metal process open while xctrace tries to stop.
  }
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
  // Thread sampling happens after timed counters close; raw phase samples remain intact.
  if(previewDiagnostic){
    if(process.env.AI_LIVE_OBS_SKIP_THREAD_SAMPLE==='true'){
      assert.equal(process.env.AI_LIVE_OBS_READBACK_COMPARISON,'true','Sampling exclusion is scoped to this controlled readback experiment')
      report.threadSamplingSkippedReason='Prior same-process stack evidence already retained. Avoid inserting a diagnostic sampler into the live queue interval; GetStats, actual capture, frame-order, GPU-error and scene cleanup gates remain unchanged.'
    }else captureObsThreads(label)
  }
  return result
}
function captureObsThreads(label){
  const pid=Number(process.env.AI_LIVE_OBS_TEST_PID)
  assert.ok(Number.isInteger(pid)&&pid>0,'Owned cloud OBS PID missing')
  const file=join(logDir,'obs-threads-'+label+'.txt')
  const result=spawnSync('/usr/bin/sample',[String(pid),'3','1','-file',file],
    {timeout:15000,maxBuffer:4*1024*1024})
  writeFileSync(join(logDir,'obs-sampler-'+label+'.log'),
    String(result.stdout??'')+String(result.stderr??''))
  assert.ok(!result.error&&result.status===0&&statSync(file).size>0,
    'Actual OBS thread sampling failed: '+String(result.error??result.stderr))
  report.threadSamples??=[]
  report.threadSamples.push({label,pid,file,at:Date.now()})
  console.log('PASS actual OBS thread sample:',JSON.stringify({label,pid,file}))
}
async function setPreview(enabled){
  const marker=(enabled?'Enabling':'Disabling')+' preview due to hotkey'
  const before=readFileSync(obsProcessLog,'utf8').length
  await obs('TriggerHotkeyByName',{hotkeyName:'OBSBasic.'+(enabled?'EnablePreview':'DisablePreview')})
  for(let attempt=0;attempt<20;attempt++){
    const tail=readFileSync(obsProcessLog,'utf8').slice(before)
    const line=tail.split('\n').find(line=>line.includes(marker))
    if(line){
      previewDisabled=!enabled
      report.previewEvents??=[]
      report.previewEvents.push({enabled,at:Date.now(),line})
      console.log('PASS actual OBS preview transition:',line)
      return
    }
    await sleep(100)
  }
  throw Error('OBS did not confirm preview transition: '+marker)
}
function prepareNumberedMotion(){
if(process.env.AI_LIVE_OBS_NUMBERED_FIXTURE_PATH){
  assert.ok(process.env.AI_LIVE_OBS_NUMBERED_FIXTURE_SHA256,'Shared fixture checksum is required')
  copyFileSync(process.env.AI_LIVE_OBS_NUMBERED_FIXTURE_PATH,numberedMotion)
  report.numberedReference=decodeNumberedMotion(numberedMotion,{reference:true})
  assert.equal(report.numberedReference.sha256,process.env.AI_LIVE_OBS_NUMBERED_FIXTURE_SHA256,
    'Same-VM launch comparison did not use the exact previously calibrated source')
}else report.numberedReference=createNumberedMotionFixture(numberedMotion)
}
async function browserCadenceComparison(){
  report.purpose='same-OBS-exact-source-browser-paint-cadence-ABA-not-general-acceptance'
  report.launchMode=process.env.AI_LIVE_MAC_OBS_LAUNCH
  assert.equal(report.launchMode,'launchservices','Use the product normal macOS launch path')
  prepareNumberedMotion()
  const defaults=await obs('GetInputDefaultSettings',{inputKind:'browser_source'})
  report.browserDefaults={fps:defaults.defaultInputSettings.fps,
    fps_custom:defaults.defaultInputSettings.fps_custom}
  report.browserCadence=[]
  const failures=[]
  for(const [label,paint60] of [['browser-follow-30-first',false],['browser-paints-60',true],['browser-follow-30-restored',false]]){
    cadenceContext={label,paint60,defaults}
    const file='render-'+label+'.flv'
    await startReceiver(file)
    assert.equal((await broadcast.start({...ids,mediaIds:['motion']})).phase,'streaming')
    const entry=cadenceContext.entry
    assert.ok(entry,'Actual cadence settings were not observed inside the managed preview stage')
    await output.playAudio(toneWav())
    await measure(label,40,async()=>{
      const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
      assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming)
      assert.ok(actual.active&&!actual.reconnecting)
    })
    await broadcast.stop(ids.accountId)
    await finishReceiver()
    entry.capture=validateRtmpCapture(join(records,file),{minDuration:35})
    try{entry.numbered=decodeNumberedMotion(join(records,file))}
    catch(error){
      entry.numbered={...(existsSync(join(records,file)+'.numbered.json')?JSON.parse(readFileSync(join(records,file)+'.numbered.json','utf8')):{}),error:String(error)}
      failures.push(error)
    }
    const actual=await getObsSceneInfo(config)
    assert.deepEqual(actual.scenes,original.scenes,'Browser cadence probe leaked a scene')
    assert.equal(actual.currentScene,original.currentScene,'Browser cadence probe did not restore original scene')
    console.log('ACTUAL BROWSER CADENCE OBSERVATION:',JSON.stringify({...entry,numbered:{...entry.numbered,indices:undefined}}))
  }
  cadenceContext=null
  const candidate=report.browserCadence.find(x=>x.paint60).numbered
  report.candidateHasThirtySequentialFramesPerSecond=candidate.frames===900&&candidate.distinctSourceFrames===900&&
    candidate.repeatedFrames===0&&candidate.skippedSourceFrames===0&&candidate.backwards===0
  if(!report.candidateHasThirtySequentialFramesPerSecond)
    failures.push(Error('60-paint candidate did not deliver 900 sequential distinct frames in the actual 30-second decode window'))
  if(failures.length)throw new AggregateError(failures,'Browser cadence experiment retains failed actual-frame checks')
}
async function cefPresentationComparison(){
  report.purpose='actual-video-compositor-submission-vs-RTMP-frame-identifiers-not-a-product-fix'
  report.observerEffectCaveat='Callback registration and CDP reading may affect scheduling. Metadata describes submission to the compositor, not CEF capture or OBS delivery; absent callbacks alone do not prove upstream frame loss.'
  assert.equal(report.version.obsVersion,'32.2.2','This trace requires the same actual official OBS version')
  prepareNumberedMotion()
  presentationContext={observer:null}
  let frameError=null
  try{
    const file=join(records,'render-cef-presentation.flv')
    await startReceiver('render-cef-presentation.flv')
    assert.equal((await broadcast.start({...ids,mediaIds:['motion']})).phase,'streaming')
    const observer=presentationContext.observer
    assert.ok(observer,'Presentation observer did not attach during the actual managed preview')
    await output.playAudio(toneWav())
    report.cefPlayback=[await observer.sample()]
    await measure('actual-cef-presentation-observation',40,async()=>{
      const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
      assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming)
      assert.ok(actual.active&&!actual.reconnecting)
      report.cefPlayback.push(await observer.sample())
    })
    report.presentationTrace=await observer.finishPresentationTrace()
    writeFileSync(join(logDir,'cef-presentation-trace.json'),JSON.stringify(report.presentationTrace,null,2))
    await broadcast.stop(ids.accountId)
    await finishReceiver()
    report.cefCapture=validateRtmpCapture(file,{minDuration:35})
    try{report.cefNumbered=decodeNumberedMotion(file)}
    catch(error){
      report.cefNumbered={...(existsSync(file+'.numbered.json')?JSON.parse(readFileSync(file+'.numbered.json','utf8')):{}),error:String(error)}
      frameError=error
    }
    const trace=report.presentationTrace,frames=trace.frames
    assert.equal(trace.error,null);assert.equal(trace.overflow,false)
    assert.ok(frames.length>0,'No video frame was observed for compositor submission')
    for(let i=0;i<frames.length;i++){
      const f=frames[i]
      for(const key of ['now','presentationTime','expectedDisplayTime','mediaTime','presentedFrames'])
        assert.ok(Number.isFinite(f[key]),'Missing actual video callback metadata '+key)
      assert.equal(f.width,1280);assert.equal(f.height,720)
      assert.ok(Math.abs(f.mediaTime*30-Math.round(f.mediaTime*30))<0.001,
        'Actual callback PTS does not match calibrated source frames')
      if(i){
        assert.ok(f.now>=frames[i-1].now,'Callback clock moved backwards')
        assert.ok(f.presentedFrames>frames[i-1].presentedFrames,'Submission counter failed to increase')
      }
    }
    assert.ok(Array.isArray(report.cefNumbered.indices),'Actual RTMP frame identifiers missing: '+String(frameError??''))
    const outputSet=new Set(report.cefNumbered.indices)
    const min=Math.min(...outputSet),max=Math.max(...outputSet)
    const inRange=frames.filter(f=>Math.round(f.mediaTime*30)>=min&&Math.round(f.mediaTime*30)<=max)
    const observedSet=new Set(inRange.map(f=>Math.round(f.mediaTime*30)))
    const missingOutput=Array.from({length:max-min+1},(_,i)=>min+i).filter(n=>!outputSet.has(n))
    report.presentationBoundary={sourceIndexRange:[min,max],callbackCount:frames.length,
      callbackWindowCount:inRange.length,observedSubmissionDistinct:observedSet.size,
      outputDistinct:outputSet.size,missingOutputSourceIndices:missingOutput,
      submittedButAbsentFromOutput:missingOutput.filter(n=>observedSet.has(n)),
      notObservedInCallbacksOrOutput:missingOutput.filter(n=>!observedSet.has(n)),
      missingCallbackNotifications:frames.slice(1).reduce((sum,f,i)=>sum+f.presentedFrames-frames[i].presentedFrames-1,0),
      coverage:{firstMediaTime:frames[0].mediaTime,lastMediaTime:frames.at(-1).mediaTime},
      caveat:'Observed submitted identifiers absent from RTMP locate a loss after HTML video submission. Unobserved identifiers can reflect missed callback notifications; they do not locate a decoder fault.'}
    const actual=await getObsSceneInfo(config)
    assert.deepEqual(actual.scenes,original.scenes)
    assert.equal(actual.currentScene,original.currentScene)
    report.presentationRestoredScene=actual
    console.log('ACTUAL CEF PRESENTATION BOUNDARY:',JSON.stringify(report.presentationBoundary))
    report.presentationHasThirtySequentialFramesPerSecond=report.cefNumbered.frames===900&&
      report.cefNumbered.distinctSourceFrames===900&&report.cefNumbered.repeatedFrames===0&&
      report.cefNumbered.skippedSourceFrames===0&&report.cefNumbered.backwards===0
    if(frameError)throw frameError
    assert.ok(report.presentationHasThirtySequentialFramesPerSecond,
      'Actual official Browser Source output still lacks 900 sequential distinct frames')
  }finally{presentationContext?.observer?.close();presentationContext=null}
}
async function cefPlaybackComparison(){
  report.purpose='actual-product-CEF-GPU-and-decoder-observation-only'
  report.observerEffectCaveat='CDP attachment may affect scheduling; this is not unobserved performance acceptance'
  report.launchMode=process.env.AI_LIVE_MAC_OBS_LAUNCH
  prepareNumberedMotion()
  let observer=null
  try{
    await startReceiver('render-cef-decoder-observation.flv')
    assert.equal((await broadcast.start({...ids,mediaIds:['motion']})).phase,'streaming')
    await output.playAudio(toneWav())
    observer=await openCefPlaybackObserver(output.getUrl())
    report.cefObserver=observer.metadata
    report.cefPlayback=[await observer.sample()]
    await measure('actual-product-cef-decoder-observation',40,async()=>{
      const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
      assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming)
      assert.ok(actual.active&&!actual.reconnecting)
      report.cefPlayback.push(await observer.sample())
    })
    await broadcast.stop(ids.accountId)
    await finishReceiver()
    report.cefCapture=validateRtmpCapture(join(records,'render-cef-decoder-observation.flv'),{minDuration:35})
    report.cefNumbered=decodeNumberedMotion(join(records,'render-cef-decoder-observation.flv'))
    const first=report.cefPlayback[0],last=report.cefPlayback.at(-1)
    const wall=(last.receivedAt-first.receivedAt)/1000
    report.cefPlaybackDelta={wallSeconds:wall,mediaSeconds:last.currentTime-first.currentTime,
      videoFrames:last.totalVideoFrames-first.totalVideoFrames,
      droppedVideoFrames:last.droppedVideoFrames-first.droppedVideoFrames,
      mediaClockPerWallSecond:(last.currentTime-first.currentTime)/wall}
    const actual=await getObsSceneInfo(config)
    assert.deepEqual(actual.scenes,original.scenes)
    assert.equal(actual.currentScene,original.currentScene)
    console.log('ACTUAL CEF GPU OBSERVATION:',JSON.stringify(report.cefObserver))
    console.log('ACTUAL CEF PLAYBACK CLOCK:',JSON.stringify(report.cefPlaybackDelta))
    if(report.cefObserver.gpuError)throw Error('Actual CEF GPU query remained unavailable: '+report.cefObserver.gpuError)
  }finally{observer?.close()}
}
async function cefCanvasComparison(){
  report.purpose='same-OBS-source-direct-video-canvas-direct-video-diagnostic-only'
  report.observerEffectCaveat='All three legs attach the same CDP reader; DOM canvas mutation is an explicit test variant, not a shipped fix'
  prepareNumberedMotion()
  report.canvasComparison=[]
  const failures=[]
  for(const [label,canvas] of [['direct-video-first',false],['decoded-video-to-canvas',true],['direct-video-restored',false]]){
    const entry={label,canvas,playback:[]}
    report.canvasComparison.push(entry)
    let observer=null
    canvasContext={canvas,entry,observer:null}
    try{
      const file='render-'+label+'.flv'
      await startReceiver(file)
      assert.equal((await broadcast.start({...ids,mediaIds:['motion']})).phase,'streaming')
      observer=canvasContext.observer
      assert.ok(observer,'Actual CEF observer did not attach during managed preview')
      await output.playAudio(toneWav())
      entry.playback.push(await observer.sample())
      await measure(label,40,async()=>{
        const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
        assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming)
        assert.ok(actual.active&&!actual.reconnecting)
        entry.playback.push(await observer.sample())
      })
      await broadcast.stop(ids.accountId)
      await finishReceiver()
      entry.capture=validateRtmpCapture(join(records,file),{minDuration:35})
      try{entry.numbered=decodeNumberedMotion(join(records,file))}
      catch(error){
        entry.numbered={...(existsSync(join(records,file)+'.numbered.json')?JSON.parse(readFileSync(join(records,file)+'.numbered.json','utf8')):{}),error:String(error)}
        failures.push(error)
      }
      const actual=await getObsSceneInfo(config)
      assert.deepEqual(actual.scenes,original.scenes)
      assert.equal(actual.currentScene,original.currentScene)
      console.log('ACTUAL VIDEO/CANVAS OBSERVATION:',JSON.stringify({...entry,
        numbered:{...entry.numbered,indices:undefined},playbackSamples:entry.playback.length,playback:undefined,observer:undefined}))
    }finally{canvasContext?.observer?.close();canvasContext=null}
  }
  const candidate=report.canvasComparison.find(x=>x.canvas).numbered
  report.canvasCandidateHasThirtySequentialFramesPerSecond=candidate.frames===900&&candidate.distinctSourceFrames===900&&
    candidate.repeatedFrames===0&&candidate.skippedSourceFrames===0&&candidate.backwards===0
  if(!report.canvasCandidateHasThirtySequentialFramesPerSecond)
    failures.push(Error('Canvas candidate did not deliver 900 sequential distinct frames in the actual 30-second decode window'))
  if(failures.length)throw new AggregateError(failures,'Video/canvas experiment retains actual frame failures')
}
function validateImmutableCpuBufferTrace(trace){
  const state=trace.cpuBuffers
  assert.ok(state,'Actual immutable CPU buffer observations unavailable')
  assert.equal(state.policy,'immutable-on-content-change')
  for(const key of ['geometryAllocated','uniformsAllocated','geometryUnchanged','uniformsUnchanged','allocationFailures','overflow'])
    assert.ok(Number.isSafeInteger(state[key])&&state[key]>=0,'Invalid actual CPU buffer counter '+key)
  assert.equal(state.allocationFailures,0,'An actual immutable CPU buffer allocation failed')
  assert.equal(state.overflow,0,'Actual CPU buffer trace overflow')
  assert.equal(state.records.length,state.geometryAllocated+state.uniformsAllocated)
  for(const x of state.records){
    assert.ok(x.kind==='geometry'||x.kind==='uniforms')
    assert.ok(Number.isSafeInteger(x.bytes)&&x.bytes>0)
    assert.ok(Number.isFinite(x.at)&&x.at>0)
    assert.ok(typeof x.current==='string'&&x.current.length>0)
    assert.ok(typeof x.previous==='string')
    if(x.previous)assert.notEqual(x.previous,x.current,'CPU changed a buffer still shared with prior GPU work')
  }
  return {policy:state.policy,geometryAllocated:state.geometryAllocated,uniformsAllocated:state.uniformsAllocated,
    geometryUnchanged:state.geometryUnchanged,uniformsUnchanged:state.uniformsUnchanged}
}
function validateUploadCompletionTrace(trace,requireExecuted=false){
  if(process.env.AI_LIVE_OBS_IMMUTABLE_CPU_BUFFERS==='true')validateImmutableCpuBufferTrace(trace)
  const u=trace.uploads
  assert.ok(u,'Actual upload completion observations unavailable')
  for(const key of ['submitted','cpuWriteMaps','blockingCPUWriteMaps','gpuErrors','cpuWriteWaitNs','otherDrains','overflow'])
    assert.ok(Number.isSafeInteger(u[key])&&u[key]>=0,'Invalid actual upload counter '+key)
  assert.equal(u.gpuErrors,0,'Actual GPU upload failed before CPU buffer reuse')
  assert.equal(u.overflow,0,'Actual upload trace overflow')
  assert.deepEqual(u.columns,['sequence','commitBefore','commitAfter','scheduledAt','mapBefore','mapAfter',
    'gpuStart','gpuEnd','kernelStart','kernelEnd','status','errorCode','forCPUWrite','wallAtEndMs',
    'sourceBufferBytes','textureWidth','textureHeight','texturePixelFormat','textureStorageMode','textureGPUOptimized'])
  assert.deepEqual(u.submitColumns,['sequence','commitBefore','commitAfter','scheduledAt','status','errorCode',
    'sourceBufferBytes','textureWidth','textureHeight','texturePixelFormat','textureStorageMode','textureGPUOptimized'])
  const ids=new Set()
  for(const x of u.submissions){
    assert.equal(x.length,12);assert.ok(x.every(Number.isFinite))
    assert.ok(Number.isSafeInteger(x[0])&&x[0]>0&&!ids.has(x[0]));ids.add(x[0])
    assert.ok(x[2]>=x[1]&&x[3]>=x[2])
    assert.ok(x[4]===3||x[4]===4,'Upload was not scheduled successfully')
    assert.equal(x[5],0)
    assert.ok(x[6]>0&&x[7]>0&&x[8]>0)
  }
  const completed=new Set()
  for(const x of u.records){
    assert.equal(x.length,20);assert.ok(x.every(Number.isFinite))
    assert.ok(ids.has(x[0])&&!completed.has(x[0]));completed.add(x[0])
    assert.equal(x[10],4,'CPU buffer reused before its GPU upload completed')
    assert.equal(x[11],0)
    assert.ok(x[2]>=x[1]&&x[3]>=x[2]&&x[4]>=x[3]&&x[5]>=x[4])
    assert.ok(x[7]>=x[6]&&x[5]+0.000001>=x[7],'Upload buffer access preceded actual GPU completion')
    assert.ok(x[12]===0||x[12]===1)
  }
  assert.equal(u.submissions.length,u.submitted)
  assert.equal(u.records.length,u.cpuWriteMaps+u.otherDrains)
  if(requireExecuted){
    assert.ok(u.submitted>0&&u.cpuWriteMaps>0,'Native CPU upload guard was not actually exercised')
    assert.ok(u.records.some(x=>x[12]===1))
  }
  return {submitted:u.submitted,completed:completed.size,cpuWriteMaps:u.cpuWriteMaps,
    blockingCPUWriteMaps:u.blockingCPUWriteMaps,gpuErrors:u.gpuErrors,otherDrains:u.otherDrains,
    maxWriteReuseWaitMs:u.records.length?Math.max(...u.records.filter(x=>x[12]===1).map(x=>(x[5]-x[4])*1000),0):0}
}
async function setOwnedCopyProbe(enabled,reset=false,gpuOnly=false,queueEnabled=false,deferReadback=false,traceLabel=null){
  assert.equal(process.env.AI_LIVE_OBS_OWNED_COPY_ABA,'true','Unshipped module control is cloud-experiment only')
  const result=await obs('CallVendorRequest',{vendorName:'obs-browser',requestType:'ci_owned_copy',
    requestData:{observeOnly:defaultSourcePolicy,enabled:defaultSourcePolicy?false:enabled,reset,
      gpuOnly:defaultSourcePolicy?false:gpuOnly,queueEnabled:defaultSourcePolicy?false:queueEnabled,
      unlockedCopy:!defaultSourcePolicy&&queueEnabled&&process.env.AI_LIVE_OBS_UNLOCKED_COPY_ABA==='true',
      isolatedCopyQueue:!defaultSourcePolicy&&queueEnabled&&process.env.AI_LIVE_OBS_ISOLATED_COPY_QUEUE==='true',
      cpuSurfaceCopy:!defaultSourcePolicy&&queueEnabled&&process.env.AI_LIVE_OBS_CPU_SURFACE_COPY==='true',
      includeQueueRecords:!reset,readbackProbe:process.env.AI_LIVE_OBS_READBACK_COMPARISON==='true',
      deferReadback,metalLibraryPath:report.copyProvenance?.experimentalMetalPath}})
  const actual=result.responseData
  if(defaultSourcePolicy){
    assert.equal(actual.observeOnly,true)
    assert.equal(actual.sourceFramePolicyVersion,'macos-owned-ordered-v1')
    for(const key of ['enabled','gpuOnly','queueEnabled','unlockedCopy','isolatedCopyQueue','cpuSurfaceCopy'])
      assert.equal(actual[key],false,'Diagnostic functional control armed: '+key)
    assert.equal(actual.readbackModeReadOnly,true,'Observer changed the readback policy')
    assert.equal(actual.deferReadback,deferReadback)
    assert.equal(existsSync('/tmp/ai-live-ci-private-window-target'),false,'Private window still requires test file')
    assert.equal(existsSync('/tmp/ai-live-ci-unoptimized-cpu-upload'),false)
  }
  const cpuSurfaceCopy=queueEnabled&&process.env.AI_LIVE_OBS_CPU_SURFACE_COPY==='true'
  if(process.env.AI_LIVE_OBS_QUEUE_ABA==='true'&&!reset&&ownedCopyContext){
    ownedCopyContext.entry.copyAfter=actual
    const file=ownedCopyContext.entry.label+'-raw-copy-response.json'
    writeFileSync(join(logDir,file),JSON.stringify(actual,null,2))
    ownedCopyContext.entry.rawCopyResponseFile=file
  }
  assert.equal(actual.variant,'isolated-macos-owned-copy-32.2.2','Actual test module control missing')
  assert.equal(actual.isolatedCopyQueue,queueEnabled&&process.env.AI_LIVE_OBS_ISOLATED_COPY_QUEUE==='true')
  assert.equal(actual.cpuSurfaceCopy,defaultSourcePolicy?false:cpuSurfaceCopy)
  for(const key of ['cpuSurfaceCopies','cpuSurfaceBytes','cpuSurfaceLockFailures'])
    assert.ok(Number.isSafeInteger(actual[key])&&actual[key]>=0)
  assert.equal(actual.cpuSurfaceLockFailures,0,'Actual IOSurface CPU lock or unlock failed')
  assert.equal(actual.enabled,defaultSourcePolicy?false:enabled)
  for(const key of ['acceleratedPaints','ownedCopies','copyFailures'])
    assert.ok(Number.isSafeInteger(actual[key])&&actual[key]>=0)
  if(process.env.AI_LIVE_OBS_READBACK_COMPARISON==='true'){
    assert.equal(actual.readbackControlAvailable,true,'Actual Metal readback export missing')
    assert.equal(actual.readbackOwnedCopyGuard,true,'Deferred staging cannot replace the completed CEF shared-surface copy')
    assert.equal(actual.deferReadback,deferReadback)
    for(const key of ['readbackAsyncStages','readbackSyncStages','readbackPendingMaps','readbackBlockingMaps',
      'readbackGpuErrors','readbackSyncWaitNs','readbackMapWaitNs','readbackOtherDrains'])
      assert.ok(Number.isSafeInteger(actual[key])&&actual[key]>=0,'Invalid actual readback metric '+key)
    assert.equal(actual.readbackGpuErrors,0,'Actual readback GPU completion failed')
    if(!reset&&enabled){
      if(deferReadback){
        assert.ok(actual.readbackAsyncStages>0&&actual.readbackPendingMaps>0,'Deferred staging and actual CPU mapping were not executed')
        assert.equal(actual.readbackSyncStages,0,'Candidate still performed synchronous staging')
      }else{
        assert.ok(actual.readbackSyncStages>0,'Synchronous baseline did not stage actual output')
        assert.equal(actual.readbackAsyncStages,0,'Baseline used the candidate readback')
      }
    }
  }
  if(process.env.AI_LIVE_OBS_STALL_TRACE==='true'){
    assert.equal(actual.gpuTimingAvailable,true,'Actual private GPU completion timing export missing')
    assert.equal(actual.readbackTimingAvailable,true,'Actual CPU readback timing export missing')
    if(!reset&&enabled){
      assert.equal(actual.readbackTimingValid,true,'Actual readback trace serialization failed')
      const trace=JSON.parse(actual.readbackTimingJson)
      if(process.env.AI_LIVE_OBS_UPLOAD_COMPLETION_GUARD==='true')
        actual.uploadBufferCompletionSummary=validateUploadCompletionTrace(trace)
      assert.equal(trace.overflow,0,'Actual readback timing trace overflow')
      assert.ok(trace.records.length>0,'Actual output readback completion records missing')
      assert.deepEqual(trace.columns,['commitBefore','commitAfter','mapBefore','mapAfter','gpuStart','gpuEnd',
        'kernelStart','kernelEnd','status','errorCode','forCPU','stageSequence','wallAtEndMs',
        'sourceStorageMode','sourceGPUOptimized','sourceWidth','sourceHeight','sourcePixelFormat'])
      for(const row of trace.records){
        assert.equal(row.length,18);assert.ok(row.every(Number.isFinite),'Invalid actual command-buffer timing')
        assert.ok(row[1]>=row[0]&&row[3]>=row[2]&&row[2]>=row[1])
        assert.equal(row[8],4,'Actual readback command buffer failed')
        assert.equal(row[9],0,'Actual readback GPU error')
        if(process.env.AI_LIVE_OBS_CPU_READBACK_LAYOUT==='true'){
          const privateNV12=process.env.AI_LIVE_OBS_PRIVATE_NV12_LAYOUT==='true'
          assert.equal(row[13],privateNV12?2:0,'Actual output plane storage differs from the selected control')
          assert.equal(row[14],privateNV12?1:0,'Actual output plane optimization differs from the selected control')
          assert.ok((row[15]===1280&&row[16]===720)||(row[15]===640&&row[16]===360),
            'Unexpected actual NV12 readback plane dimensions')
        }
      }
      if(process.env.AI_LIVE_OBS_SUBMISSION_TRACE==='true'){
        const submissions=trace.submissions
        assert.ok(Number.isSafeInteger(submissions.submitted)&&submissions.submitted>0)
        assert.equal(submissions.overflow,0,'Actual GPU submission trace overflowed')
        const ids=new Set()
        for(const x of submissions.records){
          assert.ok(Number.isSafeInteger(x.sequence)&&x.sequence>0&&x.sequence<=submissions.submitted&&!ids.has(x.sequence))
          ids.add(x.sequence)
          assert.ok(['render-composition','render-window','display-fence','present','drawable-blit','cpu-upload'].includes(x.kind))
          for(const key of ['beforeCommit','gpuStart','gpuEnd','kernelStart','kernelEnd','cpuCompleted'])
            assert.ok(Number.isFinite(x[key]),'Invalid actual GPU submission clock')
          assert.equal(x.status,4,'Actual render/presentation command buffer did not complete')
          assert.equal(x.errorCode,0,'Actual render/presentation GPU error')
          assert.ok(x.gpuEnd>=x.gpuStart&&x.cpuCompleted>=x.beforeCommit)
        }
        assert.ok(submissions.records.some(x=>x.kind==='render-composition'),'Actual output-render submission not traced')
        if(process.env.AI_LIVE_OBS_ASYNC_WINDOW_PRESENT==='true'){
          assert.equal(submissions.presentationMode,'serial-cpu-after-gpu-completed')
          assert.ok(submissions.records.some(x=>x.kind==='drawable-blit'&&x.drawableCount>0),'No actual window drawable copied')
          assert.equal(submissions.records.filter(x=>x.kind==='present').length,0,'WindowServer present still attached to the shared GPU command buffer')
          assert.ok(submissions.cpuPresentations.length>0,'No actual serial CPU presentation completed')
          assert.ok(submissions.pendingPresentations>=0&&submissions.maximumDrawableCapacity>0)
          assert.ok(submissions.peakPresentations<=submissions.maximumDrawableCapacity,'CPU presentation work exceeded existing actual drawable-pool capacity')
          const ids=new Set()
          for(const x of submissions.cpuPresentations){
            assert.ok(Number.isSafeInteger(x.sequence)&&x.sequence>0&&!ids.has(x.sequence));ids.add(x.sequence)
            assert.ok([x.beforeWait,x.afterWait,x.afterPresent].every(Number.isFinite))
            assert.ok(x.afterWait>=x.beforeWait&&x.afterPresent>=x.afterWait)
            assert.equal(x.completionStatus,4,'Drawable was presented before actual GPU completion')
            assert.ok([x.gpuStart,x.gpuEnd].every(Number.isFinite)&&x.gpuEnd>=x.gpuStart)
            assert.ok(x.afterWait+0.000001>=x.gpuEnd,'CPU presentation preceded the actual GPU write completion')
            assert.equal(x.errorCode,0);assert.equal(x.presented,x.expected)
          }
          actual.cpuWindowPresentationSummary={completed:submissions.cpuPresentations.length,
            pending:submissions.pendingPresentations,peak:submissions.peakPresentations,capacity:submissions.maximumDrawableCapacity,
            maxCompletionWaitMs:Math.max(...submissions.cpuPresentations.map(x=>(x.afterWait-x.beforeWait)*1000)),
            maxPresentCallMs:Math.max(...submissions.cpuPresentations.map(x=>(x.afterPresent-x.afterWait)*1000))}
        }
        if(process.env.AI_LIVE_OBS_DISPLAY_GENERATION_DEDUP==='true'){
          assert.equal(submissions.displayGenerationDeduplication,true)
          assert.ok(submissions.displayFramesProduced>0&&submissions.unchangedDisplayTicks>0,
            'Actual submitted display frames and unchanged display-link ticks were not observed')
          const seen=new Set(),last=new Map()
          for(const x of submissions.records.filter(x=>x.kind==='drawable-blit').sort((a,b)=>a.sequence-b.sequence)){
            assert.equal(x.frameGenerations.length,x.drawableCount)
            assert.equal(x.swapChainIDs.length,x.drawableCount)
            for(let i=0;i<x.drawableCount;i++){
              const id=x.swapChainIDs[i],generation=x.frameGenerations[i],key=id+':'+generation
              assert.ok(typeof id==='string'&&id.length>0&&Number.isSafeInteger(generation)&&generation>0)
              assert.ok(!seen.has(key),'The same actual display producer generation was copied twice')
              assert.ok(generation>(last.get(id)??0),'Actual display producer generations went backwards')
              seen.add(key);last.set(id,generation)
            }
          }
          assert.ok(seen.size>0,'No actual fresh display frame copied')
          actual.displayGenerationSummary={produced:submissions.displayFramesProduced,
            skippedUnchangedTicks:submissions.unchangedDisplayTicks,distinctQueuedGenerations:seen.size}
        }
        if(process.env.AI_LIVE_OBS_TRACKED_DISPLAY_SYNC==='true'){
          const copies=submissions.records.filter(x=>x.kind==='drawable-blit')
          assert.ok(copies.length>0,'No actual tracked display copy submitted')
          assert.equal(submissions.records.filter(x=>x.kind==='display-fence').length,0,
            'Tracked-window candidate still submitted a separate explicit display fence')
          for(const x of copies){
            assert.equal(x.resourceHazards.length,x.drawableCount)
            for(const pair of x.resourceHazards){
              assert.ok(Array.isArray(pair)&&pair.length===2&&pair.every(Number.isSafeInteger))
              assert.equal(pair[0],2,'Display producer texture is not actually hazard-tracked')
              assert.ok(pair[1]>=0&&pair[1]<=2,'Invalid actual drawable hazard tracking mode')
            }
          }
          if(process.env.AI_LIVE_OBS_EXPECT_WINDOW_STORAGE!==undefined){
            const expected=Number(process.env.AI_LIVE_OBS_EXPECT_WINDOW_STORAGE)
            assert.ok(expected===1||expected===2)
            for(const x of copies){
              assert.equal(x.resourceLayouts.length,x.drawableCount)
              for(const layout of x.resourceLayouts){
                assert.ok(Array.isArray(layout)&&layout.length===7&&layout.every(Number.isSafeInteger))
                assert.equal(layout[0],expected,'Actual window texture storage differs from the selected control')
                assert.equal(layout[1],1,'GPU-only window optimization policy unexpectedly changed')
                assert.ok(layout[2]>0&&layout[3]>0)
                assert.equal(layout[5],2)
              }
            }
            actual.windowStorageSummary={actualStorageMode:expected,copies:copies.length,
              distinctActualLayouts:[...new Set(copies.flatMap(x=>x.resourceLayouts.map(v=>JSON.stringify(v))))]}
          }
          actual.trackedDisplaySummary={actualCopies:copies.length,sourceHazardTrackingMode:2,
            explicitDisplayFenceSubmissions:0,drawableModes:[...new Set(copies.flatMap(x=>x.resourceHazards.map(p=>p[1])))]}
        }
        actual.gpuSubmissionTraceSummary={submitted:submissions.submitted,completed:submissions.records.length,
          kinds:submissions.records.reduce((out,x)=>(out[x.kind]=(out[x.kind]??0)+1,out),{}),
          maxCommitToGPUStartMs:Math.max(...submissions.records.map(x=>(x.gpuStart-x.beforeCommit)*1000)),
          maxGPUCommandElapsedMs:Math.max(...submissions.records.map(x=>(x.gpuEnd-x.gpuStart)*1000))}
      }
      const queueEvents=JSON.parse(actual.queueRecordsJson)
      let lastReuseValue=0
      for(const event of queueEvents.filter(x=>x.kind==='gpu-copy-wait')){
        const m=event.completionMetrics
        assert.ok(Array.isArray(m)&&m.length===18&&m.every(Number.isFinite),'Actual private copy timing missing')
        assert.ok(m[1]>=m[0]&&m[2]>=m[1]&&m[3]>=m[2])
        assert.equal(m[8],4,'Actual private GPU command buffer failed')
        assert.equal(m[9],0,'Actual private GPU error')
        const isolated=queueEnabled&&process.env.AI_LIVE_OBS_ISOLATED_COPY_QUEUE==='true'
        assert.equal(m[11],isolated?1:0,'Actual Metal queue identity differs from requested isolation')
        if(isolated){
          assert.ok(Number.isSafeInteger(m[12])&&m[12]>lastReuseValue,'Missing monotonic cross-queue reuse event')
          lastReuseValue=m[12]
          assert.equal(m[15],4,'Actual recycled-texture render fence did not complete')
          assert.equal(m[16],0,'Actual recycled-texture fence GPU error')
          assert.ok(m[13]>=0&&m[14]>=m[13]&&m[17]>0,'Invalid actual render-fence timing')
        }
        assert.ok(Math.abs(m[0]-Number(event.gpuStartNs)/1e9)<0.005,'OBS and Metal CPU clock bases differ')
      }
      const cpuEvents=queueEvents.filter(x=>x.kind==='cpu-surface-copy')
      if(cpuSurfaceCopy){
        assert.ok(cpuEvents.length>0,'Actual CPU surface-copy callback was not executed')
        assert.equal(queueEvents.filter(x=>x.kind==='gpu-copy-wait').length,0,'CPU candidate still waited for a private GPU blit')
        assert.equal(cpuEvents.length,actual.cpuSurfaceCopies)
        assert.equal(actual.cpuSurfaceBytes,cpuEvents.reduce((n,x)=>n+x.bytes,0))
        for(const x of cpuEvents){
          if(defaultSourcePolicy)assert.equal(x.defaultSourcePolicy,true,'CPU snapshots came from a diagnostic switch instead of source settings')
          assert.ok(x.contextReleased&&x.ready&&x.freshTexture,'CPU snapshot did not complete into a fresh owned texture')
          assert.equal(x.lockResult,0);assert.equal(x.unlockResult,0)
          assert.equal(x.width,1280);assert.equal(x.height,720);assert.equal(x.bytes,1280*720*4)
          if(process.env.AI_LIVE_OBS_DYNAMIC_CPU_LAYOUT==='true'){
            assert.equal(x.textureLayoutAvailable,true,'Actual snapshot texture layout export missing')
            assert.deepEqual(x.textureLayout,[0,0,1280,720,80,0,1],
              'Actual CPU snapshot must be shared unoptimized BGRA8 shader-read texture, with unchanged exact size')
          }
          if(process.env.AI_LIVE_OBS_TRACKED_DISPLAY_SYNC==='true'){
            assert.equal(x.textureLayoutAvailable,true)
            assert.deepEqual(x.textureLayout,[0,process.env.AI_LIVE_OBS_DYNAMIC_CPU_LAYOUT==='true'?0:1,1280,720,80,0,1],
              'Actual CPU snapshot optimization differs from the requested comparison leg')
          }
          const ns=['beginNs','lockBeginNs','lockDoneNs','copiedNs','reacquiredNs','ns'].map(k=>BigInt(x[k]))
          assert.ok(ns.every((n,i)=>i===0||n>=ns[i-1]),'CPU copy ordering invalid')
        }
      }else assert.equal(cpuEvents.length,0)
      const file=(traceLabel??ownedCopyContext?.entry.label??'static-carousel')+'-readback-timings.json'
      writeFileSync(join(logDir,file),JSON.stringify(trace,null,2))
      delete actual.readbackTimingJson
      actual.readbackTimingFile=file
      actual.readbackTimingCount=trace.records.length
      actual.privateCopyCompletionStateChecked=true
    }
  }
  assert.equal(actual.copyFailures,0,'Actual owned texture copy failed inside CEF callback')
  if(process.env.AI_LIVE_OBS_GPU_COPY_ABA==='true'){
    assert.equal(actual.gpuOnly,defaultSourcePolicy?false:gpuOnly)
    assert.ok(Number.isSafeInteger(actual.gpuCompletedCopies)&&actual.gpuCompletedCopies>=0)
    if(gpuOnly)assert.equal(actual.gpuCopyAvailable,true,'Actual completed Metal blit export unavailable')
    else assert.equal(actual.gpuCompletedCopies,0,'Conservative baseline used GPU-only copy')
  }
  if(process.env.AI_LIVE_OBS_QUEUE_ABA==='true'){
    assert.equal(actual.queueEnabled,defaultSourcePolicy?false:queueEnabled)
    if(process.env.AI_LIVE_OBS_FINAL_CANDIDATE_ONLY==='true'){
      assert.equal(actual.queuePrimingDepth,5,'Actual compiled queue priming differs from the verified candidate')
      assert.equal(actual.queueSparseDeadlineMs,200)
      assert.ok(Number.isSafeInteger(actual.queueSparsePresents)&&actual.queueSparsePresents>=0)
    }
    for(const k of ['queueCopies','queueEnqueued','queuePopped','queueUnderflows','queueOverflows','queueMaxDepth','queueRecordOverflow'])
      assert.ok(Number.isSafeInteger(actual[k])&&actual[k]>=0)
    assert.equal(actual.queueOverflows,0,'Actual snapshot queue exceeded its bound')
    assert.equal(actual.queueRecordOverflow,0,'Raw queue observation overflow')
    if(!queueEnabled)assert.equal(actual.queueCopies,0)
    if(!reset&&ownedCopyContext){
      const events=JSON.parse(actual.queueRecordsJson)
      const queued=new Map(),drawn=new Set(),lastTicks=new Map(),ages=[]
      let ns=0n
      for(const event of events){
        const now=BigInt(event.ns)
        assert.ok(now>=ns);ns=now
        if(event.kind==='enqueue')queued.set(event.sequence,event)
        if(event.kind==='draw'){
          const source=queued.get(event.sequence)
          assert.ok(source&&source.source===event.source,'Draw had no corresponding completed queued callback')
          assert.ok(!drawn.has(event.sequence),'Snapshot consumed more than once')
          assert.ok(event.tick>(lastTicks.get(event.source)??-1),'Queue advanced twice in the same OBS tick')
          assert.equal(source.ns,event.copiedNs)
          assert.equal(now-BigInt(source.ns),BigInt(event.ageNs))
          drawn.add(event.sequence);lastTicks.set(event.source,event.tick)
          ages.push(Number(event.ageNs)/1e6)
        }
      }
      if(queueEnabled){
        assert.ok(ages.length>0,'No actual queued frame drawn')
        assert.equal(actual.queueCopies,cpuSurfaceCopy?actual.cpuSurfaceCopies:actual.gpuCompletedCopies)
        if(cpuSurfaceCopy)assert.equal(actual.gpuCompletedCopies,0,'CPU candidate reported nonexistent private GPU completions')
        assert.equal(actual.queuePopped,drawn.size)
        assert.equal(actual.queueUnderflows,0,'Primed actual snapshot queue ran empty')
      }
      const waits=events.filter(e=>e.kind==='gpu-copy-wait')
      actual.gpuCopyWaitMs={count:waits.length,max:waits.length?Math.max(...waits.map(e=>Number(e.gpuWaitNs)/1e6)):0,
        mean:waits.length?waits.reduce((sum,e)=>sum+Number(e.gpuWaitNs)/1e6,0)/waits.length:0,
        maxGraphicsReacquire:waits.length?Math.max(...waits.map(e=>Number(e.reacquireNs)/1e6)):0}
      if(process.env.AI_LIVE_OBS_UNLOCKED_COPY_ABA==='true'){
        assert.equal(actual.unlockedCopy,defaultSourcePolicy?false:queueEnabled)
        if(queueEnabled){
          assert.ok(cpuSurfaceCopy?actual.cpuSurfaceCopies>0:actual.unlockedCopies>0)
          assert.ok(waits.every(e=>e.unlocked&&e.contextReleased&&e.ready),'Candidate did not actually release its graphics context for successful copies')
        }else assert.ok(waits.every(e=>!e.unlocked))
      }
      const file=ownedCopyContext.entry.label+'-queue-events.json'
      writeFileSync(join(logDir,file),JSON.stringify({actual:{...actual,queueRecordsJson:undefined},events},null,2))
      actual.queueTraceFile=file
      actual.queueCopyToDrawLatencyMs=ages.length?{count:ages.length,min:Math.min(...ages),max:Math.max(...ages),mean:ages.reduce((a,b)=>a+b,0)/ages.length}:null
      delete actual.queueRecordsJson
    }
  }
  return actual
}
async function captureActualCloudWindowPreview(){
  assert.equal(process.env.GITHUB_ACTIONS,'true','Actual window evidence is cloud-only')
  const tool=join(logDir,'inspect-obs-window-preview')
  const compiled=spawnSync('/usr/bin/swiftc',['-O',join(process.cwd(),'scripts/inspect-obs-foreground.swift'),'-o',tool],
    {timeout:120000,maxBuffer:4*1024*1024})
  writeFileSync(join(logDir,'window-preview-helper-compile.log'),String(compiled.stdout??'')+String(compiled.stderr??''))
  assert.ok(!compiled.error&&compiled.status===0,'Cloud window inspector did not compile')
  const activated=spawnSync(tool,[process.env.AI_LIVE_OBS_TEST_PID,'activate'],{timeout:12000,maxBuffer:1024*1024})
  assert.ok(!activated.error&&activated.status===0,'Actual cloud OBS could not be brought to foreground')
  const fresh=spawnSync(tool,[process.env.AI_LIVE_OBS_TEST_PID,'status'],{timeout:12000,maxBuffer:1024*1024})
  assert.ok(!fresh.error&&fresh.status===0)
  const state=JSON.parse(String(fresh.stdout))
  assert.equal(state.targetIsFrontmost,true,'Independent snapshot did not confirm actual OBS foreground')
  const file='actual-obs-window-preview.png'
  const screenshot=spawnSync('/usr/sbin/screencapture',['-x',join(logDir,file)],{timeout:20000,maxBuffer:1024*1024})
  assert.ok(!screenshot.error&&screenshot.status===0&&statSync(join(logDir,file)).size>0)
  const evidence={at:Date.now(),file,foreground:state}
  writeFileSync(join(logDir,'actual-obs-window-preview.json'),JSON.stringify(evidence,null,2))
  return evidence
}

async function fixedPipelineStaticCarousel(label='fixed-pipeline-static-carousel',deferReadback=true){
  assert.equal(process.env.AI_LIVE_OBS_FINAL_CANDIDATE_ONLY,'true')
  assert.equal(ownedCopyContext,null)
  const entry=report.staticCarousel={label,purpose:'Real two-image product carousel regression; static holds are expected and do not replace the separate 900-frame video gate',imageDurationMs:8000,audioReceipts:[]}
  entry.copyBefore=await setOwnedCopyProbe(true,true,true,true,deferReadback,label)
  const file='render-'+label+'.flv'
  await startReceiver(file)
  assert.equal((await broadcast.start({...ids,mediaIds:['image','image2']})).phase,'streaming')
  entry.actualPlaylist=await (await fetch(output.getUrl().replace('index.html','playlist'))).json()
  assert.deepEqual(entry.actualPlaylist.items.map(x=>({id:x.id,kind:x.kind,durationMs:x.durationMs})),
    [{id:'image',kind:'image',durationMs:8000},{id:'image2',kind:'image',durationMs:8000}])
  const audioAt=Date.now()
  await output.playAudio(toneWav())
  entry.audioReceipts.push({requestedAt:audioAt,completedAt:Date.now()})
  await measure(label,22,async()=>{
    const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
    assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming)
    assert.ok(actual.active&&!actual.reconnecting)
  })
  if(process.env.AI_LIVE_OBS_ASYNC_WINDOW_PRESENT==='true')entry.windowPreview=await captureActualCloudWindowPreview()
  entry.copyAfter=await setOwnedCopyProbe(true,false,true,true,deferReadback,label)
  writeFileSync(join(logDir,label+'-raw-copy-response.json'),JSON.stringify(entry.copyAfter,null,2))
  assert.ok((process.env.AI_LIVE_OBS_CPU_SURFACE_COPY==='true'?entry.copyAfter.cpuSurfaceCopies:entry.copyAfter.gpuCompletedCopies)>0&&entry.copyAfter.queueCopies>0)
  const events=JSON.parse(entry.copyAfter.queueRecordsJson)
  const queued=new Map(),drawn=new Set()
  for(const event of events){
    if(event.kind==='enqueue')queued.set(event.sequence,event)
    if(event.kind==='draw'){
      const source=queued.get(event.sequence)
      assert.ok(source&&source.source===event.source)
      assert.ok(!drawn.has(event.sequence))
      assert.equal(event.copiedNs,source.ns)
      assert.equal(BigInt(event.ns)-BigInt(source.ns),BigInt(event.ageNs))
      drawn.add(event.sequence)
    }
  }
  assert.equal(entry.copyAfter.queuePopped,drawn.size)
  assert.equal(events.filter(x=>x.kind==='draw'&&x.sparse===true).length,entry.copyAfter.queueSparsePresents)
  // A static page legitimately has no new snapshot on many ticks; retain these counts without applying the motion-only no-underflow gate.
  entry.staticHoldTicks=entry.copyAfter.queueUnderflows
  entry.copyAfter.queueRecordsJson=undefined
  await broadcast.stop(ids.accountId)
  await finishReceiver()
  entry.capture=validateRtmpCapture(join(records,file),{minDuration:20})
  const sampled=spawnSync('ffmpeg',['-nostdin','-loglevel','error','-i',join(records,file),
    '-map','0:v:0','-vf','fps=2,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],
    {timeout:120000,maxBuffer:1024*1024})
  assert.ok(!sampled.error&&sampled.status===0,'Actual carousel color decode failed: '+String(sampled.stderr))
  const samples=[]
  for(let i=0;i+2<sampled.stdout.length;i+=3){
    const [r,g,b]=sampled.stdout.subarray(i,i+3)
    const color=r>70&&r>g*2&&r>b*2?'red':g>50&&g>r*2&&g>b*2?'green':'other'
    samples.push({second:i/6,r,g,b,color})
  }
  const changes=samples.filter((s,i)=>i===0||s.color!==samples[i-1].color).map(s=>({second:s.second,color:s.color}))
  entry.decodedColorSamples=samples;entry.actualColorChanges=changes
  assert.ok(samples.filter(s=>s.color==='red').length>=6,'First real product image was not visible')
  assert.ok(samples.filter(s=>s.color==='green').length>=6,'Second real product image was not visible')
  const visibleChanges=changes.filter(s=>s.color!=='other').map(s=>s.color).filter((x,i,a)=>i===0||a[i-1]!==x)
  assert.deepEqual(visibleChanges.slice(0,3),['red','green','red'],'Actual product images did not advance and loop')
  const actual=await getObsSceneInfo(config)
  assert.deepEqual(actual.scenes,original.scenes);assert.equal(actual.currentScene,original.currentScene)
  entry.restoredScene=actual
  entry.verified=true
  console.log('PASS actual fixed-pipeline static image carousel:',JSON.stringify({...entry,decodedColorSamples:undefined,copyAfter:{...entry.copyAfter,queueRecordsJson:undefined}}))
  return entry
}
async function setExternalBeginFrameProbe(enabled,reset=false){
  assert.equal(process.env.AI_LIVE_OBS_BEGIN_FRAME_ABA,'true','External clock is an isolated cloud experiment')
  const result=await obs('CallVendorRequest',{vendorName:'obs-browser',requestType:'ci_external_begin_frame',
    requestData:{enabled,reset}})
  const actual=result.responseData
  assert.equal(actual.variant,'isolated-macos-external-begin-frame-32.2.2')
  assert.equal(actual.enabled,enabled)
  for(const key of ['beginFrameRequests','externalBrowsersCreated','creationRejected'])
    assert.ok(Number.isSafeInteger(actual[key])&&actual[key]>=0)
  assert.equal(actual.creationRejected,0,'Actual browser rejected external clock preconditions')
  return actual
}
async function setFrameLifetimeProbe(enabled,reset=false,includeRecords=false){
  assert.equal(process.env.AI_LIVE_OBS_FRAME_LIFETIME_TRACE,'true','Pixel lifetime observation is cloud-only')
  const result=await obs('CallVendorRequest',{vendorName:'obs-browser',requestType:'ci_frame_lifetime',
    requestData:{enabled,reset,includeRecords}})
  const actual=result.responseData
  assert.equal(actual.variant,'isolated-frame-lifetime-pixels-32.2.2')
  assert.equal(actual.enabled,enabled)
  for(const key of ['paintCount','ioErrors','mismatches','overflow','recordCount'])
    assert.ok(Number.isSafeInteger(actual[key])&&actual[key]>=0,'Actual texture trace missing '+key)
  if(includeRecords){
    actual.records=JSON.parse(actual.recordsJson)
    delete actual.recordsJson
    assert.ok(Array.isArray(actual.records))
    assert.equal(actual.records.length,actual.recordCount)
  }
  return actual
}
function summarizeFrameLifetime(trace){
  assert.equal(trace.ioErrors,0,'GPU snapshot allocation/map/format failed')
  assert.equal(trace.overflow,0,'Pixel lifetime trace overflowed')
  const paints=trace.records.filter(r=>r.kind==='paint'),draws=trace.records.filter(r=>r.kind==='render')
  assert.equal(paints.length,trace.paintCount)
  const paintBySequence=new Map(paints.map(p=>[p.paintSequence,p]))
  let lastNs=0n
  for(const record of trace.records){
    const ns=BigInt(record.ns);assert.ok(ns>=lastNs);lastNs=ns
    assert.ok(Number.isSafeInteger(record.tick)&&record.tick>=0)
    if(record.kind==='render'){
      const before=paintBySequence.get(record.paintSequence)
      assert.ok(before,'Draw refers to an unrecorded callback')
      assert.equal(record.expected,before.ordinal)
      assert.equal(record.source,before.source)
      assert.equal(record.surface,before.surface)
      assert.equal(record.mismatch,record.expected>=0&&record.observed>=0&&record.expected!==record.observed)
    }else assert.equal(record.kind,'paint')
  }
  const mismatches=draws.filter(r=>r.mismatch)
  assert.equal(mismatches.length,trace.mismatches)
  assert.ok(paints.length>0&&draws.length>0,'No actual callback/draw pixel observations')
  return {paintCount:paints.length,drawCount:draws.length,mismatchCount:mismatches.length,
    unreadablePaints:paints.filter(p=>p.ordinal<0).length,
    unreadableDraws:draws.filter(p=>p.observed<0).length,
    mismatchExamples:mismatches.slice(0,30)}
}
async function ownedCopyComparison(runPrefix=''){
  report.purpose='UNSHIPPED-third-party-module-owned-texture-copy-ABA-not-product-acceptance'
  report.observerEffectCaveat='All legs use the same read-only observer. Custom OBS plugin, conservative extra GPU completion copy; never an installer or official unmodified OBS result.'
  report.copyProvenance=JSON.parse(readFileSync(join(process.env.AI_LIVE_OBS_COPY_EVIDENCE,'module-provenance.json'),'utf8'))
  const externalClock=process.env.AI_LIVE_OBS_BEGIN_FRAME_ABA==='true'
  const lifetimeTrace=process.env.AI_LIVE_OBS_FRAME_LIFETIME_TRACE==='true'
  const gpuCopy=process.env.AI_LIVE_OBS_GPU_COPY_ABA==='true'
  const queuedCopy=process.env.AI_LIVE_OBS_QUEUE_ABA==='true'
  const readbackComparison=process.env.AI_LIVE_OBS_READBACK_COMPARISON==='true'
  const finalCandidateOnly=process.env.AI_LIVE_OBS_FINAL_CANDIDATE_ONLY==='true'
  const cpuLayoutABA=process.env.AI_LIVE_OBS_CPU_LAYOUT_ABA==='true'
  const candidateDeferredReadback=process.env.AI_LIVE_OBS_SYNC_READBACK_CANDIDATE!=='true'
  if(cpuLayoutABA){assert.ok(finalCandidateOnly);report.cpuInputLayoutStages=[]}
  if(process.env.AI_LIVE_OBS_CPU_SURFACE_COPY==='true')report.copyTransport='Actual accelerated CEF IOSurface locked and CPU copied before callback return into fresh immutable owned Metal textures; no private GPU blit and no cached IOSurface'
  if(gpuCopy){
    assert.equal(externalClock,false)
    assert.equal(lifetimeTrace,false,'Per-draw pixel readback must be disabled in the copy-overhead comparison')
    assert.ok(report.copyProvenance.experimentalMetalPath)
    report.purpose='UNSHIPPED-private-GPU-completed-copy-overhead-ABA'
    report.observerEffectCaveat='Private completed ownership held throughout; conservative GPU-to-CPU stage versus existing Metal GPU-only completed blit versus restored conservative copy. Same source-built app, clock and observer; no pixel lifetime readback. Not alpha.4 package acceptance.'
  }
  if(queuedCopy){
    assert.equal(gpuCopy,true,'Hold the completed GPU-only copy constant')
    assert.equal(lifetimeTrace,false)
    report.purpose=process.env.AI_LIVE_OBS_UNLOCKED_COPY_ABA==='true'?'UNSHIPPED-owned-snapshot-unlocked-GPU-wait-with-bounded-ordering-ABA':'UNSHIPPED-completed-snapshot-bounded-ordering-ABA'
    report.observerEffectCaveat='All legs use private completed GPU snapshots and the same CEF clock. Candidate keeps up to eight actual snapshots, primes after three pending frames and consumes at most one per actual OBS tick. No generated images, readback, audio timestamp changes or cadence reduction. Queue copy-to-draw latency is measured; audiovisual alignment is not accepted by the tone-only checks. The unlocked candidate retains the OBS source and an unpublished private texture, commits prior draws, releases the graphics context only during a completed Metal copy, then reacquires before publishing. Source pending writes are rejected; raw wait and reacquisition timings are retained. This candidate combines lock release and the bounded queue; it is not a one-factor queue comparison.'
  }
  if(lifetimeTrace){
    assert.equal(externalClock,false,'Lifetime probe holds the original browser clock constant')
    report.purpose='UNSHIPPED-shared-surface-pixel-lifetime-ABA-not-performance-acceptance'
    report.lifetimeObserverEffect='All legs copy and wait for a GPU snapshot in each CEF callback, and stage/read the actual draw texture before rendering. This diagnostic changes timing; a negative reproduction cannot exclude the race. Only draw ownership differs. No pixel is fabricated.'
  }
  if(externalClock){
    report.purpose='UNSHIPPED-owned-copy-external-begin-frame-ABA-not-product-acceptance'
    report.clockExperiment='Owned completed copy and Qt message pump held constant; request external BeginFrame once per actual OBS Tick in the candidate only. A request count is not a delivered-frame count.'
  }
  if(readbackComparison){
    assert.ok(gpuCopy&&queuedCopy)
    assert.equal(lifetimeTrace,false)
    report.purpose='UNSHIPPED-output-readback-pipeline-comparison'
    report.observerEffectCaveat='Four stages in the same OBS process: synchronous output readback/latest private texture; deferred readback/latest private texture; deferred readback/ordered private snapshots with unlocked CEF GPU wait; restored synchronous readback/latest. The first two isolate the output readback change. The ordered candidate combines earlier corrections and measures its added latency. CEF shared-surface copying still completes before callback return. CPU maps, buffer reuse and destruction wait for pending copies; async command buffers retain resources. No clock, resolution, frame-rate, ready or audio timestamp change. Tone checks do not establish audiovisual alignment.'
  }
  if(finalCandidateOnly){
    assert.ok(readbackComparison&&queuedCopy&&gpuCopy)
    report.purpose=process.env.AI_LIVE_OBS_CPU_SURFACE_COPY==='true'?'UNSHIPPED-locked-IOSurface-CPU-snapshot-with-original-accelerated-CEF'+(process.env.AI_LIVE_OBS_CPU_READBACK_LAYOUT==='true'?'-and-shared-unoptimized-NV12-readback':''):process.env.AI_LIVE_OBS_STALL_TRACE==='true'?process.env.AI_LIVE_OBS_ISOLATED_COPY_QUEUE==='true'?'UNSHIPPED-event-fenced-isolated-snapshot-queue':'UNSHIPPED-Metal-command-buffer-and-queue-stall-correlation':'UNSHIPPED-final-combined-candidate-prime-five-runtime-verification'
    report.observerEffectCaveat='Focused strict verification of private completed CEF snapshots, unlocked copy wait, deferred output readback and five pending real frames before ordered playback; capacity remains eight. Five is the smallest sufficient value in the prior timestamp replay, not an acceptance result. Same 1280x720/30 calibrated fixture and original browser clock. Unprimed sparse pages present real pending updates after 200ms without fabricating a frame or treating a still image as 30fps video. Record actual latency; no audio timestamp change and no audiovisual alignment claim. Not the canonical alpha.4 package.'
    if(process.env.AI_LIVE_OBS_PRIVATE_NV12_LAYOUT==='true'){
      report.purpose='UNSHIPPED-default-owned-frames-private-GPU-NV12-shared-CPU-staging'
      report.actualReadbackPolicy='R8/RG8 GPU-only private optimized render targets; retained asynchronous GPU copy to the unchanged shared MTLStageBuffer; actual completion required before CPU buffer access, reuse or destruction.'
    }
  }
  prepareNumberedMotion()
  report.ownedCopyComparison=[]
  const failures=[]
  const legs=cpuLayoutABA?
    [['cpu-opt-a-first',true,false,true,true,true,false],
     ['cpu-gpuopt-disabled-b',true,false,true,true,true,true],
     ['cpu-opt-a-restored',true,false,true,true,true,false]]:finalCandidateOnly?
    [[runPrefix+(candidateDeferredReadback?'fixed-pipeline-prime5':'private-window-sync-readback'),true,false,true,true,candidateDeferredReadback]]:readbackComparison?
    [['sync-readback-latest-first',true,false,true,false,false],['deferred-readback-latest',true,false,true,false,true],
      ['deferred-readback-ordered',true,false,true,true,true],['sync-readback-latest-restored',true,false,true,false,false]]:queuedCopy?
    [['owned-gpu-latest-first',true,false,true,false],['owned-gpu-ordered-queue',true,false,true,true],
      ['owned-gpu-latest-restored',true,false,true,false]]:gpuCopy?
    [['owned-cpu-stage-first',true,false,false],['owned-gpu-completed',true,false,true],
      ['owned-cpu-stage-restored',true,false,false]]:externalClock?
    [['owned-copy-internal-clock-first',true,false],['owned-copy-external-clock',true,true],
      ['owned-copy-internal-clock-restored',true,false]]:
    [['original-shared-first',false,false],['callback-owned-copy',true,false],['original-shared-restored',false,false]]
  for(const [label,enabled,externalBeginFrame,gpuOnly=false,queueEnabled=false,deferReadback=false,cpuGPUOptimizationDisabled=false] of legs){
    if(cpuLayoutABA){
      if(cpuGPUOptimizationDisabled)writeFileSync('/tmp/ai-live-ci-unoptimized-cpu-upload','Cloud CPU texture layout control only\\n')
      else rmSync('/tmp/ai-live-ci-unoptimized-cpu-upload',{force:true})
      process.env.AI_LIVE_OBS_DYNAMIC_CPU_LAYOUT=String(cpuGPUOptimizationDisabled)
    }
    const entry={label,enabled,externalBeginFrame,gpuOnly,queueEnabled,deferReadback,cpuGPUOptimizationDisabled,playback:[]}
    report.ownedCopyComparison.push(entry)
    ownedCopyContext={entry,enabled,externalBeginFrame,gpuOnly,queueEnabled,deferReadback,observer:null}
    try{
      const file='render-'+label+'.flv'
      await startReceiver(file)
      assert.equal((await broadcast.start({...ids,mediaIds:['motion']})).phase,'streaming')
      const observer=ownedCopyContext.observer
      assert.ok(observer,'CEF read-only observer not attached')
      await output.playAudio(toneWav())
      entry.playback.push(await observer.sample())
      await measure(label,40,async()=>{
        const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
        assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming)
        assert.ok(actual.active&&!actual.reconnecting)
        entry.playback.push(await observer.sample())
      })
      try{entry.copyAfter=await setOwnedCopyProbe(enabled,false,gpuOnly,queueEnabled,deferReadback)}
      catch(error){
        if(!entry.copyAfter)throw error
        entry.copyProbeError=String(error)
        failures.push(error)
        delete entry.copyAfter.queueRecordsJson
      }
      if(gpuOnly)assert.ok((process.env.AI_LIVE_OBS_CPU_SURFACE_COPY==='true'?entry.copyAfter.cpuSurfaceCopies:entry.copyAfter.gpuCompletedCopies)>0,'No actual completed owned surface copy executed')
      assert.ok(entry.copyAfter.acceleratedPaints>0,'No real accelerated paint callback observed')
      if(enabled)assert.ok(entry.copyAfter.ownedCopies>0,'No actual owned copy executed')
      else assert.equal(entry.copyAfter.ownedCopies,0,'Baseline used the experimental copy unexpectedly')
      if(externalClock){
        entry.clockAfter=await setExternalBeginFrameProbe(externalBeginFrame)
        if(externalBeginFrame){
          assert.ok(entry.clockAfter.externalBrowsersCreated>0,'No actual externally clocked browser was created')
          assert.ok(entry.clockAfter.beginFrameRequests>0,'No real SendExternalBeginFrame call observed')
        }else{
          assert.equal(entry.clockAfter.externalBrowsersCreated,0,'Baseline browser used external clock')
          assert.equal(entry.clockAfter.beginFrameRequests,0,'Baseline sent external frame requests')
        }
      }
      if(lifetimeTrace){
        const trace=await setFrameLifetimeProbe(false,false,true)
        writeFileSync(join(logDir,label+'-texture-lifetime.json'),JSON.stringify(trace,null,2))
        entry.frameLifetime=summarizeFrameLifetime(trace)
        if(enabled&&entry.frameLifetime.mismatchCount)
          failures.push(Error('Owned completed texture changed without an intervening paint callback'))
      }
      await broadcast.stop(ids.accountId)
      await finishReceiver()
      entry.capture=validateRtmpCapture(join(records,file),{minDuration:35})
      try{entry.numbered=decodeNumberedMotion(join(records,file))}
      catch(error){
        entry.numbered={...(existsSync(join(records,file)+'.numbered.json')?JSON.parse(readFileSync(join(records,file)+'.numbered.json','utf8')):{}),error:String(error)}
        failures.push(error)
      }
      const actual=await getObsSceneInfo(config)
      assert.deepEqual(actual.scenes,original.scenes)
      assert.equal(actual.currentScene,original.currentScene)
      entry.restoredScene=actual
      console.log('ACTUAL UNSHIPPED COPY OBSERVATION:',JSON.stringify({...entry,
        numbered:{...entry.numbered,indices:undefined},playback:undefined,observer:undefined,playbackSamples:entry.playback.length}))
    }finally{ownedCopyContext?.observer?.close();ownedCopyContext=null}
    if(cpuLayoutABA){
      let staticResult=null,staticError=null
      try{staticResult=await fixedPipelineStaticCarousel(label+'-static')}
      catch(error){staticError=String(error);failures.push(error)}
      finally{
        if(broadcast.snapshot().phase!=='idle'||visual.snapshot().previewing){
          try{await broadcast.stop(ids.accountId)}catch(error){failures.push(error);staticError??=String(error)}
        }
        if(receiver){
          try{await finishReceiver()}catch(error){failures.push(error);staticError??=String(error)}
        }
      }
      const observed=await getObsSceneInfo(config)
      assert.deepEqual(observed.scenes,original.scenes);assert.equal(observed.currentScene,original.currentScene)
      const numbered=entry.numbered,after=entry.copyAfter
      const phases=report.phases.filter(x=>x.label===label||x.label===label+'-static')
      const strict=!!(numbered&&numbered.frames===900&&numbered.distinctSourceFrames===900&&numbered.repeatedFrames===0&&numbered.skippedSourceFrames===0&&numbered.backwards===0&&
        !entry.copyProbeError&&after&&after.copyFailures===0&&after.queueOverflows===0&&after.queueUnderflows===0&&after.readbackGpuErrors===0&&
        staticResult?.verified&&!staticError&&phases.length===2&&phases.every(x=>x.delta.renderSkippedFrames===0&&x.delta.outputSkippedFrames===0))
      const stage={label,cpuGPUOptimizationDisabled,actualCPUOptimizationExpected:cpuGPUOptimizationDisabled?0:1,
        sameActualOBSPID:report.ownedObsPID,strict,phases:phases.map(x=>({label:x.label,delta:x.delta,elapsedMs:x.elapsedMs})),
        motion:entry,static:staticResult,staticError,restoredScene:observed}
      report.cpuInputLayoutStages.push(stage)
      for(const name of ['actual-obs-window-preview.png','actual-obs-window-preview.json']){
        if(existsSync(join(logDir,name)))copyFileSync(join(logDir,name),join(logDir,label+'-'+name))
      }
      if(staticResult?.windowPreview){
        staticResult.windowPreview.file=label+'-actual-obs-window-preview.png'
        staticResult.windowPreview.statusFile=label+'-actual-obs-window-preview.json'
      }
      console.log('ACTUAL CPU INPUT LAYOUT STAGE:',JSON.stringify({label,cpuGPUOptimizationDisabled,strict,phases:stage.phases,staticError}))
      writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
    }
  }
  if(lifetimeTrace){
    const [first,candidate,last]=report.ownedCopyComparison.map(x=>x.frameLifetime)
    report.frameLifetimeCausalEvidence={
      firstSharedMutation:first.mismatchCount>0,
      ownedTextureStable:candidate.mismatchCount===0,
      restoredSharedMutation:last.mismatchCount>0,
      reversibleSharedSurfaceMutationObserved:first.mismatchCount>0&&candidate.mismatchCount===0&&last.mismatchCount>0,
      caveat:'Positive within-lock pixel changes show the shared draw resource changed after its callback snapshot. Timing was instrumented. This does not prove that every RTMP repetition has this cause.'}
    console.log('ACTUAL PIXEL LIFETIME CAUSAL EVIDENCE:',JSON.stringify(report.frameLifetimeCausalEvidence))
  }
  if(readbackComparison){
    report.readbackCandidateResults=report.ownedCopyComparison.filter(e=>finalCandidateOnly||e.deferReadback).map(e=>({
      label:e.label,queueEnabled:e.queueEnabled,deferReadback:e.deferReadback,
      has900SequentialDistinctFrames:e.numbered.frames===900&&e.numbered.distinctSourceFrames===900&&
        e.numbered.repeatedFrames===0&&e.numbered.skippedSourceFrames===0&&e.numbered.backwards===0,
      copyFailures:e.copyAfter.copyFailures,readbackGpuErrors:e.copyAfter.readbackGpuErrors,
      queueOverflows:e.copyAfter.queueOverflows,queueUnderflows:e.copyAfter.queueUnderflows
    }))
  }
  const candidate=report.ownedCopyComparison.find(x=>finalCandidateOnly?x.queueEnabled:readbackComparison?x.deferReadback&&x.queueEnabled:queuedCopy?x.queueEnabled:gpuCopy?x.gpuOnly:externalClock?x.externalBeginFrame:x.enabled).numbered
  report.ownedCopyHasThirtySequentialFramesPerSecond=candidate.frames===900&&candidate.distinctSourceFrames===900&&
    candidate.repeatedFrames===0&&candidate.skippedSourceFrames===0&&candidate.backwards===0
  if(!report.ownedCopyHasThirtySequentialFramesPerSecond)
    failures.push(Error('Owned-copy candidate did not deliver 900 sequential distinct frames in the actual 30-second decode window'))
  if(finalCandidateOnly&&!cpuLayoutABA){
    try{await fixedPipelineStaticCarousel(runPrefix+'fixed-pipeline-static-carousel',candidateDeferredReadback)}catch(error){report.staticCarouselError=String(error);failures.push(error)}
  }
  if(failures.length)throw new AggregateError(failures,'Unshipped owned-copy probe retains actual frame failures')
}
async function numberedNativeControl(){
  const label='native-numbered-control'
  const entry=report.numberedNativeControl={label,purpose:'Independent same-fixture native output control; never substitutes for product CEF acceptance',sameActualOBSPID:report.ownedObsPID}
  assert.ok(!ownsNativeScene&&!ownsNativeStream)
  assert.equal(broadcast.snapshot().phase,'idle')
  assert.deepEqual((await getObsSceneInfo(config)).scenes,original.scenes)
  assert.deepEqual(await obs('GetVideoSettings'),report.video)
  entry.observerBefore=await setOwnedCopyProbe(false,true,false,false,true,label)
  let error=null
  try{
    await obs('CreateScene',{sceneName:nativeScene})
    ownsNativeScene=true
    await obs('CreateInput',{sceneName:nativeScene,inputName:nativeScene+' media',inputKind:'ffmpeg_source',
      inputSettings:{is_local_file:true,local_file:numberedMotion,looping:true,
        restart_on_activate:true,close_when_inactive:false},sceneItemEnabled:true})
    entry.actualInput=await obs('GetInputSettings',{inputName:nativeScene+' media'})
    assert.equal(entry.actualInput.inputKind,'ffmpeg_source')
    assert.equal(entry.actualInput.inputSettings.local_file,numberedMotion)
    await obs('SetCurrentProgramScene',{sceneName:nativeScene})
    await sleep(1600)
    await startReceiver('render-'+label+'.flv')
    await obs('StartStream')
    ownsNativeStream=true
    for(let n=0;n<30;n++){
      const live=await getObsStreamStatus(config)
      if(live.active&&!live.reconnecting)break
      await sleep(200)
    }
    const live=await getObsStreamStatus(config)
    assert.ok(live.active&&!live.reconnecting,'Native control never actually became active')
    await measure(label,40,async()=>{
      const actual=await getObsStreamStatus(config)
      assert.ok(actual.active&&!actual.reconnecting,'Native control disconnected')
    })
    entry.observerAfter=await setOwnedCopyProbe(false,false,false,false,true,label)
    const actual=entry.observerAfter
    writeFileSync(join(logDir,label+'-raw-copy-response.json'),JSON.stringify(actual,null,2))
    assert.equal(actual.cpuSurfaceCopies,0,'Native control unexpectedly used product CPU snapshots')
    assert.equal(actual.ownedCopies,0)
    assert.ok(actual.readbackAsyncStages>0&&actual.readbackPendingMaps>0)
    assert.equal(actual.readbackGpuErrors,0)
    assert.equal(actual.readbackTimingValid,true)
    const trace=JSON.parse(actual.readbackTimingJson)
    if(process.env.AI_LIVE_OBS_UPLOAD_COMPLETION_GUARD==='true')
      entry.uploadBufferCompletionSummary=validateUploadCompletionTrace(trace,true)
    assert.equal(trace.overflow,0);assert.equal(trace.submissions.overflow,0)
    assert.ok(trace.records.length>0&&trace.submissions.records.length>0)
    for(const row of trace.records){
      assert.equal(row.length,18);assert.ok(row.every(Number.isFinite))
      assert.equal(row[8],4);assert.equal(row[9],0)
      assert.equal(row[13],2);assert.equal(row[14],1)
    }
    for(const x of trace.submissions.records){
      assert.equal(x.status,4);assert.equal(x.errorCode,0)
    }
    for(const x of trace.submissions.cpuPresentations){
      assert.equal(x.completionStatus,4);assert.equal(x.errorCode,0)
      assert.ok(x.afterWait+0.000001>=x.gpuEnd)
    }
    writeFileSync(join(logDir,label+'-readback-timings.json'),JSON.stringify(trace,null,2))
    delete actual.readbackTimingJson;delete actual.queueRecordsJson
    entry.actualGPUCompletionRecords=trace.submissions.records.length
    entry.actualReadbackRecords=trace.records.length
    entry.captureVerified=false
  }catch(e){error=e;entry.error=String(e)}
  finally{
    if(ownsNativeStream){
      try{
        await obs('StopStream')
        for(let n=0;n<40&&(await getObsStreamStatus(config)).active;n++)await sleep(250)
        assert.equal((await getObsStreamStatus(config)).active,false)
        ownsNativeStream=false
      }catch(e){error??=e;entry.stopError=String(e)}
    }
    if(receiver){
      try{await finishReceiver()}catch(e){error??=e;entry.receiverError=String(e)}
    }
    try{
      entry.capture=validateRtmpCapture(join(records,'render-'+label+'.flv'),{minDuration:35})
      entry.numbered=decodeNumberedMotion(join(records,'render-'+label+'.flv'))
      entry.captureVerified=true
    }catch(e){error??=e;entry.captureError=String(e)}
    if(ownsNativeScene){
      try{await cleanupNativeScene()}catch(e){error??=e;entry.cleanupError=String(e)}
    }
    if(process.env.AI_LIVE_OBS_UPLOAD_COMPLETION_GUARD==='true'&&!ownsNativeScene&&!ownsNativeStream){
      try{
        const afterCleanup=await setOwnedCopyProbe(false,false,false,false,true,label+'-after-cleanup')
        const trace=JSON.parse(afterCleanup.readbackTimingJson)
        entry.uploadBufferAfterCleanupSummary=validateUploadCompletionTrace(trace,true)
        writeFileSync(join(logDir,label+'-after-cleanup-readback-timings.json'),JSON.stringify(trace,null,2))
      }catch(e){error??=e;entry.uploadCleanupError=String(e)}
    }
  }
  const n=entry.numbered,phase=report.phases.find(x=>x.label===label)
  entry.strict=!error&&entry.captureVerified&&n?.frames===900&&n.distinctSourceFrames===900&&n.repeatedFrames===0&&n.skippedSourceFrames===0&&n.backwards===0&&
    phase?.delta.renderSkippedFrames===0&&phase.delta.outputSkippedFrames===0
  console.log('ACTUAL NATIVE NUMBERED CONTROL:',JSON.stringify(entry))
  if(error)throw error
  if(!entry.strict)throw Error('Native numbered control did not pass original 900 and whole-phase zero-loss gates')
  return entry
}
async function minimalColorControl(){
  const label='minimal-color-control'
  const entry=report.minimalColorControl={label,purpose:'Static native color only: diagnostic isolation, never product or 900-frame acceptance',sameActualOBSPID:report.ownedObsPID}
  assert.ok(!ownsNativeScene&&!ownsNativeStream&&!receiver)
  const kinds=await obs('GetInputKindList')
  assert.ok(kinds.inputKinds.includes('color_source_v3'),'Actual native color source kind unavailable')
  assert.deepEqual(await obs('GetVideoSettings'),report.video)
  entry.observerBefore=await setOwnedCopyProbe(false,true,false,false,true,label)
  let error=null
  try{
    await obs('CreateScene',{sceneName:nativeScene});ownsNativeScene=true
    await obs('CreateInput',{sceneName:nativeScene,inputName:nativeScene+' media',inputKind:'color_source_v3',
      inputSettings:{color:0xffffffff,width:1280,height:720},sceneItemEnabled:true})
    entry.actualInput=await obs('GetInputSettings',{inputName:nativeScene+' media'})
    assert.ok(['color_source_v3','color_source'].includes(entry.actualInput.inputKind))
    assert.equal(entry.actualInput.inputSettings.color,0xffffffff)
    assert.equal(entry.actualInput.inputSettings.width,1280);assert.equal(entry.actualInput.inputSettings.height,720)
    await obs('SetCurrentProgramScene',{sceneName:nativeScene});await sleep(1600)
    await startReceiver('render-'+label+'.flv')
    await obs('StartStream');ownsNativeStream=true
    for(let i=0;i<30;i++){
      const s=await getObsStreamStatus(config);if(s.active&&!s.reconnecting)break;await sleep(200)
    }
    const live=await getObsStreamStatus(config);assert.ok(live.active&&!live.reconnecting)
    await measure(label,40,async()=>{const s=await getObsStreamStatus(config);assert.ok(s.active&&!s.reconnecting)})
    const actual=entry.observerAfter=await setOwnedCopyProbe(false,false,false,false,true,label)
    writeFileSync(join(logDir,label+'-raw-copy-response.json'),JSON.stringify(actual,null,2))
    assert.equal(actual.cpuSurfaceCopies,0);assert.equal(actual.ownedCopies,0)
    assert.equal(actual.readbackGpuErrors,0);assert.ok(actual.readbackAsyncStages>0&&actual.readbackPendingMaps>0)
    assert.equal(actual.readbackTimingValid,true)
    const trace=JSON.parse(actual.readbackTimingJson)
    writeFileSync(join(logDir,label+'-readback-timings.json'),JSON.stringify(trace,null,2))
    entry.uploadCompletion=validateUploadCompletionTrace(trace)
    assert.equal(trace.uploads.submitted,0,'Minimal color control unexpectedly used CPU texture uploads')
    assert.equal(trace.overflow,0);assert.equal(trace.submissions.overflow,0)
    for(const row of trace.records){assert.equal(row[8],4);assert.equal(row[9],0)}
    for(const row of trace.submissions.records){assert.equal(row.status,4);assert.equal(row.errorCode,0)}
    for(const row of trace.submissions.cpuPresentations){
      assert.equal(row.completionStatus,4);assert.equal(row.errorCode,0);assert.ok(row.afterWait+0.000001>=row.gpuEnd)
    }
    delete actual.readbackTimingJson;delete actual.queueRecordsJson
    entry.actualGPURecords=trace.submissions.records.length
  }catch(e){error=e;entry.error=String(e)}
  finally{
    if(ownsNativeStream)try{
      await obs('StopStream')
      for(let i=0;i<40&&(await getObsStreamStatus(config)).active;i++)await sleep(250)
      assert.equal((await getObsStreamStatus(config)).active,false);ownsNativeStream=false
    }catch(e){error??=e;entry.stopError=String(e)}
    if(receiver)try{await finishReceiver()}catch(e){error??=e;entry.receiverError=String(e)}
    try{
      const file=join(records,'render-'+label+'.flv')
      const p=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height:format=duration','-of','json',file],
        {timeout:120000,maxBuffer:1024*1024})
      assert.ok(!p.error&&p.status===0,String(p.stderr));entry.capture=JSON.parse(String(p.stdout))
      const v=entry.capture.streams.find(x=>x.codec_type==='video')
      assert.ok(v&&v.codec_name==='h264'&&v.width===1280&&v.height===720)
      assert.ok(Number(entry.capture.format.duration)>=35)
      const pixels=spawnSync('ffmpeg',['-nostdin','-v','error','-i',file,'-map','0:v:0','-an',
        '-vf','fps=1,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{timeout:120000,maxBuffer:1024*1024})
      assert.ok(!pixels.error&&pixels.status===0,String(pixels.stderr))
      assert.equal(pixels.stdout.length%3,0);assert.ok(pixels.stdout.length/3>=35)
      assert.ok([...pixels.stdout].every(x=>x>=220),'Actual minimal color recording was not white')
      entry.actualWhiteVideoSamples=pixels.stdout.length/3;entry.captureVerified=true
    }catch(e){error??=e;entry.captureError=String(e)}
    if(ownsNativeScene)try{await cleanupNativeScene()}catch(e){error??=e;entry.cleanupError=String(e)}
  }
  const phase=report.phases.find(x=>x.label===label)
  entry.strict=!error&&entry.captureVerified&&phase?.delta.renderSkippedFrames===0&&phase.delta.outputSkippedFrames===0
  console.log('ACTUAL MINIMAL COLOR CONTROL:',JSON.stringify(entry))
  if(error)throw error
  if(!entry.strict)throw Error('Minimal color control retains actual full-phase render/output failure')
  return entry
}
async function numberedPipelineComparison(){
  assert.ok(defaultSourcePolicy&&process.env.AI_LIVE_OBS_FINAL_CANDIDATE_ONLY==='true')
  assert.equal(process.env.AI_LIVE_OBS_PRIVATE_NV12_LAYOUT,'true')
  const failures=[]
  report.numberedPipelineComparison={purpose:'Same process/source binary/video settings/reference fixture CEF -> native -> restored CEF. A native pass cannot accept a failed product leg.',sameActualOBSPID:report.ownedObsPID,cases:[]}
  async function productCase(prefix){
    let error=null
    try{await ownedCopyComparison(prefix)}catch(e){error=e;failures.push(e)}
    const phases=report.phases.filter(x=>prefix?x.label.startsWith(prefix):['fixed-pipeline-prime5','fixed-pipeline-static-carousel'].includes(x.label))
    const entry={label:prefix?'product-cef-restored':'product-cef-first',sameActualOBSPID:report.ownedObsPID,
      error:error?String(error):null,motion:report.ownedCopyComparison,static:report.staticCarousel,
      phases:phases.map(x=>({label:x.label,elapsedMs:x.elapsedMs,delta:x.delta}))}
    entry.strict=!error&&phases.length===2&&phases.every(x=>x.delta.renderSkippedFrames===0&&x.delta.outputSkippedFrames===0)&&entry.static?.verified&&
      entry.motion.length===1&&entry.motion.every(x=>x.numbered?.frames===900&&x.numbered.distinctSourceFrames===900&&x.numbered.repeatedFrames===0&&
        x.numbered.skippedSourceFrames===0&&x.numbered.backwards===0&&!x.copyProbeError&&x.copyAfter?.copyFailures===0&&
        x.copyAfter.queueOverflows===0&&x.copyAfter.queueUnderflows===0&&x.copyAfter.readbackGpuErrors===0)
    if(!entry.strict&&!error){
      const failure=Error(entry.label+' retains original full-phase or media/copy/queue failure')
      failures.push(failure);entry.error=String(failure)
    }
    report.numberedPipelineComparison.cases.push(entry)
    if(broadcast.snapshot().phase!=='idle'||visual.snapshot().previewing){
      try{await broadcast.stop(ids.accountId)}catch(e){failures.push(e);throw e}
    }
    if(receiver)await finishReceiver()
    const scene=await getObsSceneInfo(config)
    assert.deepEqual(scene.scenes,original.scenes);assert.equal(scene.currentScene,original.currentScene)
    for(const name of ['actual-obs-window-preview.png','actual-obs-window-preview.json']){
      if(existsSync(join(logDir,name)))copyFileSync(join(logDir,name),join(logDir,entry.label+'-'+name))
    }
    if(entry.static?.windowPreview){
      entry.static.windowPreview.file=entry.label+'-actual-obs-window-preview.png'
      entry.static.windowPreview.statusFile=entry.label+'-actual-obs-window-preview.json'
    }
    writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
  }
  await productCase('')
  if(process.env.AI_LIVE_OBS_MINIMAL_GPU_CONTROL==='true'){
    try{
      const control=await minimalColorControl()
      report.numberedPipelineComparison.cases.push({label:'minimal-color-control',result:control})
    }catch(e){
      failures.push(e)
      report.numberedPipelineComparison.cases.push({label:'minimal-color-control',error:String(e),result:report.minimalColorControl})
    }
    assert.ok(!ownsNativeScene&&!ownsNativeStream&&!receiver,'Refuse further controls before actual minimal-source cleanup')
  }
  try{
    const control=await numberedNativeControl()
    report.numberedPipelineComparison.cases.push({label:'native-numbered-control',result:control})
  }catch(e){
    failures.push(e)
    report.numberedPipelineComparison.cases.push({label:'native-numbered-control',error:String(e),result:report.numberedNativeControl})
  }
  assert.ok(!ownsNativeStream&&!ownsNativeScene,'Refuse restored CEF before actual native cleanup')
  await productCase('restored-')
  console.log('ACTUAL NUMBERED PIPELINE COMPARISON:',JSON.stringify({sameActualOBSPID:report.ownedObsPID,
    cases:report.numberedPipelineComparison.cases.map(x=>({label:x.label,error:x.error??null,phases:x.phases,strict:x.strict??x.result?.strict}))}))
  if(failures.length)throw new AggregateError(failures,'All actual CEF/native/restored-CEF failures are retained')
}
async function previewComparison(){
  if(process.env.AI_LIVE_OBS_PRESENTATION_TRACE==='true')return cefPresentationComparison()
  if(process.env.AI_LIVE_OBS_NUMBERED_PIPELINE_ABA==='true')return numberedPipelineComparison()
  if(process.env.AI_LIVE_OBS_OWNED_COPY_ABA==='true')return ownedCopyComparison()
  if(process.env.AI_LIVE_OBS_CEF_CANVAS_VARIANT==='true')return cefCanvasComparison()
  if(process.env.AI_LIVE_OBS_CEF_OBSERVER==='true')return cefPlaybackComparison()
  if(process.env.AI_LIVE_OBS_BROWSER_CADENCE_ABA==='true')return browserCadenceComparison()
  report.purpose='render-preview-and-thread-diagnostic-only'
  const foregroundTool=join(logDir,'inspect-obs-foreground')
  const compile=spawnSync('/usr/bin/swiftc',['-O',
    join(process.cwd(),'scripts/inspect-obs-foreground.swift'),'-o',foregroundTool],
    {timeout:120000,maxBuffer:4*1024*1024})
  writeFileSync(join(logDir,'foreground-helper-compile.log'),
    String(compile.stdout??'')+String(compile.stderr??''))
  assert.ok(!compile.error&&compile.status===0,'Cloud foreground inspector failed to compile')
  const foreground=activate=>{
    const result=spawnSync(foregroundTool,[process.env.AI_LIVE_OBS_TEST_PID,activate?'activate':'status'],
      {timeout:12000,maxBuffer:1024*1024})
    writeFileSync(join(logDir,'foreground-'+(activate?'activate':'status')+'.json'),String(result.stdout??''))
    assert.ok(!result.error&&(result.status===0||(activate&&result.status===1)),
      'Actual cloud OBS foreground helper failed: '+String(result.stderr)+' '+String(result.stdout))
    const state=JSON.parse(String(result.stdout))
    report.foregroundChecks??=[]
    report.foregroundChecks.push({at:Date.now(),helperExitStatus:result.status,...state})
    console.log('ACTUAL OBS FOREGROUND:',JSON.stringify(report.foregroundChecks.at(-1)))
    const screenshot=join(logDir,'foreground-'+(activate?'activate':'status')+'.png')
    const capture=spawnSync('/usr/sbin/screencapture',['-x',screenshot],{timeout:20000,maxBuffer:1024*1024})
    assert.ok(!capture.error&&capture.status===0&&statSync(screenshot).size>0,
      'Actual cloud foreground screenshot failed')
    if(activate){
      // A second process constructs a fresh NSWorkspace snapshot as an independent check.
      const fresh=spawnSync(foregroundTool,[process.env.AI_LIVE_OBS_TEST_PID,'status'],
        {timeout:12000,maxBuffer:1024*1024})
      writeFileSync(join(logDir,'foreground-independent.json'),String(fresh.stdout??''))
      assert.ok(!fresh.error&&fresh.status===0,'Independent foreground read failed: '+String(fresh.stderr))
      report.foregroundIndependent=JSON.parse(String(fresh.stdout))
      assert.equal(report.foregroundIndependent.targetIsFrontmost,true,
        'Independent foreground snapshot did not confirm the existing OBS PID')
      console.log('PASS independent OBS foreground confirmation:',JSON.stringify(report.foregroundIndependent))
    }
    return activate?report.foregroundIndependent:state
  }
  const originalForeground=foreground(false)
  const {hotkeys}=await obs('GetHotkeyList')
  for(const name of ['OBSBasic.DisablePreview','OBSBasic.EnablePreview'])
    assert.ok(hotkeys.includes(name),'Actual OBS does not expose '+name)
  // The isolated profile starts with the official PreviewEnabled=true default.
  // Observe both callbacks rather than assuming a request acknowledgement changed UI state.
  await setPreview(false)
  await setPreview(true)
  if(process.env.AI_LIVE_OBS_NUMBERED_MOTION==='true'){
    report.purpose='numbered-30fps-motion-and-launch-diagnostic-only'
    report.launchMode=process.env.AI_LIVE_MAC_OBS_LAUNCH
    prepareNumberedMotion()
    let foregroundFailure=null
    try{if(!foreground(false).targetIsFrontmost)foreground(true)}
    catch(error){
      foregroundFailure=error
      report.motionForegroundError=String(error)
      console.error('Foreground confirmation failed; preserve failure and continue independent media evidence:',error)
    }
    await startReceiver('render-numbered-motion.flv')
    assert.equal((await broadcast.start({...ids,mediaIds:['motion']})).phase,'streaming')
    const requestedAt=Date.now()
    await output.playAudio(toneWav())
    report.motionAudioReceipt={requestedAt,completedAt:Date.now()}
    await measure('product-numbered-30fps-motion',40,async()=>{
      const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
      assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming,
        'Product session failed during numbered motion')
      assert.ok(actual.active&&!actual.reconnecting,'RTMP disconnected during numbered motion')
    })
    await broadcast.stop(ids.accountId)
    await finishReceiver()
    report.motionCapture=validateRtmpCapture(join(records,'render-numbered-motion.flv'),{minDuration:35})
    const actual=await getObsSceneInfo(config)
    assert.deepEqual(actual.scenes,original.scenes,'Numbered motion leaked a product scene')
    assert.equal(actual.currentScene,original.currentScene,'Numbered motion did not restore original scene')
    // Same calibrated moving source through the native OBS path, in the same
    // process and unchanged canvas/encoder. This cannot replace product evidence.
    await obs('CreateScene',{sceneName:nativeScene})
    ownsNativeScene=true
    await obs('CreateInput',{sceneName:nativeScene,inputName:nativeScene+' media',inputKind:'ffmpeg_source',
      inputSettings:{is_local_file:true,local_file:numberedMotion,looping:false,
        restart_on_activate:true,close_when_inactive:false},sceneItemEnabled:true})
    await obs('SetCurrentProgramScene',{sceneName:nativeScene})
    await sleep(1600)
    await startReceiver('render-numbered-native.flv')
    await obs('StartStream')
    ownsNativeStream=true
    for(let n=0;n<30;n++){
      const live=await getObsStreamStatus(config)
      if(live.active&&!live.reconnecting)break
      await sleep(200)
    }
    await measure('native-numbered-30fps-motion',40,async()=>{
      const actual=await getObsStreamStatus(config)
      assert.ok(actual.active&&!actual.reconnecting,'Native numbered control disconnected')
    })
    await obs('StopStream')
    ownsNativeStream=false
    for(let n=0;n<40&&(await getObsStreamStatus(config)).active;n++)await sleep(250)
    assert.equal((await getObsStreamStatus(config)).active,false,'Native numbered control did not stop')
    await finishReceiver()
    report.numberedNativeCapture=validateRtmpCapture(join(records,'render-numbered-native.flv'),{minDuration:35})
    await cleanupNativeScene()
    const cadenceFailures=foregroundFailure?[foregroundFailure]:[]
    for(const [key,file] of [['numberedMotion','render-numbered-motion.flv'],['numberedNative','render-numbered-native.flv']]){
      const path=join(records,file)
      try{report[key]=decodeNumberedMotion(path)}
      catch(error){
        // Preserve both independent observations, then fail the job. No gate
        // is relaxed when one path exposes backwards frame order.
        report[key]={...JSON.parse(readFileSync(path+'.numbered.json','utf8')),error:String(error)}
        cadenceFailures.push(error)
      }
    }
    if(cadenceFailures.length)throw new AggregateError(cadenceFailures,'Actual numbered frame-order checks failed')
    console.log('PASS product and native numbered-motion evidence captured; inspect raw cadence before any smoothness claim')
    return
  }
  await startReceiver('render-preview-aba.flv')
  assert.equal((await broadcast.start(ids)).phase,'streaming')
  let nextToneAt=Date.now()
  const healthy=async()=>{
    const managed=await broadcast.refresh(),actual=await getObsStreamStatus(config)
    assert.ok(managed.phase==='streaming'&&managed.visualReady&&managed.obsStreaming,
      'Product session failed during preview control: '+JSON.stringify(managed))
    assert.ok(actual.active&&!actual.reconnecting,'RTMP disconnected during preview control')
    if(Date.now()>=nextToneAt){
      const requestedAt=Date.now()
      while(nextToneAt<=requestedAt)nextToneAt+=60000
      await output.playAudio(toneWav())
      report.audioReceipts??=[]
      report.audioReceipts.push({requestedAt,completedAt:Date.now()})
      console.log('PASS periodic diagnostic audio playback completed:',JSON.stringify(report.audioReceipts.at(-1)))
    }
  }
  await healthy()
  for(const [label,enabled] of [['preview-on-first',true],['preview-off',false],['preview-on-restored',true]]){
    if(label!=='preview-on-first')await setPreview(enabled)
    await measure(label,60,healthy)
  }
  if(!originalForeground.targetIsFrontmost){
    foreground(true)
    await healthy()
    await measure('product-foreground-active',60,healthy)
  }
  await broadcast.stop(ids.accountId)
  await finishReceiver()
  report.previewCapture=validateRtmpCapture(join(records,'render-preview-aba.flv'),{minDuration:175})
  const actual=await getObsSceneInfo(config)
  assert.deepEqual(actual.scenes,original.scenes,'Preview comparison leaked a product scene')
  assert.equal(actual.currentScene,original.currentScene,'Preview comparison did not restore original scene')
  console.log('PASS preview A/B/A preserved real product output, audio/video and original scene')
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
  obsProcessLog=resolveActualObsLog()
  report.obsProcessLog=obsProcessLog
  const startupLog=readFileSync(obsProcessLog,'utf8')
  const initialized=startupLog.match(/Initializing (OpenGL|Metal)\.\.\./u)
  assert.ok(initialized,'Actual OBS renderer initialization is absent from its log')
  report.graphics={
    requested:process.env.AI_LIVE_OBS_RENDERER??null,
    actual:initialized[1],
    deviceLines:startupLog.split('\n').filter(line=>
      /Loading up OpenGL on adapter|Initializing (Metal|OpenGL)|- Name\s*:|- Architecture\s*:|- Unified Memory\s*:/u.test(line)),
  }
  if(report.graphics.requested)
    assert.equal(report.graphics.actual,report.graphics.requested,'OBS renderer override did not actually take effect')
  console.log('ACTUAL OBS GRAPHICS:',JSON.stringify(report.graphics))
  const browserAcceleration=startupLog.match(/Browser Hardware Acceleration: (true|false)/u)
  assert.ok(browserAcceleration,'Actual OBS Browser Hardware Acceleration log missing')
  report.browserHardwareAcceleration={requested:process.env.AI_LIVE_OBS_BROWSER_HWACCEL??null,
    actual:browserAcceleration[1]==='true',line:browserAcceleration[0]}
  if(report.browserHardwareAcceleration.requested!==null)
    assert.equal(String(report.browserHardwareAcceleration.actual),report.browserHardwareAcceleration.requested,
      'Requested browser shared hardware path did not actually take effect')
  console.log('ACTUAL BROWSER HARDWARE PATH:',JSON.stringify(report.browserHardwareAcceleration))
  report.version=await obs('GetVersion')
  report.video=await obs('GetVideoSettings')
  const width=report.video.baseWidth,height=report.video.baseHeight
  assert.ok(Number.isInteger(width)&&width>=320&&Number.isInteger(height)&&height>=240,
    'Actual OBS canvas is not valid')
  await obs('SetStreamServiceSettings',{streamServiceType:'rtmp_custom',
    streamServiceSettings:{server:'rtmp://127.0.0.1:1935/live',key:'ci-validation-only',use_auth:false}})
  ff(['-f','lavfi','-i','color=c=red:s=640x360','-frames:v','1',image])
  ff(['-f','lavfi','-i','color=c=green:s=640x360','-frames:v','1',image2])
  ff(['-f','lavfi','-i','color=c=blue:s=640x360:r=20','-t','2.5',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',movie])
  ff(['-f','lavfi','-i','color=c=blue:s='+width+'x'+height+':r=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','11',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',
    '-b:a','128k','-movflags','+faststart',nativeMedia])

  assert.equal((await visual.start(ids)).visualReady,true,'Real product CEF preview did not become ready')
  await visual.stop(ids.accountId)
  if(previewDiagnostic){
    await previewComparison()
  }else{
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
  }
  report.completed=true
  writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
  console.log('PASS real render comparison captured; counters report performance, not a smoothness pass')
}catch(error){
  report.completed=false
  report.error=String(error)
  writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
  console.error('RENDER DIAGNOSTIC FAILED:',error)
  process.exitCode=1
}finally{
  if(process.env.AI_LIVE_OBS_FRAME_LIFETIME_TRACE==='true')
    try{await setFrameLifetimeProbe(false)}catch(error){console.error('Pixel lifetime trace reset:',error);process.exitCode=1}
  if(process.env.AI_LIVE_OBS_BEGIN_FRAME_ABA==='true')
    try{await setExternalBeginFrameProbe(false)}catch(error){console.error('External frame reset:',error);process.exitCode=1}
  if(process.env.AI_LIVE_OBS_OWNED_COPY_ABA==='true')
    try{report.finalExperimentalControlReset=await setOwnedCopyProbe(false,true,false,false,defaultSourcePolicy)}catch(error){console.error('Experimental copy reset:',error);process.exitCode=1}
  if(previewDisabled)try{await setPreview(true)}catch(error){console.error('Preview restore:',error);process.exitCode=1}
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
  if(process.env.AI_LIVE_OBS_CPU_LAYOUT_ABA==='true'){
    rmSync('/tmp/ai-live-ci-unoptimized-cpu-upload',{force:true})
    report.cpuInputSelectorRemoved=!existsSync('/tmp/ai-live-ci-unoptimized-cpu-upload')
  }
  rmSync(dir,{recursive:true,force:true})
  if(process.env.AI_LIVE_OBS_GRACEFUL_EXIT==='true'){
    try{
      assert.equal(process.env.GITHUB_ACTIONS,'true')
      const actualStream=await getObsStreamStatus(config)
      assert.ok(!actualStream.active&&!actualStream.reconnecting,'Cannot quit before actual stream has stopped')
      const actualScene=await getObsSceneInfo(config)
      assert.deepEqual(actualScene.scenes,original.scenes)
      assert.equal(actualScene.currentScene,original.currentScene)
      const pid=Number(process.env.AI_LIVE_OBS_TEST_PID)
      assert.ok(Number.isSafeInteger(pid)&&pid>1)
      const quit=spawnSync('/tmp/ai-live-terminate-owned-obs',[String(pid)],{timeout:20000,maxBuffer:1024*1024})
      writeFileSync(join(logDir,'actual-normal-obs-quit.log'),String(quit.stdout??'')+String(quit.stderr??''))
      assert.ok(!quit.error&&quit.status===0,'Actual owned OBS normal Quit failed: '+String(quit.error??quit.stderr))
      report.gracefulCloudExit=JSON.parse(String(quit.stdout))
      assert.equal(report.gracefulCloudExit.targetPID,pid)
      assert.ok(report.gracefulCloudExit.normalQuitAccepted&&report.gracefulCloudExit.actualTerminated)
    }catch(error){
      report.gracefulCloudExitError=String(error);console.error('Actual normal Quit:',error);process.exitCode=1
    }
  }
  report.finalExitCode=process.exitCode??0
  report.completed=report.completed&&report.finalExitCode===0
  writeFileSync(join(logDir,'render-comparison.json'),JSON.stringify(report,null,2))
}
