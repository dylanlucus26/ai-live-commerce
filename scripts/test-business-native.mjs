import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { _electron } from 'playwright'
import { WebSocketServer } from 'ws'

/** Tests packaged Electron -> real main-process IPC -> local mock servers.
 * NO live Douyin, OBS device, or paid MiMo connections are made.
 */
const executablePath=process.env.ELECTRON_APP_PATH
assert.ok(executablePath && existsSync(executablePath),'Set ELECTRON_APP_PATH to the packed Electron binary')
let app
let httpServer
let obsServer
let obsOutputActive=false
let currentObsScene='正式直播'
let browserSourceUrl=''
let browserLoadError=null
const fakeScenes=['正式直播','商品展示']
let mockCollection='Mock OBS'
const mockCollections=['Mock OBS']
const requested=[]
const events=[]
const json=(value)=>Buffer.from(JSON.stringify(value))
try {
  httpServer=createServer((req,res)=>{
    if(req.method!=='GET'||req.url!=='/inventory'){res.writeHead(404);res.end();return}
    res.writeHead(200,{'content-type':'application/json'})
    res.end(json({products:[
      {sku:'SKU-1',name:'测试茶',price:'39元',stock:'5件'},
      {sku:'SKU-2',name:'另一商品',price:'69元',stock:'已售罄'},
    ]}))
  })
  httpServer.listen(0,'127.0.0.1')
  await once(httpServer,'listening')
  const stockPort=httpServer.address().port

  obsServer=new WebSocketServer({host:'127.0.0.1',port:0})
  await once(obsServer,'listening')
  const obsPort=obsServer.address().port
  obsServer.on('connection',socket=>{
    socket.send(JSON.stringify({op:0,d:{obsWebSocketVersion:'5.2',rpcVersion:1}}))
    socket.on('message',raw=>{
      const packet=JSON.parse(String(raw))
      if(packet.op===1){
        socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}))
        return
      }
      if(packet.op===6){
        requested.push(packet.d)
        // Mock-business layer: exercise the real macOS product bootstrap
        // against simulated OBS collection RPC and app-owned collection files.
        if(packet.d.requestType==='CreateSceneCollection'){
          mockCollection=packet.d.requestData.sceneCollectionName
          mockCollections.push(mockCollection)
          const scenesDir=join(homedir(),'Library','Application Support','obs-studio','basic','scenes')
          mkdirSync(scenesDir,{recursive:true})
          writeFileSync(join(scenesDir,mockCollection+'.json'),JSON.stringify({name:mockCollection,sources:[]}))
        }
        if(packet.d.requestType==='SetCurrentSceneCollection')
          mockCollection=packet.d.requestData.sceneCollectionName
        if(packet.d.requestType==='StartStream') obsOutputActive=true
        if(packet.d.requestType==='StopStream') obsOutputActive=false
        if(packet.d.requestType==='CreateScene') fakeScenes.push(packet.d.requestData.sceneName)
        if(packet.d.requestType==='RemoveScene') {
          const idx=fakeScenes.indexOf(packet.d.requestData.sceneName)
          if(idx>=0)fakeScenes.splice(idx,1)
        }
        if(packet.d.requestType==='SetCurrentProgramScene')
          currentObsScene=packet.d.requestData.sceneName
        if(packet.d.requestType==='CreateInput'&&packet.d.requestData.inputKind==='browser_source'){
          browserSourceUrl=packet.d.requestData.inputSettings.url
          void (async()=>{
            const response=await fetch(browserSourceUrl)
            assert.equal(response.status,200)
            const root=browserSourceUrl.slice(0,-'index.html'.length)
            const manifest=await (await fetch(root+'playlist')).json()
            assert.equal(manifest.items[0].id,'fake-product-png')
            assert.equal((await fetch(root+'media/fake-product-png')).status,200)
            assert.equal((await fetch(root+'ready',{method:'POST'})).status,204)
          })().catch(error=>{browserLoadError=error})
        }
        const data=packet.d.requestType==='GetSceneCollectionList'
          ? {currentSceneCollectionName:mockCollection,sceneCollections:mockCollections}
          : ['GetRecordStatus','GetVirtualCamStatus','GetReplayBufferStatus'].includes(packet.d.requestType)
            ? {outputActive:false}
            : packet.d.requestType==='GetSceneList'
          ? {scenes:fakeScenes.map(sceneName=>({sceneName})),currentProgramSceneName:currentObsScene}
          : packet.d.requestType==='GetInputList'
            ? {inputs:[{inputName:'产品MP4',inputKind:'ffmpeg_source'},
              {inputName:'Mic',inputKind:'wasapi_input_capture'}]}
            : packet.d.requestType==='GetStreamStatus'
              ? {outputActive:obsOutputActive,outputReconnecting:false,outputDuration:obsOutputActive?1000:0}
              : packet.d.requestType==='GetStreamServiceSettings'
                ? {streamServiceType:'rtmp_custom',streamServiceSettings:{
                  key:'redacted-test-key',server:'rtmp://127.0.0.1:1935/live',
                }}
                : {}
        socket.send(JSON.stringify({op:7,d:{
          requestType:packet.d.requestType,requestId:packet.d.requestId,
          requestStatus:{result:true,code:100},responseData:data,
        }}))
      }
    })
  })
  app=await _electron.launch({
    executablePath,timeout:90000,env:{...process.env,ELECTRON_DISABLE_SECURITY_WARNINGS:'true'},
  })
  const page=await app.firstWindow({timeout:90000})
  await page.locator('.live-workbench').waitFor({timeout:40000})

  const inventory=await page.evaluate(port=>
    window.ipcRenderer.invoke('voiceCommerce:inventory:bridge',port),stockPort)
  assert.equal(inventory.length,2)
  assert.deepEqual(inventory[0],{sku:'SKU-1',name:'测试茶',price:'39元',stock:'5件'})
  events.push('1. PASS Electron IPC → real localhost HTTP inventory adapter → SKU/price/stock')

  const scenes=await page.evaluate(port=>
    window.ipcRenderer.invoke('voiceCommerce:obs:scenes',{port,password:''}),obsPort)
  assert.deepEqual(scenes.scenes,['正式直播','商品展示'])
  assert.deepEqual(scenes.mediaInputs,['产品MP4'])
  assert.equal(scenes.currentScene,'正式直播')
  await page.evaluate(port=>window.ipcRenderer.invoke('voiceCommerce:obs:switchScene',
    {port,password:'',sceneName:'商品展示'}),obsPort)
  await page.evaluate(port=>window.ipcRenderer.invoke('voiceCommerce:obs:mediaAction',
    {port,password:'',inputName:'产品MP4',action:'pause'}),obsPort)
  assert.ok(requested.some(x=>x.requestType==='SetCurrentProgramScene'&&x.requestData.sceneName==='商品展示'))
  assert.ok(requested.some(x=>x.requestType==='TriggerMediaInputAction'&&x.requestData.mediaAction==='OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE'))
  assert.ok(!requested.some(x=>/StartStream|StartRecord/.test(x.requestType)))
  events.push('2. PASS Electron IPC → real local OBS WebSocket v5 handshake, scenes, media pause')

  // Actual packaged Electron IPC -> local fake OBS. No outbound RTMP transmission.
  const preflight=await page.evaluate(port=>window.ipcRenderer.invoke('voiceCommerce:stream:preflight',
    {port,password:''}),obsPort)
  assert.equal(preflight.ready,true)
  assert.equal(preflight.serviceConfigured,true)
  const stream=await page.evaluate(port=>window.ipcRenderer.invoke('voiceCommerce:stream:start',
    {accountId:'default',port,password:''}),obsPort)
  assert.equal(stream.phase,'streaming')
  assert.equal(stream.ownedByApp,true)
  await assert.rejects(page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:stream:stop','other')), /账号不匹配/)
  const ended=await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:stream:stop','default'))
  assert.equal(ended.phase,'idle')
  assert.equal(requested.filter(x=>x.requestType==='StartStream').length,1)
  assert.equal(requested.filter(x=>x.requestType==='StopStream').length,1)
  events.push('PASS packaged Electron IPC -> local fake OBS Start/Stop + owner protection (NO RTMP)')

  // Exercise real packaged Electron IPC, loopback bytes and scene lifecycle.
  // Browser Source itself is simulated: this is NOT real OBS rendering or RTMP.
  const dataDir=await app.evaluate(({app})=>app.getPath('userData'))
  const id='default',hash=createHash('sha256').update(id).digest('hex').slice(0,32)
  const mediaFolder=join(dataDir,'media-library',hash)
  mkdirSync(mediaFolder,{recursive:true})
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nhBcAAAAASUVORK5CYII=','base64')
  writeFileSync(join(mediaFolder,'fake-product-png.png'),png)
  writeFileSync(join(mediaFolder,'assets.json'),JSON.stringify([{
    id:'fake-product-png',name:'测试商品图.png',ext:'.png',kind:'image',mime:'image/png',
    size:png.length,createdAt:new Date().toISOString(),
  }]))
  const broadcast=await page.evaluate(port=>window.ipcRenderer.invoke('voiceCommerce:stream:broadcastStart',{
    accountId:'default',port,password:'',mediaIds:['fake-product-png'],
  }),obsPort)
  assert.equal(broadcast.phase,'streaming')
  assert.equal(broadcast.visualReady,true)
  assert.equal(broadcast.obsStreaming,true)
  assert.ok(browserSourceUrl.startsWith('http://127.0.0.1:'))
  assert.equal(browserLoadError,null)
  assert.equal(fakeScenes.some(x=>x.startsWith('AI Live Commerce - ')),true)
  const audioReady=await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:stream:audioStatus'))
  assert.equal(audioReady.ready,true)
  const wav=Buffer.alloc(44)
  wav.write('RIFF',0,'ascii');wav.write('WAVE',8,'ascii')
  const playing=page.evaluate(base64=>window.ipcRenderer.invoke('voiceCommerce:stream:audioPlay',
    {wavBase64:base64}),wav.toString('base64'))
  const root=browserSourceUrl.slice(0,-'index.html'.length)
  let audioId=null
  for(let i=0;i<30;i++){
    const state=await (await fetch(root+'audio/status')).json()
    if(state.id){audioId=state.id;break}
    await new Promise(resolve=>setTimeout(resolve,30))
  }
  assert.ok(audioId,'OBS mock browser must discover queued WAV')
  const wavResponse=await fetch(root+'audio/data/'+audioId,{headers:{Range:'bytes=0-11'}})
  assert.equal(wavResponse.status,206)
  assert.equal((await wavResponse.arrayBuffer()).byteLength,12)
  assert.equal((await fetch(root+'audio/completed/'+audioId,{method:'POST'})).status,204)
  assert.equal(await playing,true)
  const broadcastEnded=await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:stream:broadcastStop','default'))
  assert.equal(broadcastEnded.phase,'idle')
  assert.equal(obsOutputActive,false)
  assert.equal(currentObsScene,'商品展示')
  assert.equal(fakeScenes.some(x=>x.startsWith('AI Live Commerce - ')),false)
  events.push('PASS packaged Electron → fake OBS Browser Source → localhost PNG/WAV → StartStream/StopStream (NO RTMP)')

  // Request a real encrypted-key save and MiMo main process POST through a fake fetch.
  // Does NOT consume credits, request Internet, or expose a real secret.
  const security=await app.evaluate(({safeStorage})=>({
    encryptionAvailable:safeStorage.isEncryptionAvailable(),
  }))
  if(security.encryptionAvailable) {
    // Save once, then connect, inspect, preflight and operate without sending a
    // plaintext OBS password back to React after the first operator approval.
    const ciAccount='ci-native-obs'
    const profilePath=join(dataDir,'obs-profiles',
      createHash('sha256').update(ciAccount).digest('hex').slice(0,24)+'.enc')
    try {
      await assert.rejects(page.evaluate(({id,port})=>window.ipcRenderer.invoke(
        'voiceCommerce:stream:saveObsProfile',id,{port,password:''},false),
        {id:ciAccount,port:obsPort}),/请先确认/)
      assert.equal(await page.evaluate(({id,port})=>window.ipcRenderer.invoke(
        'voiceCommerce:stream:saveObsProfile',id,{port,password:''},true),
        {id:ciAccount,port:obsPort}),true)
      const info=await page.evaluate(id=>window.ipcRenderer.invoke(
        'voiceCommerce:stream:obsProfileInfo',id),ciAccount)
      assert.equal(info.configured,true)
      assert.equal(info.port,obsPort)
      const savedScenes=await page.evaluate(id=>window.ipcRenderer.invoke(
        'voiceCommerce:obs:savedScenes',id),ciAccount)
      assert.deepEqual(savedScenes.scenes,['正式直播','商品展示'])
      const savedPreflight=await page.evaluate(id=>window.ipcRenderer.invoke(
        'voiceCommerce:stream:savedPreflight',id),ciAccount)
      assert.equal(savedPreflight.ready,true)
      assert.equal(await page.evaluate(id=>window.ipcRenderer.invoke(
        'voiceCommerce:obs:savedSwitchScene',id,'正式直播'),ciAccount),true)
      assert.equal(await page.evaluate(id=>window.ipcRenderer.invoke(
        'voiceCommerce:obs:savedMediaAction',id,'产品MP4','pause'),ciAccount),true)
      events.push('PASS saved encrypted OBS profile used by actual Electron IPC without retyping password')
    } finally {
      rmSync(profilePath,{force:true})
    }
    await app.evaluate(()=>{
      globalThis.__businessOldFetch=globalThis.fetch
      globalThis.__businessHttpRequest=null
      globalThis.fetch=async (url,options)=>{
        globalThis.__businessHttpRequest={url,body:JSON.parse(options.body),
          authorization:options.headers.Authorization}
        return new Response(JSON.stringify({choices:[{message:{audio:{
          data:'UklGRg==',
        }}}]}),{
          status:200,headers:{'content-type':'application/json'},
        })
      }
    })
    try {
      await page.evaluate(()=>window.ipcRenderer.invoke(
        'voiceCommerce:tts:saveKey','only-local-business-test-fake-key'))
      const has=await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:tts:hasKey'))
      assert.equal(has,true,'Electron encrypted key save must succeed')
      const synthesized=await page.evaluate(()=>window.ipcRenderer.invoke(
        'voiceCommerce:tts:synthesize',{text:'核实价格39元',voice:'冰糖',style:'友好自然'}))
      assert.equal(synthesized.mimeType,'audio/wav')
      assert.equal(synthesized.audioBase64,'UklGRg==')
      const captured=await app.evaluate(()=>globalThis.__businessHttpRequest)
      assert.equal(captured.url,'https://api.xiaomimimo.com/v1/chat/completions')
      assert.equal(captured.body.model,'mimo-v2.5-tts')
      assert.equal(captured.body.audio.voice,'冰糖')
      assert.equal(captured.body.messages[1].content,'核实价格39元')
      assert.equal(captured.authorization,'Bearer only-local-business-test-fake-key')
      events.push('3. PASS real encrypted MiMo key + main-process HTTP request composition (mocked paid API)')
    } finally {
      await page.evaluate(()=>window.ipcRenderer.invoke('voiceCommerce:tts:clearKey')).catch(()=>{})
      await app.evaluate(()=>{
        if(globalThis.__businessOldFetch)globalThis.fetch=globalThis.__businessOldFetch
        delete globalThis.__businessOldFetch
        delete globalThis.__businessHttpRequest
      })
    }
  } else {
    events.push('3. SKIP encrypted MiMo fixture: safeStorage unavailable in this CI runner')
  }

  mkdirSync('test-results',{recursive:true})
  await page.screenshot({path:'test-results/business-native-services.png'})
  for(const event of events)process.stdout.write(event+'\n')
}catch(error){
  process.stderr.write('REAL ELECTRON SERVICE TEST FAILED: '+(error instanceof Error?error.stack:error)+'\n')
  process.exitCode=1
} finally {
  try{await app?.close()}catch{}
  if(obsServer)await new Promise(resolve=>obsServer.close(resolve))
  if(httpServer)await new Promise(resolve=>httpServer.close(resolve))
}
