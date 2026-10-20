import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ManagedObsSceneController } from '../electron/main/services/ManagedObsSceneController.ts'

const config={port:4455,password:'local-secret'}
const url='http://127.0.0.1:32123/'+'a'.repeat(48)+'/index.html'

const setup=()=>{
  let current='Before'
  let failBrowser=false
  const events=[]
  const actions={
    current: async()=>current,
    createScene: async(_,name)=>{events.push(['create',name])},
    createBrowser:async(_,settings)=>{
      events.push(['browser',settings])
      if(failBrowser) throw Error('invalid browser source')
    },
    switch:async(_,name)=>{events.push(['switch',name]);current=name},
    remove:async(_,name)=>{events.push(['remove',name])},
  }
  return {
    subject:new ManagedObsSceneController(actions),events,
    setCurrent:name=>{current=name},setBrowserFailure:()=>{failBrowser=true},getCurrent:()=>current,
  }
}
test('managed browser scene creates an isolated source and restores original scene on cleanup',async()=>{
  const s=setup()
  const result=await s.subject.prepare(config,url)
  assert.match(result.sceneName,/^AI Live Commerce - [a-f0-9]{8}$/)
  assert.equal(result.previousScene,'Before')
  const source=s.events.find(e=>e[0]==='browser')[1]
  assert.equal(source.url,url)
  assert.equal(source.width,1080)
  assert.equal(source.height,1920)
  assert.equal(s.getCurrent(),result.sceneName)
  await s.subject.cleanup(config,result)
  assert.equal(s.getCurrent(),'Before')
  assert.equal(s.events.at(-1)[1],result.sceneName)
})

test('user switching to another scene is not overwritten during preview cleanup',async()=>{
  const s=setup()
  const result=await s.subject.prepare(config,url)
  s.setCurrent('User edited current scene')
  const switches=s.events.filter(e=>e[0]==='switch').length
  await s.subject.cleanup(config,result)
  assert.equal(s.events.filter(e=>e[0]==='switch').length,switches)
  assert.equal(s.getCurrent(),'User edited current scene')
})

test('failed browser input creation removes only freshly made scene',async()=>{
  const s=setup()
  s.setBrowserFailure()
  await assert.rejects(s.subject.prepare(config,url),/invalid browser source/)
  assert.equal(s.getCurrent(),'Before')
  assert.equal(s.events.filter(e=>e[0]==='remove').length,1)
})

test('OBS browser scene rejects remote or untrusted output addresses',async()=>{
  const s=setup()
  for(const invalid of ['https://example.com/test','http://localhost:8000/preview',
    'http://127.0.0.1:8000/anything','http://127.0.0.1:8000/'+ 'a'.repeat(48)+'/index.html?auth=leak']){
    await assert.rejects(s.subject.prepare(config,invalid),/本机受控素材输出地址/)
  }
  assert.deepEqual(s.events,[])
})
