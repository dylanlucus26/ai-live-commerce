import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { _electron } from 'playwright'

const executablePath = process.env.ELECTRON_APP_PATH
assert.ok(executablePath && existsSync(executablePath), 'ELECTRON_APP_PATH must point to a packaged native executable')
const timeout = 60000
let app
let screen
try {
  app = await _electron.launch({
    executablePath, timeout, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  })
  screen = await app.firstWindow({timeout})
  const nativeWindow = await app.browserWindow(screen)
  const resizeInfo = await nativeWindow.evaluate(win => ({ resizable: win.isResizable(), minimum: win.getMinimumSize() }))
  assert.equal(resizeInfo.resizable, true, 'Desktop app window itself must be horizontally resizable')
  assert.ok(resizeInfo.minimum[0] <= 840, 'minimum desktop width must allow narrower laptop screens')

  const errors = []
  screen.on('pageerror', err=>errors.push(err.message))
  await screen.locator('.live-workbench').waitFor({timeout:30000})
  await screen.getByRole('button',{name:'开始直播'}).waitFor()

  const channels = await screen.evaluate(async()=>{
    const results={}
    for(const [key,channel,args] of [
      ['media','voiceCommerce:media:list',['default']],
      ['inventory','voiceCommerce:inventory:name',['default']],
      ['voiceClone','voiceCommerce:clone:has',['default']],
      ['tts','voiceCommerce:tts:hasKey',[]],
    ]){
      try{ results[key]={ok:true,value:await window.ipcRenderer.invoke(channel,...args)} }
      catch(err){results[key]={ok:false,error:String(err)}}
    }
    return results
  })
  for(const [key,r] of Object.entries(channels))
    assert.equal(r.ok,true,'Real Electron IPC handler missing: '+key+' / '+r.error)
  assert.ok(Array.isArray(channels.media.value),'media:list must return an array')

  await screen.getByTitle('高级设置').click()
  await screen.getByText('直播设置中心',{exact:true}).waitFor()
  await screen.getByRole('button',{name:/库存同步/}).click()
  await screen.getByText('库存数据同步',{exact:true}).waitFor()
  await screen.getByRole('button',{name:/主播声音/}).click()
  await screen.getByText('声音引擎',{exact:true}).waitFor()
  await screen.getByRole('button',{name:'关闭设置'}).click()
  await screen.getByRole('button',{name:'新增商品'}).click()
  await screen.getByPlaceholder('如：2026陕西苹果礼盒').fill('原生 Electron 验收商品')
  assert.deepEqual(errors,[],'Native Electron runtime must not emit page errors')
  mkdirSync('test-results',{recursive:true})
  await screen.screenshot({path:path.join('test-results','native-electron.png')})
  process.stdout.write('PASS packaged Electron smoke: IPC media, inventory, clone, TTS and primary UI actions\n')
}catch(e){
  process.stderr.write((e instanceof Error?e.stack:e)+'\n')
  process.exitCode=1
}finally{
  try{await app?.close()}catch{}
}
