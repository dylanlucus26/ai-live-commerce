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
    localStorage.setItem('storage-version','0.2.2')
  }, { account: newAccount ? 'smoke-without-metrics' : null })

  await page.goto(host + '/#/', {waitUntil:'domcontentloaded'})
  await page.locator('.live-workbench').waitFor({timeout:25_000})
  await page.getByText('直播间互动', {exact:true}).waitFor({timeout:7000})
  await page.waitForTimeout(500)
  assert.equal(await page.getByText('Unexpected Application Error!',{exact:false}).count(),0)
  const start = page.getByRole('button',{name:'开始直播'})
  await start.waitFor({timeout:7000})
  assert.match(await start.getAttribute('title') ?? '', /不.*推流/)

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
    ['画面与 OBS','商品展示视频'],['库存同步','库存数据同步'],
    ['运营数据','最近 7 天的本机运营事件'],['更多工具','原有管理能力'],
  ]
  for(const [tab,heading] of tabs){
    await page.getByRole('button',{name:new RegExp(tab)}).click()
    await page.getByText(heading,{exact:true}).waitFor({timeout:7000})
  }
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
