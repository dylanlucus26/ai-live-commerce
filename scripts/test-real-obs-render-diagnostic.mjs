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
const image=join(dir,'red.png'),movie=join(dir,'blue.mp4'),nativeMedia=join(dir,'native-tone.mp4')
const numberedMotion=join(records,'numbered-motion-input.mp4')
function ff(args){
  const r=spawnSync('ffmpeg',['-nostdin','-loglevel','error','-y',...args],
    {timeout:120000,maxBuffer:8*1024*1024})
  if(r.error||r.status!==0)throw Error('Fixture generation failed: '+String(r.stderr).slice(-2000))
}
const ids={accountId:'render-diagnostic',...config,mediaIds:['image','video']}
const output=new LiveOutputServer((account,id)=>{
  if(account!==ids.accountId)return null
  const path=id==='image'?image:id==='video'?movie:id==='motion'?numberedMotion:null
  return path?{id,kind:id==='image'?'image':'video',mime:id==='image'?'image/png':'video/mp4',
    absolutePath:path,size:statSync(path).size}:null
})
const managedScenes=new ManagedObsSceneController()
const visual=new VisualPreviewController(output,managedScenes,getObsStreamStatus)
let cadenceContext=null
let canvasContext=null
let ownedCopyContext=null
async function startVisualWithCadence(options){
  if(ownedCopyContext)
    ownedCopyContext.entry.copyBefore=await setOwnedCopyProbe(ownedCopyContext.enabled,true)
  const ready=await visual.start(options)
  if(ownedCopyContext){
    ownedCopyContext.observer=await openCefPlaybackObserver(output.getUrl())
    ownedCopyContext.entry.observer=ownedCopyContext.observer.metadata
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
  // Thread sampling happens after timed counters close; raw phase samples remain intact.
  if(previewDiagnostic)captureObsThreads(label)
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
async function setOwnedCopyProbe(enabled,reset=false){
  assert.equal(process.env.AI_LIVE_OBS_OWNED_COPY_ABA,'true','Unshipped module control is cloud-experiment only')
  const result=await obs('CallVendorRequest',{vendorName:'obs-browser',requestType:'ci_owned_copy',
    requestData:{enabled,reset}})
  const actual=result.responseData
  assert.equal(actual.variant,'isolated-macos-owned-copy-32.2.2','Actual test module control missing')
  assert.equal(actual.enabled,enabled)
  for(const key of ['acceleratedPaints','ownedCopies','copyFailures'])
    assert.ok(Number.isSafeInteger(actual[key])&&actual[key]>=0)
  assert.equal(actual.copyFailures,0,'Actual owned texture copy failed inside CEF callback')
  return actual
}
async function ownedCopyComparison(){
  report.purpose='UNSHIPPED-third-party-module-owned-texture-copy-ABA-not-product-acceptance'
  report.observerEffectCaveat='All legs use the same read-only observer. Custom OBS plugin, conservative extra GPU completion copy; never an installer or official unmodified OBS result.'
  report.copyProvenance=JSON.parse(readFileSync(join(process.env.AI_LIVE_OBS_COPY_EVIDENCE,'module-provenance.json'),'utf8'))
  prepareNumberedMotion()
  report.ownedCopyComparison=[]
  const failures=[]
  for(const [label,enabled] of [['original-shared-first',false],['callback-owned-copy',true],['original-shared-restored',false]]){
    const entry={label,enabled,playback:[]}
    report.ownedCopyComparison.push(entry)
    ownedCopyContext={entry,enabled,observer:null}
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
      entry.copyAfter=await setOwnedCopyProbe(enabled)
      assert.ok(entry.copyAfter.acceleratedPaints>0,'No real accelerated paint callback observed')
      if(enabled)assert.ok(entry.copyAfter.ownedCopies>0,'No actual owned copy executed')
      else assert.equal(entry.copyAfter.ownedCopies,0,'Baseline used the experimental copy unexpectedly')
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
  }
  const candidate=report.ownedCopyComparison.find(x=>x.enabled).numbered
  report.ownedCopyHasThirtySequentialFramesPerSecond=candidate.frames===900&&candidate.distinctSourceFrames===900&&
    candidate.repeatedFrames===0&&candidate.skippedSourceFrames===0&&candidate.backwards===0
  if(!report.ownedCopyHasThirtySequentialFramesPerSecond)
    failures.push(Error('Owned-copy candidate did not deliver 900 sequential distinct frames in the actual 30-second decode window'))
  if(failures.length)throw new AggregateError(failures,'Unshipped owned-copy probe retains actual frame failures')
}
async function previewComparison(){
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
  if(process.env.AI_LIVE_OBS_OWNED_COPY_ABA==='true')
    try{await setOwnedCopyProbe(false)}catch(error){console.error('Experimental copy reset:',error);process.exitCode=1}
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
  rmSync(dir,{recursive:true,force:true})
}
