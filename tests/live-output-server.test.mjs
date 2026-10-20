import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LiveOutputServer } from '../electron/main/services/LiveOutputServer.ts'

test('local output accepts media IDs, serves protected playlist and byte range', async t => {
  const dir=mkdtempSync(join(tmpdir(),'ai-live-test-'))
  const picture=join(dir,'product.png'),movie=join(dir,'item.mp4')
  writeFileSync(picture,Buffer.from([137,80,78,71,9,8,7]))
  writeFileSync(movie,Buffer.from('0123456789'))
  const map=new Map([
    ['pic',{id:'pic',kind:'image',mime:'image/png',absolutePath:picture,size:7}],
    ['clip',{id:'clip',kind:'video',mime:'video/mp4',absolutePath:movie,size:10}],
  ])
  const output=new LiveOutputServer((account,id)=>account==='owner'?map.get(id)??null:null)
  t.after(async()=>{await output.stop();rmSync(dir,{recursive:true,force:true})})
  output.configure('owner',[{id:'pic',durationMs:4000},{id:'clip'}])
  const url=await output.start()
  assert.equal(await output.start(),url)
  assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/index\.html$/)
  const base=url.slice(0,-'index.html'.length)
  assert.equal(output.isReady(),false)
  assert.equal((await fetch(url)).status,200)
  const state=await (await fetch(base+'playlist')).json()
  assert.deepEqual(state.items.map(x=>x.id),['pic','clip'])
  assert.equal(state.items[0].durationMs,4000)
  assert.ok(!JSON.stringify(state).includes(dir))
  assert.equal((await fetch(base+'ready',{method:'POST'})).status,204)
  assert.equal(output.isReady(),true)
  const part=await fetch(base+'media/clip',{headers:{Range:'bytes=2-5'}})
  assert.equal(part.status,206)
  assert.equal(await part.text(),'2345')
  assert.equal(part.headers.get('content-range'),'bytes 2-5/10')
  assert.equal((await fetch(base+'media/clip',{headers:{Range:'bytes=99-'}})).status,416)
  assert.equal((await fetch(base+'media/not-present')).status,404)
  const bad=await fetch(base.replace(/\/[a-f0-9]{48}\/$/,'/wrong/')+'playlist')
  assert.equal(bad.status,404)
  output.configure('owner',[{id:'pic'}])
  assert.equal(output.isReady(),false)
  // Real HTTP data transfer and explicit playback-completed handshake.
  const wav=Buffer.alloc(44)
  wav.write('RIFF',0,'ascii');wav.write('WAVE',8,'ascii')
  const speaking=output.playAudio(wav.toString('base64'))
  const job=await (await fetch(base+'audio/status')).json()
  assert.ok(job.id)
  const voice=await fetch(base+'audio/data/'+job.id,{headers:{Range:'bytes=0-11'}})
  assert.equal(voice.status,206)
  assert.equal((await voice.arrayBuffer()).byteLength,12)
  assert.equal((await fetch(base+'audio/completed/'+job.id,{method:'POST'})).status,204)
  await speaking
  assert.equal((await (await fetch(base+'audio/status')).json()).id,null)
  await output.stop()
  assert.equal(output.isReady(),false)
  await assert.rejects(fetch(url))
})

test('invalid IDs, account isolation, MIME and limits fail closed', async t => {
  const dir=mkdtempSync(join(tmpdir(),'ai-live-test-'))
  const picture=join(dir,'product.png')
  writeFileSync(picture,Buffer.from([0,1,2]))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const output=new LiveOutputServer((account,id)=>{
    if(account!=='allowed')return null
    return {id,kind:'image',mime:'image/png',absolutePath:picture,size:3}
  })
  assert.throws(()=>output.configure('other',[{id:'one'}]),/不存在/)
  assert.throws(()=>output.configure('allowed',[{id:'../escape'}]),/非法/)
  assert.throws(()=>output.configure('allowed',[{id:'one'},{id:'one'}]),/重复/)
  assert.throws(()=>output.configure('allowed',[{id:'one',durationMs:1}]),/时间/)
  const invalidMime=new LiveOutputServer(()=>({id:'one',kind:'image',mime:'text/html',absolutePath:picture,size:3}))
  assert.throws(()=>invalidMime.configure('allowed',[{id:'one'}]),/格式/)
})
