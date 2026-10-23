import assert from 'node:assert/strict'
import { _electron } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { getObsSceneInfo, getObsStreamStatus, getObsStreamServiceInfo } from '../electron/main/services/ObsService.ts'

/**
 * Actual packaged Electron GUI, actual OBS Studio and actual localhost RTMP.
 * ONLY the Douyin connection/comment task and paid MiMo HTTP response are simulated.
 * The renderer's buttons, Electron main-process streaming IPC, OBS Browser Source,
 * WAV decoding and OBS StartStream/StopStream all execute for real.
 */
const executablePath = process.env.ELECTRON_APP_PATH
const recordingDir = process.env.AI_LIVE_RTMP_RECORD_DIR
const password = process.env.AI_LIVE_OBS_TEST_PASSWORD
assert.ok(executablePath && existsSync(executablePath), 'Packaged Electron exe missing')
assert.ok(recordingDir && password, 'Local RTMP receiver and CI OBS credentials required')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Refuse live-button simulation outside disposable GitHub runner')
const config = {port:4455,password}
const accountId = 'default'
const accountHash = createHash('sha256').update(accountId).digest('hex').slice(0,32)
const imageId = 'ci-live-pic'
const videoId = 'ci-live-vid'
const pause = ms => new Promise(r=>setTimeout(r,ms))
const resultDir='test-results/real-obs-windows'
mkdirSync(resultDir,{recursive:true})

