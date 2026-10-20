import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VisualPreviewController } from '../electron/main/services/VisualPreviewController.ts'
const options={accountId:'operator',port:4455,password:'safe',mediaIds:['pic','clip']}

function harness(){
  const events=[]
  let ready=false,streaming=false,failScene=false
  const output={
    configure:(account,items)=>events.push(['configure',account,items.map(x=>x.id)]),
    start:async()=>{events.push('http-start');return 'http://127.0.0.1:5678/'+'a'.repeat(48)+'/index.html'},
    stop:async()=>events.push('http-stop'),
    isReady:()=>ready,
  }
  const scenes={
    prepare:async()=>{events.push('scene-prepare');if(failScene)throw new Error('OBS scene rejected');return {sceneName:'Managed',sourceName:'Source',previousScene:'Before'}},
    cleanup:async()=>events.push('scene-cleanup'),
  }
  const preview=new VisualPreviewController(output,scenes,async()=>({active:streaming}))
  return {preview,events,ready:()=>{ready=true},streaming:()=>{streaming=true},fail:()=>{failScene=true}}
}
test('OBS visual preview checks real readiness and does not submit StartStream',async()=>{
  const h=harness()
  const run=h.preview.start(options)
  await new Promise(resolve=>setTimeout(resolve,20))
  h.ready()
  const result=await run
  assert.equal(result.visualReady,true)
  assert.equal(result.previewing,true)
  assert.equal(result.obsScene,'Managed')
  assert.ok(!h.events.includes('StartStream'))
  assert.equal((await h.preview.stop('operator')).previewing,false)
  assert.ok(h.events.includes('scene-cleanup'))
})
test('preview refuses preexisting stream without altering user OBS',async()=>{
  const h=harness();h.streaming()
  await assert.rejects(h.preview.start(options),/正在推流/)
  assert.equal(h.events.includes('scene-prepare'),false)
})
test('preview cannot stop another account and refuses removing an active stream scene',async()=>{
  const h=harness();h.ready();await h.preview.start(options)
  await assert.rejects(h.preview.stop('another'),/账号不匹配/)
  h.streaming()
  await assert.rejects(h.preview.stop('operator'),/已在推流/)
  assert.equal(h.preview.snapshot().previewing,true)
  assert.equal(h.events.includes('scene-cleanup'),false)
})
test('preparation failure rolls back media server and does not retain preview ownership',async()=>{
  const h=harness();h.fail()
  await assert.rejects(h.preview.start(options),/OBS scene rejected/)
  assert.ok(h.events.includes('http-stop'))
  assert.equal(h.preview.snapshot().previewing,false)
})
