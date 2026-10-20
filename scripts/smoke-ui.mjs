import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const host = 'http://127.0.0.1:4186'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const server = spawn(process.execPath,
  [path.resolve('node_modules/vite/bin/vite.js'), 'preview',
    '--host', '127.0.0.1', '--port', '4186', '--strictPort'],
  { stdio: ['ignore','pipe','pipe'], env: { ...process.env, NODE_ENV: 'production' } })
let serverOutput = ''
server.stdout.on('data', v => {serverOutput += String(v).slice(-1600)})
server.stderr.on('data', v => {serverOutput += String(v).slice(-1600)})
let browser
const failures = []

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    if (server.exitCode !== null) throw Error('vite preview stopped: ' + serverOutput)
    try { if ((await fetch(host + '/')).ok) return } catch { /* startup */ }
    await wait(300)
  }
  throw Error('Vite preview did not start: ' + serverOutput)
}

async function scenario(name, newAccount) {
  const context = await browser.newContext({viewport:{width:1480,height:920}})
  const page = await context.newPage()
  const errors=[]
  page.on('pageerror', e=> errors.push(e.message))
  page.on('console', msg => {
    if (msg.type()==='error' && /Maximum update depth|Minified React|Uncaught|No handler registered/i.test(msg.text()))
      errors.push(msg.text())
  })
  await page.addInitScript(({ account }) => {
    window.ipcRenderer = {
      on: () => () => {}, send: () => {},
      invoke: async channel => {
        if (channel === 'voiceCommerce:tts:hasKey') return false
        if (channel === 'voiceCommerce:media:list') return []
        if (channel === 'voiceCommerce:clone:has') return false
        if (channel === 'voiceCommerce:inventory:name') return null
        if (channel === 'voiceCommerce:obs:scenes') return {scenes:[],currentScene:'',mediaInputs:[]}
        if (channel === 'app:getProviders') return {deepseek:{name:'DeepSeek',baseURL:'https://api.deepseek.com',apiUrl:'',models:['deepseek-chat']}}
        return true
      },
    }
    if (account) localStorage.setItem('accounts-storage',JSON.stringify({
      state:{accounts:[{id:account,name:'测试新账号'}],currentAccountId:account},version:0
    }))
    localStorage.setItem('storage-version','0.2.4')
  }, { account: newAccount ? 'smoke-without-metrics' : null })

  await page.goto(host + '/#/', {waitUntil:'domcontentloaded'})
  await page.locator('.live-workbench').waitFor({timeout:25_000})
  await page.getByText('直播间互动', {exact:true}).waitFor({timeout:7000})
  await page.waitForTimeout(500)
  assert.equal(await page.getByText('Unexpected Application Error!',{exact:false}).count(),0)
  const start = page.getByRole('button',{name:'开始直播'})
  await start.waitFor({timeout:7000})
  assert.match(await start.getAttribute('title') ?? '', /OBS.*推流/)

  const accountSelect = page.getByRole('combobox',{name:'当前直播账号'})
  await accountSelect.waitFor()
  const colors = await accountSelect.evaluate(el => ({
    text: getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor,
  }))
  assert.notEqual(colors.text,colors.background,'account select text must contrast with its background')

  await page.getByRole('button',{name:'新增商品'}).click()
  const field=page.getByPlaceholder('如：2026陕西苹果礼盒')
  await field.fill('测试商品')
  assert.equal(await field.inputValue(),'测试商品')

  await page.getByTitle('高级设置').click()
  await page.getByText('直播设置中心',{exact:true}).waitFor({timeout:7000})
  await page.getByText('商品知识库',{exact:true}).waitFor()
  await mkdir('test-results',{recursive:true})
  await page.screenshot({path:path.join('test-results','workbench-settings-'+name+'.png')})

  const tabs=[
    ['AI 互动','AI 回复策略'],['主播声音','声音引擎'],
    ['画面与 OBS','商品图片、视频与播放列表'],['库存同步','库存数据同步'],
    ['运营数据','最近 7 天的本机运营事件'],
    ['直播连接','浏览器与登录状态'],
    ['直播任务','定时直播发言'],
    ['软件设置','软件信息与更新'],
  ]
  for(const [tab,heading] of tabs){
    await page.getByRole('button',{name:new RegExp(tab)}).click()
    await page.getByText(heading,{exact:true}).waitFor({timeout:7000})
  }
  // Verify that the settings window can be dragged wider from its right border.
  await page.getByRole('button',{name:/画面与 OBS/}).click()
  await page.getByTestId('video-obs-workspace').waitFor()
  const workspace = page.getByTestId('video-obs-workspace')
  const inner = page.locator('.live-settings-main')
  const initialWidth = await page.locator('.live-settings-window').evaluate(el => el.getBoundingClientRect().width)
  // The new default modal is almost full-screen. Verify BOTH shrink and expand,
  // rather than incorrectly requiring growth past the viewport's physical limit.
  const handle = page.getByTestId('settings-resize-right')
  const oldHandle=await handle.boundingBox()
  assert.ok(oldHandle && oldHandle.width>=10,'resize grip missing')
  await page.mouse.move(oldHandle.x+oldHandle.width/2,oldHandle.y+oldHandle.height/2)
  await page.mouse.down()
  await page.mouse.move(oldHandle.x+oldHandle.width/2-95,oldHandle.y+oldHandle.height/2,{steps:10})
  await page.mouse.up()
  const narrowed = await page.locator('.live-settings-window').evaluate(el => el.getBoundingClientRect().width)
  assert.ok(narrowed < initialWidth-125, 'settings width should shrink: '+initialWidth+' -> '+narrowed)

  const newHandle=await handle.boundingBox()
  assert.ok(newHandle)
  await page.mouse.move(newHandle.x+newHandle.width/2,newHandle.y+newHandle.height/2)
  await page.mouse.down()
  await page.mouse.move(newHandle.x+newHandle.width/2+90,newHandle.y+newHandle.height/2,{steps:10})
  await page.mouse.up()
  const wider = await page.locator('.live-settings-window').evaluate(el => el.getBoundingClientRect().width)
  assert.ok(wider>narrowed+120, 'settings width should grow after shrink: '+narrowed+' -> '+wider)

  // Both video and OBS panels must use the full available settings content width.
  const videoWidth = await workspace.evaluate(el => el.getBoundingClientRect().width)
  const contentWidth = await inner.evaluate(el => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft)
    - parseFloat(getComputedStyle(el).paddingRight))
  assert.ok(videoWidth >= contentWidth - 10, 'video/OBS workspace must fill the content width')
  assert.equal(await page.getByRole('button',{name:'从头播放'}).count(),1)
  assert.equal(await page.getByRole('button',{name:'重新播放'}).count(),0)
  await page.screenshot({path:path.join('test-results','video-obs-resized-'+name+'.png')})

  // The separator adjusts only the category sidebar, independently of the dialog width.
  const nav = page.locator('.live-settings-nav')
  const beforeNav = await nav.evaluate(el => el.getBoundingClientRect().width)
  const sidebarGrip = await page.getByTestId('settings-sidebar-resizer').boundingBox()
  assert.ok(sidebarGrip)
  await page.mouse.move(sidebarGrip.x + sidebarGrip.width / 2, sidebarGrip.y + sidebarGrip.height / 2)
  await page.mouse.down()
  await page.mouse.move(sidebarGrip.x + sidebarGrip.width / 2 + 42,
    sidebarGrip.y + sidebarGrip.height / 2, { steps: 8 })
  await page.mouse.up()
  const afterNav = await nav.evaluate(el => el.getBoundingClientRect().width)
  assert.ok(afterNav > beforeNav + 18, 'category navigation should be horizontally adjustable')
  const persistedWidth = await page.locator('.live-settings-window').evaluate(el => el.getBoundingClientRect().width)
  await page.getByRole('button',{name:'关闭设置'}).click()
  await page.getByTitle('高级设置').click()
  await page.getByRole('button',{name:/画面与 OBS/}).click()
  const reopenedWidth = await page.locator('.live-settings-window').evaluate(el => el.getBoundingClientRect().width)
  assert.ok(Math.abs(reopenedWidth - persistedWidth) < 5, 'dialog width should persist after reopening')

  await page.getByRole('button',{name:/直播任务/}).click()
  await page.getByRole('button',{name:'＋ 新增话术'}).click()
  const messageField = page.getByRole('textbox',{name:'定时发言文案'}).last()
  await messageField.fill('仅在获授权后用于人工值守测试')
  assert.equal(await messageField.inputValue(),'仅在获授权后用于人工值守测试')
  await page.getByRole('button',{name:'＋ 添加商品编号'}).click()
  await page.getByText('商品橱窗弹窗',{exact:true}).waitFor()
  assert.equal(await page.getByText('原有管理能力',{exact:true}).count(),0)
  assert.equal(await page.getByText('完整 AI 语音带货管理',{exact:true}).count(),0)
  await page.getByRole('button',{name:'关闭设置'}).click()
  const newAccountButton = page.getByRole('button',{name:'新增直播账号'})
  const gear = page.getByTitle('高级设置')
  const accountBounds = await newAccountButton.boundingBox()
  const gearBounds = await gear.boundingBox()
  assert.ok(accountBounds && gearBounds, 'Account actions and gear must be visible')
  const nonOverlapping = accountBounds.x + accountBounds.width <= gearBounds.x ||
    gearBounds.x + gearBounds.width <= accountBounds.x
  assert.ok(nonOverlapping, 'Account controls must not overlap with settings gear')
  await newAccountButton.click()
  await page.getByRole('dialog',{name:'新增直播账号'}).waitFor()
  await page.getByPlaceholder('输入用于区分的直播账号名称').fill('测试带货二号')
  await page.getByRole('button',{name:'保存并继续'}).click()
  await accountSelect.selectOption({label:'测试带货二号'})
  await page.waitForTimeout(700)
  assert.deepEqual(errors,[], 'real React page reported errors: '+errors.join(' / '))
  await page.screenshot({path:path.join('test-results','workbench-home-'+name+'.png')})
  await context.close()
  process.stdout.write('PASS render, account controls, product, settings tabs: '+name+'\n')
}

try {
  await waitForServer()
  browser = await chromium.launch({headless:true})
  await scenario('fresh',false)
  await scenario('no-metrics',true)
}catch(e){
  failures.push(e instanceof Error ? e.stack || e.message : String(e))
}finally{
  if(browser) await browser.close()
  server.kill()
}
if(failures.length){process.stderr.write(failures.join('\n')+'\n');process.exitCode=1}