function ff(exe,args,max=100000){
  const res=spawnSync(exe,args,{timeout:max,maxBuffer:48*1024*1024})
  if(res.error||res.status!==0)
    throw Error(exe+' '+args.slice(0,5).join(' ')+' failed: '+String(res.stderr).slice(-3000))
  return res.stdout
}
function makeWave(){
  const rate=24000,seconds=1.2,samples=Math.round(rate*seconds)
  const b=Buffer.alloc(44+samples*2)
  b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVE',8)
  b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20)
  b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28)
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40)
  for(let i=0;i<samples;i++){
    const fade=Math.min(1,i/600,(samples-i)/600)
    b.writeInt16LE(Math.round(fade*10000*Math.sin(i*2*Math.PI*440/rate)),44+i*2)
  }
  return b.toString('base64')
}
const wavBase64=makeWave()
let app
let appData
let installedHandlers=false
try {
  const preexisting=await getObsStreamStatus(config)
  assert.equal(preexisting.active,false,'Do not interfere with existing OBS streaming')
  const service=await getObsStreamServiceInfo(config)
  assert.equal(service.configured,true,'OBS localhost RTMP service is not configured')
  const originalScenes=await getObsSceneInfo(config)
  assert.ok(originalScenes.currentScene,'Real OBS has no original scene')

  app=await _electron.launch({
    executablePath,timeout:90000,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},
  })
  const page=await app.firstWindow({timeout:90000})
  await page.locator('.live-workbench').waitFor({timeout:45000})
  appData=await app.evaluate(({app})=>app.getPath('userData'))

  // Enforce an absolute, fail-closed network boundary before UI interaction.
  // This disables actual platform logins, comment listening and auto-text tasks.
  const installed=await app.evaluate(({ipcMain},wav)=>{
    const channels=[
      'tasks:liveControl:connect',
      'tasks:autoReply:startCommentListener',
      'tasks:autoReply:stopCommentListener',
      'tasks:autoReply:sendReply',
      'tasks:liveControl:disconnect',
    ]
    // Electron ipcMain exposes handle/removeHandler but not hasHandler.
    // This test replaces only the five explicitly named platform task handlers;
    // production OBS streaming IPC is left intact and continues to be real.
    if(typeof ipcMain.handle!=='function'||typeof ipcMain.removeHandler!=='function')
      throw Error('Electron ipcMain handle/removeHandler API unavailable')
    globalThis.__nativeUiE2E={calls:[],tts:[]}
    for(const channel of channels){
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel,(_event,...args)=>{
        globalThis.__nativeUiE2E.calls.push({channel,args})
        if(channel==='tasks:autoReply:sendReply')
          throw Error('Automated real-platform reply forbidden in CI')
        return true
      })
    }
    const originalFetch=globalThis.fetch
    globalThis.__nativeUiE2E.originalFetch=originalFetch
    globalThis.fetch=async(input,init)=>{
      const url=typeof input==='string'?input:String(input?.url??input)
      if(url==='https://api.xiaomimimo.com/v1/chat/completions'){
        const body=JSON.parse(init.body)
        globalThis.__nativeUiE2E.tts.push({
          model:body.model,text:body.messages?.at(-1)?.content,voice:body.audio?.voice,
        })
        return new Response(JSON.stringify({choices:[{message:{audio:{data:wav}}}]}),{
          status:200,headers:{'content-type':'application/json'},
        })
      }
      if(/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/u.test(url))
        return originalFetch(input,init)
      throw Error('External network forbidden in offline native OBS test: '+url.split('?')[0])
    }
    return channels.length
  },wavBase64)
  assert.equal(installed,5)
  installedHandlers=true

  // Import fixture files exactly as persisted imported media is stored.
  // These are real colored image and H.264 video files (not UI placeholders).
  const mediaDir=join(appData,'media-library',accountHash)
  mkdirSync(mediaDir,{recursive:true})
  const image=join(mediaDir,imageId+'.png')
  const video=join(mediaDir,videoId+'.mp4')
  ff('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i',
    'color=c=red:s=640x360','-frames:v','1',image])
  ff('ffmpeg',['-loglevel','error','-y','-f','lavfi','-i',
    'color=c=blue:s=640x360:r=20','-t','2','-c:v','libx264',
    '-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',video])
  writeFileSync(join(mediaDir,'assets.json'),JSON.stringify([
    {id:imageId,name:'实机商品红图.png',ext:'.png',kind:'image',mime:'image/png',
      size:statSync(image).size,createdAt:new Date().toISOString()},
    {id:videoId,name:'实机商品蓝视频.mp4',ext:'.mp4',kind:'video',mime:'video/mp4',
      size:statSync(video).size,createdAt:new Date().toISOString()},
  ]))

  const product={id:'real-obs-product',sku:'CI-LOCAL',name:'离线验收商品',
    price:'39元',stock:'5件',highlights:'可播放素材',
    faq:'这里只使用合成音频，绝不连接抖音平台',
    script:'这是一个隔离环境中的实际安装软件直播测试。',
  }
  await page.evaluate(({product,imageId,videoId})=>{
    localStorage.setItem('ai-chat-storage',JSON.stringify({
      state:{autoReply:{
        config:{provider:'deepseek',model:'deepseek-chat',
          modelPreferences:{deepseek:'deepseek-chat'}},
        apiKeys:{deepseek:'only-ci-fake-llm-key'},customBaseURL:'',
      }},version:1,
    }))
    localStorage.setItem('voice-commerce-storage',JSON.stringify({
      state:{contexts:{default:{
        products:[product],selectedId:product.id,autoVoice:false,voiceProvider:'mimo',
        voiceRate:1,mimoVoice:'冰糖',mimoStyle:'自然清晰',outputDeviceId:'default',
        pitchGapMs:1500,useClonedVoice:false,schedules:[],
        videoQueue:[imageId,videoId],autoAdvanceVideo:false,
      }}},version:1,
    }))
  },{product,imageId,videoId})
  await page.evaluate(({port,password})=>window.ipcRenderer.invoke(
    'voiceCommerce:stream:saveObsProfile','default',{port,password},true),config)
  await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:tts:saveKey','offline-local-ci-only-fake-key'))
  await page.reload({waitUntil:'domcontentloaded'})
  await page.locator('.live-workbench').waitFor({timeout:30000})
  const files=await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:media:list','default'))
  assert.deepEqual(files.map(f=>f.id).sort(),[imageId,videoId].sort())
  const ttsConfigured=await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:tts:hasKey'))
  assert.equal(ttsConfigured,true)

  // First test actual native GUI local rehearsal. It MUST NOT log in, send
  // comments or issue OBS StartStream.
  await page.getByRole('button',{name:'本地演练'}).click()
  await page.getByText('本机演练中',{exact:true}).waitFor({timeout:60000})
  assert.equal((await getObsStreamStatus(config)).active,false,
    'Local rehearsal unexpectedly opened a real RTMP stream')
  const callsAfterRehearsal=await app.evaluate(()=>globalThis.__nativeUiE2E.calls)
  assert.equal(callsAfterRehearsal.length,0,'Local rehearsal contacted a live platform')
  await page.screenshot({path:join(resultDir,'real-packaged-local-rehearsal.png')})
  await page.getByRole('button',{name:'结束直播'}).click()
  await page.getByText(/本机演练已停止/).waitFor({timeout:30000})
  assert.deepEqual((await getObsSceneInfo(config)).scenes,originalScenes.scenes)
  console.log('PASS packaged native Electron local-rehearsal button: real OBS browser, audio, no RTMP or platform calls')

  // The main UI click now passes through real Electron IPC, OBS WebSocket, and
  // actual local FFmpeg RTMP receiver. Only platform and paid TTS are stubbed.
  await page.getByRole('button',{name:'开始直播'}).click()
  await page.getByText('OBS 推流中',{exact:true}).waitFor({timeout:60000})
  const inStream=await getObsStreamStatus(config)
  assert.equal(inStream.active,true,'Main UI click never caused OBS StartStream')
  await pause(15000)
  assert.equal((await getObsStreamStatus(config)).active,true)
  await page.screenshot({path:join(resultDir,'real-packaged-main-start.png')})
  const beforeStop=await app.evaluate(()=>({
    tts:globalThis.__nativeUiE2E.tts,
    calls:globalThis.__nativeUiE2E.calls,
  }))
  assert.ok(beforeStop.tts.length>=2,'Real packaged UI did not issue opening and live TTS')
  assert.ok(beforeStop.calls.some(c=>c.channel==='tasks:liveControl:connect'))
  assert.ok(beforeStop.calls.some(c=>c.channel==='tasks:autoReply:startCommentListener'))
  assert.ok(beforeStop.calls.every(c=>c.channel!=='tasks:autoReply:sendReply'))

  await page.getByRole('button',{name:'结束直播'}).click()
  await page.getByText(/OBS 推流已停止/).waitFor({timeout:30000})
  assert.equal((await getObsStreamStatus(config)).active,false)
  const recovered=await getObsSceneInfo(config)
  assert.deepEqual(recovered.scenes,originalScenes.scenes)
  assert.equal(recovered.currentScene,originalScenes.currentScene)
  assert.ok((await app.evaluate(()=>globalThis.__nativeUiE2E.calls))
    .some(c=>c.channel==='tasks:autoReply:stopCommentListener'))
  console.log('PASS packaged native GUI: Start Live → actual OBS/RTMP/audio → Stop Live → scene cleanup')

  // The RTMP receiver records the actual Electron-triggered live stream.
  const recorded=join(recordingDir,'actual-obs-packaged-ui.flv')
  for(let n=0;n<35&&!existsSync(recorded);n++)await pause(250)
  assert.ok(existsSync(recorded),'Actual packaged UI RTMP capture missing')
  const meta=JSON.parse(ff('ffprobe',['-v','error','-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height','-of','json',recorded]).toString())
  const videoTrack=meta.streams.find(x=>x.codec_type==='video')
  const audioTrack=meta.streams.find(x=>x.codec_type==='audio')
  assert.ok(videoTrack&&audioTrack,'Packaged GUI produced incomplete RTMP tracks')
  assert.ok(Number(meta.format.duration)>10,'Packaged GUI captured too few seconds')
  const pcm=ff('ffmpeg',['-loglevel','error','-i',recorded,'-map','0:a:0',
    '-ar','8000','-ac','1','-f','s16le','pipe:1'])
  let peak=0
  for(let i=0;i+1<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)))
  assert.ok(peak>300,'Packaged GUI real RTMP audio was silent')
  console.log('PASS actual packaged GUI RTMP media tracks:',
    JSON.stringify({duration:meta.format.duration,video:videoTrack.codec_name,
      audio:audioTrack.codec_name,peak,ttsRequests:beforeStop.tts.length}))
}catch(error){
  console.error('PACKAGED GUI / REAL OBS TEST FAILURE:',error)
  process.exitCode=1
}finally{
  if(app){
    try{
      await app.evaluate(async ({ipcMain})=>{
        if(globalThis.__nativeUiE2E?.originalFetch)globalThis.fetch=globalThis.__nativeUiE2E.originalFetch
      })
    }catch{}
    try{
      await app.firstWindow().then(async page=>{
        await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:stream:broadcastStop','default')).catch(()=>{})
        await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:tts:clearKey')).catch(()=>{})
      })
    }catch{}
    try{await app.close()}catch{}
  }
  if(appData&&installedHandlers){
    // The official CI host is ephemeral. Do not touch operator files.
    rmSync(join(appData,'media-library',accountHash),{recursive:true,force:true})
  }
}
