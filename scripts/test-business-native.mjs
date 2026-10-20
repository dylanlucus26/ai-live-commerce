import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
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
        const data=packet.d.requestType==='GetSceneList'
          ? {scenes:[{sceneName:'正式直播'},{sceneName:'商品展示'}],
            currentProgramSceneName:'正式直播'}
          : packet.d.requestType==='GetInputList'
            ? {inputs:[{inputName:'产品MP4',inputKind:'ffmpeg_source'},
              {inputName:'Mic',inputKind:'wasapi_input_capture'}]}
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

  // Request a real encrypted-key save and MiMo main process POST through a fake fetch.
  // Does NOT consume credits, request Internet, or expose a real secret.
  const security=await app.evaluate(({safeStorage})=>({
    encryptionAvailable:safeStorage.isEncryptionAvailable(),
  }))
  if(security.encryptionAvailable) {
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
