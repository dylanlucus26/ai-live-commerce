import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// This is a production renderer business integration test, NOT a real Douyin stream.
// A fake IPC transport injects comments and deterministic DeepSeek responses, while
// React hooks, commerce stores, reply policy and the voice scheduler are REAL.
const HOST = 'http://127.0.0.1:4199'
const server = spawn(process.execPath,
  [path.resolve('node_modules/vite/bin/vite.js'), 'preview',
    '--host', '127.0.0.1', '--port', '4199', '--strictPort'],
  { stdio: ['ignore','pipe','pipe'], env: { ...process.env, NODE_ENV: 'production' } })
let output = ''
server.stdout.on('data', data => { output += String(data).slice(-1000) })
server.stderr.on('data', data => { output += String(data).slice(-1000) })
const delay = ms => new Promise(resolve => setTimeout(resolve,ms))
async function ready() {
  for (let i=0;i<100;i++) {
    if (server.exitCode !== null) throw Error('Vite preview crashed: '+output)
    try { if ((await fetch(HOST)).ok) return } catch {}
    await delay(300)
  }
  throw Error('Preview timeout: '+output)
}
const product = {
  id:'product-a', sku:'SKU-1', name:'经核实的试验茶', price:'39元', stock:'5件',
  highlights:'无添加糖', faq:'关于规格：请以商品页为准', script:'',
}
let browser
let page
const results=[]
try {
  await ready()
  browser = await chromium.launch({headless:true})
  const context=await browser.newContext({viewport:{width:1440,height:900}})
  page=await context.newPage()
  const runtimeErrors=[]
  page.on('pageerror',error=>runtimeErrors.push(error.message))
  page.on('console',message=>{
    if(message.type()==='error' && /Uncaught|React error|Maximum update depth/i.test(message.text()))
      runtimeErrors.push(message.text())
  })
  await page.addInitScript(({ product, appVersion }) => {
    localStorage.setItem('storage-version',appVersion)
    localStorage.setItem('ai-chat-storage',JSON.stringify({
      state:{autoReply:{
        config:{provider:'deepseek',model:'deepseek-chat',modelPreferences:{deepseek:'deepseek-chat'}},
        apiKeys:{deepseek:'e2e-fake-key-no-network'},customBaseURL:'',
      }},version:1,
    }))
    localStorage.setItem('auto-reply',JSON.stringify({
      state:{contexts:{default:{config:{
        comment:{
          keywordReply:{enable:true,rules:[{keywords:['尺码'],contents:['尺码请以商品详情为准']}]},
          aiReply:{enable:true,autoSend:false,prompt:'请根据核实的商品信息回答，禁止虚构。'},
        },
        blockList:[],
      }}}},version:2,
    }))
    localStorage.setItem('voice-commerce-storage',JSON.stringify({
      state:{contexts:{default:{
        products:[product],selectedId:product.id,autoVoice:false,voiceProvider:'mimo',
        voiceRate:1,mimoVoice:'冰糖',mimoStyle:'自然清晰',outputDeviceId:'default',
        pitchGapMs:0,useClonedVoice:false,schedules:[],videoQueue:['slide-1'],autoAdvanceVideo:false,
      }}},version:1,
    }))
    const bus=new Map()
    const metrics={
      sends:[],models:[],speeches:[],cancels:0,listen:[],listenerStops:[],connections:[],streams:[],broadcastPhase:'idle',errors:[],
    }
    let pitchCancelled=false
    let firstObsPitchWaiting=true
    let releaseFirstObsPitch=null
    let obsAudioPlayCount=0
    window.__businessE2E={
      metrics,
      emit(channel,data) { for(const callback of bus.get(channel) ?? []) callback(data) },
      resolveDelay(text) { if(this.delayed) { this.delayed(text);this.delayed=null } },
    }
    window.ipcRenderer={
      on(channel,callback) {
        if(!bus.has(channel)) bus.set(channel,new Set())
        bus.get(channel).add(callback)
        return ()=>bus.get(channel)?.delete(callback)
      },
      send(){},
      invoke:async (channel,...args)=>{
        if(channel==='tasks:liveControl:connect') {metrics.connections.push(args);return true}
        if(channel==='tasks:liveControl:disconnect') return true
        if(channel==='tasks:autoReply:startCommentListener') {metrics.listen.push(args);return true}
        if(channel==='tasks:autoReply:stopCommentListener') {metrics.listenerStops.push(args);return true}
        if(channel==='tasks:autoReply:sendReply') {metrics.sends.push(args);return true}
        if(channel==='tasks:aiChat:normalChat') {
          metrics.models.push(args[0])
          if(JSON.stringify(args[0].messages).includes('延迟测试'))
            return await new Promise(resolve=>{window.__businessE2E.delayed=resolve})
          return '已核实售价39元，具体库存请以商品页面为准'
        }
        if(channel==='voiceCommerce:media:list')return [{id:'slide-1',kind:'image',name:'模拟商品图',mime:'image/png',size:100,url:'app-media://mock'}]
        if(channel==='voiceCommerce:tts:hasKey')return true
        if(channel==='voiceCommerce:stream:obsProfileInfo')return {configured:true,port:4455}
        if(channel==='voiceCommerce:stream:broadcastStatus')return {
          phase:metrics.broadcastPhase,accountId:metrics.broadcastPhase==='idle'?null:'default',
          obsStreaming:metrics.broadcastPhase==='streaming',
          visualReady:metrics.broadcastPhase==='streaming',error:metrics.broadcastPhase==='failed'
            ? 'OBS 模拟断线':null,
        }
        if(channel==='voiceCommerce:stream:oneClickStart') {
          metrics.streams.push('start')
          metrics.broadcastPhase='streaming'
          return {phase:'streaming',accountId:'default',obsStreaming:true,visualReady:true,error:null}
        }
        if(channel==='voiceCommerce:stream:broadcastStop') {
          metrics.streams.push('stop')
          metrics.broadcastPhase='idle'
          return {phase:'idle',accountId:null,obsStreaming:false,visualReady:false,error:null}
        }
        if(channel==='voiceCommerce:stream:audioStatus')return {ready:true,active:false}
        if(channel==='voiceCommerce:stream:audioPlay') {
          obsAudioPlayCount++
          // Play 1 is the preflight greeting; Play 2 is the first scheduled product pitch.
          // Keep pitch active until a real comment interrupts, to validate resumption.
          if(firstObsPitchWaiting && obsAudioPlayCount===2) {
            firstObsPitchWaiting=false
            await new Promise(resolve=>{releaseFirstObsPitch=resolve})
            return true
          }
          await new Promise(resolve=>setTimeout(resolve,35))
          return true
        }
        if(channel==='voiceCommerce:stream:audioCancel') {
          metrics.cancels++
          if(releaseFirstObsPitch){const complete=releaseFirstObsPitch;releaseFirstObsPitch=null;complete()}
          return true
        }
        if(channel==='voiceCommerce:tts:synthesize'){
          metrics.speeches.push(args[0].text)
          return {audioBase64:'UklGRg==',mimeType:'audio/wav'}
        }
        if(channel==='voiceCommerce:clone:has')return false
        if(channel==='voiceCommerce:inventory:name')return null
        if(channel==='app:getProviders')return {deepseek:{name:'DeepSeek',models:['deepseek-chat'],baseURL:'https://api.deepseek.com'}}
        if(channel==='chrome:getPath')return '/e2e/mock/chrome'
        return true
      },
    }
    const synth={
      speak(utterance) {
        const text=utterance.text
        metrics.speeches.push(text)
        if(text.includes('大家好，接下来为大家介绍')) {pitchCancelled=false;return}
        setTimeout(()=>utterance.onend?.(),20)
      },
      cancel(){metrics.cancels++;pitchCancelled=true},
      get speaking(){return !pitchCancelled},
    }
    Object.defineProperty(window,'speechSynthesis',{value:synth,configurable:true})
    window.SpeechSynthesisUtterance=class {constructor(text){this.text=text;this.onend=null;this.onerror=null}}
  },{product,appVersion:'0.2.6'})
  await page.goto(HOST+'/#/',{waitUntil:'domcontentloaded'})
  await page.locator('.live-workbench').waitFor({timeout:25000})
  await page.getByRole('button',{name:/^连接$/}).click()
  await page.getByText('中控台已连接',{exact:false}).first().waitFor({timeout:10000})
  await page.waitForTimeout(250)
  await page.getByRole('button',{name:'开始直播'}).click()
  await page.getByText('OBS 推流中',{exact:false}).first().waitFor({timeout:10000})
  await page.waitForFunction(()=>window.__businessE2E.metrics.listen.length===1,{timeout:10000})
  const firstSpeech=await page.evaluate(()=>window.__businessE2E.metrics.speeches[0])
  assert.match(firstSpeech,/经核实的试验茶/,'Should start confirmed product pitch from real stored product')
  assert.deepEqual(await page.evaluate(()=>window.__businessE2E.metrics.streams),['start'])
  results.push('1. [PASS] operator one-click OBS start (mock) + listener → verified product pitch started')

  function comment(id,content) {
    return {msg_type:'comment',msg_id:id,nick_name:'测试观众A',
      content,time:new Date().toISOString()}
  }
  const emit=async (id,text)=>page.evaluate(payload=>{
    window.__businessE2E.emit('tasks:autoReply:showComment',{accountId:'default',comment:payload})
  },comment(id,text))

  await emit('kw-1','衣服尺码怎么样')
  await page.waitForFunction(()=>window.__businessE2E.metrics.speeches.includes('尺码请以商品详情为准'))
  // The OBS audio relay acknowledges each WAV clip asynchronously before the pitch resumes.
  // Do not infer playback order from the obsolete speechSynthesis test fixture.
  await page.waitForFunction(()=>window.__businessE2E.metrics.speeches
    .filter(text=>text.includes('经核实的试验茶')).length>=2,{timeout:5000})
  const keyword=await page.evaluate(()=>({models:window.__businessE2E.metrics.models.length,
    sends:window.__businessE2E.metrics.sends.length, cancels:window.__businessE2E.metrics.cancels,
    speeches:window.__businessE2E.metrics.speeches.slice(-50)}))
  assert.equal(keyword.models,0,'Keyword match should NOT call AI')
  assert.equal(keyword.sends,0,'AUTO TEXT OFF must never send keyword text to platform')
  assert.ok(keyword.cancels>0,'Reply must interrupt the current pitch')
  assert.ok(keyword.speeches.filter(t=>t.includes('经核实的试验茶')).length>=2,
    'Product pitch must resume after reply')
  results.push('2. [PASS] keyword hit → one local reply + TTS interrupt/resume, NO outbound platform text')

  // Platform events replayed with identical IDs must not produce duplicate replies.
  await emit('kw-1','衣服尺码怎么样')
  await page.waitForTimeout(200)
  const duplicate=await page.evaluate(()=>window.__businessE2E.metrics.speeches.filter(x=>x==='尺码请以商品详情为准').length)
  assert.equal(duplicate,1,'Replayed comment must not generate second reply')
  results.push('3. [PASS] repeated platform event idempotency')

  await emit('ai-1','这个多少钱，还有库存吗')
  await page.waitForFunction(()=>window.__businessE2E.metrics.models.length===1)
  const ai=await page.evaluate(()=>({
    request:window.__businessE2E.metrics.models[0],
    sends:window.__businessE2E.metrics.sends.length,
  }))
  assert.equal(ai.sends,0,'AUTO TEXT OFF must not send generated AI text')
  const system=ai.request.messages.find(item=>item.role==='system')?.content||''
  for(const piece of ['经核实的试验茶','39元','5件','无添加糖','关于规格'])
    assert.ok(system.includes(piece),'Real live LLM system prompt omitted verified product fact: '+piece)
  await page.waitForFunction(()=>window.__businessE2E.metrics.speeches.some(x=>x.includes('已核实售价39元')))
  results.push('4. [PASS] live comment → mock LLM request includes current SKU facts → reply speech; auto-send stays OFF')

  // In-flight AI inference must not emit late reply after stop.
  await emit('late-1','延迟测试')
  await page.waitForFunction(()=>window.__businessE2E.metrics.models.length===2)
  await page.getByRole('button',{name:'结束直播'}).first().click()
  await page.evaluate(()=>window.__businessE2E.resolveDelay('停止后不应播放这条回复'))
  await page.waitForTimeout(350)
  const late=await page.evaluate(()=>({
    spoken:window.__businessE2E.metrics.speeches.some(t=>t.includes('停止后不应播放')),
    sends:window.__businessE2E.metrics.sends.length,
  }))
  assert.equal(late.spoken,false,'Late LLM result must be discarded after stop')
  assert.equal(late.sends,0)
  assert.deepEqual(await page.evaluate(()=>window.__businessE2E.metrics.streams),['start','stop'])
  results.push('5. [PASS] stop OBS and drop model result arriving after stop')

  // Start again and test operator opt-in for text replies with explicit permission.
  await page.getByRole('button',{name:'开始直播'}).click()
  await page.getByLabel('我已确认直播账号具备此类自动文字发送的适当平台许可').check()
  await page.getByLabel('自动发文字',{exact:true}).check()
  await emit('kw-authorized','想问尺码')
  await page.waitForFunction(()=>window.__businessE2E.metrics.sends.length===1)
  const accepted=await page.evaluate(()=>window.__businessE2E.metrics.sends.at(-1))
  assert.equal(accepted[0],'default')
  assert.equal(accepted[1],'尺码请以商品详情为准')
  await emit('kw-authorized','想问尺码')
  await page.waitForTimeout(150)
  assert.equal(await page.evaluate(()=>window.__businessE2E.metrics.sends.length),1)
  assert.deepEqual(await page.evaluate(()=>window.__businessE2E.metrics.streams),['start','stop','start'])
  results.push('6. [PASS] one-click restart + explicit authorized auto-text send exactly once')

  // OBS unexpectedly goes offline. The renderer must fail closed and deactivate
  // listener, automatic platform text sending, and TTS—not silently keep replying.
  const stopsBefore = await page.evaluate(()=>window.__businessE2E.metrics.listenerStops.length)
  await page.evaluate(()=>{window.__businessE2E.metrics.broadcastPhase='failed'})
  await page.waitForFunction(count=>window.__businessE2E.metrics.listenerStops.length>count,
    stopsBefore,{timeout:12000})
  await page.getByText(/OBS 模拟断线/).first().waitFor({timeout:7000})
  const sendsBefore = await page.evaluate(()=>window.__businessE2E.metrics.sends.length)
  await emit('kw-after-failure','衣服尺码怎么样')
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(()=>window.__businessE2E.metrics.sends.length),sendsBefore)
  assert.equal(await page.getByRole('button',{name:'开始直播'}).isEnabled(),true)
  results.push('7. [PASS] OBS output loss disables comment listener, unattended replies and automatic text sending')

  const errorCheck=runtimeErrors.filter(s=>!/AudioContext|speechSynthesis/u.test(s))
  assert.deepEqual(errorCheck,[],'Renderer runtime errors: '+errorCheck.join('; '))
  await mkdir('test-results',{recursive:true})
  await page.screenshot({path:'test-results/business-reply-runtime.png',fullPage:false})
  for(const row of results)process.stdout.write(row+'\n')
  process.stdout.write('RESULT: 7 business integration checks passed (real renderer + mock OBS/AI/MiMo; NO RTMP or real Douyin permissions)\n')
}catch(error){
  const detail=error instanceof Error ? error.stack||error.message : String(error)
  process.stderr.write('BUSINESS INTEGRATION FAILURE:\n'+detail+'\n')
  try{await mkdir('test-results',{recursive:true});await page?.screenshot({path:'test-results/business-reply-FAIL.png'})}catch{}
  process.exitCode=1
}finally{
  await browser?.close()
  server.kill()
}
