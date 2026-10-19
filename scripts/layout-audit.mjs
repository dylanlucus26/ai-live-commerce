import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const host = 'http://127.0.0.1:4198'
const server = spawn(process.execPath,
  [path.resolve('node_modules/vite/bin/vite.js'), 'preview',
    '--host','127.0.0.1','--port','4198','--strictPort'],
  { stdio:['ignore','pipe','pipe'], env:{...process.env,NODE_ENV:'production'} })
let logs = ''
server.stdout.on('data',b=>{logs += String(b).slice(-1000)})
server.stderr.on('data',b=>{logs += String(b).slice(-1000)})
const pause = ms=>new Promise(done=>setTimeout(done,ms))
const profiles = [
  {name:'wide-1920', width:1920, height:1080, panel:1740, navigation:340},
  {name:'desktop-1440', width:1440, height:900, panel:1320, navigation:270},
  {name:'compact-1024', width:1024, height:820, panel:980, navigation:205},
]
const tabs = [
  ['products','商品与讲品','商品知识库'],
  ['interaction','AI 互动','AI 回复策略'],
  ['voice','主播声音','声音引擎'],
  ['video','画面与 OBS','商品视频与播放列表'],
  ['inventory','库存同步','库存数据同步'],
  ['analytics','运营数据','最近 7 天的本机运营事件'],
  ['connection','直播连接','浏览器与登录状态'],
  ['automation','直播任务','定时直播发言'],
  ['application','软件设置','软件信息与更新'],
]
const fail = []

async function waitForPreview() {
  for(let i=0;i<90;i++){
    if(server.exitCode!==null)throw Error('Vite preview terminated: '+logs)
    try{if((await fetch(host+'/')).ok)return}catch{}
    await pause(250)
  }
  throw Error('Vite preview timeout: '+logs)
}

async function audit(browser, profile) {
  const ctx = await browser.newContext({viewport:{width:profile.width,height:profile.height}})
  const page=await ctx.newPage()
  const errors = []
  page.on('pageerror',err=>errors.push('pageerror '+err.message))
  page.on('console',msg=>{
    if(msg.type()==='error' && /React error|Maximum update depth|No handler registered|Uncaught/i.test(msg.text()))
      errors.push('console '+msg.text())
  })
  await page.addInitScript(({ panel, navigation }) => {
    localStorage.setItem('ai-live-commerce:settings-window-width',String(panel))
    localStorage.setItem('ai-live-commerce:settings-navigation-width',String(navigation))
    window.ipcRenderer = {
      on:()=>()=>{}, send:()=>{},
      invoke:async channel=>{
        if(channel==='voiceCommerce:media:list')return []
        if(channel==='voiceCommerce:clone:has')return false
        if(channel==='voiceCommerce:inventory:name')return null
        if(channel==='voiceCommerce:tts:hasKey')return false
        if(channel==='voiceCommerce:obs:scenes')return {scenes:[],currentScene:'',mediaInputs:[]}
        if(channel==='app:getProviders')return {deepseek:{name:'DeepSeek',baseURL:'https://api.deepseek.com',apiUrl:'',models:['deepseek-chat']}}
        return true
      },
    }
  }, {panel:profile.panel,navigation:profile.navigation})
  const root = 'test-results/layout-audit'
  try {
    await page.goto(host+'/#/',{waitUntil:'domcontentloaded'})
    await page.locator('.live-workbench').waitFor({timeout:20000})
    await mkdir(root,{recursive:true})

    // The central divider must actually resize the comment pane and retain enough operator width.
    const comment=page.locator('.live-left')
    const oldLeft=await comment.evaluate(el=>el.getBoundingClientRect().width)
    const paneHandle=await page.getByTestId('main-pane-resizer').boundingBox()
    assert.ok(paneHandle && paneHandle.width>=7,'Main live console needs a draggable split')
    await page.mouse.move(paneHandle.x+paneHandle.width/2,paneHandle.y+paneHandle.height/2)
    await page.mouse.down()
    await page.mouse.move(paneHandle.x+paneHandle.width/2+70,
      paneHandle.y+paneHandle.height/2,{steps:8})
    await page.mouse.up()
    const newLeft=await comment.evaluate(el=>el.getBoundingClientRect().width)
    assert.ok(newLeft>oldLeft+35,
      'Main comment pane does not resize: '+oldLeft+' → '+newLeft)

    await page.screenshot({path:path.join(root,profile.name+'-00-dashboard.jpg'),type:'jpeg',quality:74})
    await page.getByTitle('高级设置').click()
    await page.getByRole('dialog',{name:'直播设置中心'}).waitFor()

    // Use the real drag handles. Preloaded storage may be migrated/cleared on boot.
    const modal=page.locator('.live-settings-window')
    const firstWidth=await modal.evaluate(el=>el.getBoundingClientRect().width)
    const desired=Math.min(profile.panel,profile.width-24)
    if(Math.abs(firstWidth-desired)>15){
      const handle=await page.getByTestId('settings-resize-right').boundingBox()
      assert.ok(handle, 'Settings right-hand resize grip missing')
      await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2)
      await page.mouse.down()
      await page.mouse.move(handle.x+handle.width/2+(desired-firstWidth)/2,
        handle.y+handle.height/2,{steps:12})
      await page.mouse.up()
    }
    const expanded=await modal.evaluate(el=>el.getBoundingClientRect().width)
    assert.ok(Math.abs(expanded-desired)<=25,
      'Settings window never reached requested desktop width: target '+desired+' actual '+expanded)

    const nav=page.locator('.live-settings-nav')
    const firstNav=await nav.evaluate(el=>el.getBoundingClientRect().width)
    if(Math.abs(profile.navigation-firstNav)>10){
      const grip=await page.getByTestId('settings-sidebar-resizer').boundingBox()
      assert.ok(grip,'Settings navigation divider missing')
      await page.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2)
      await page.mouse.down()
      await page.mouse.move(grip.x+grip.width/2+profile.navigation-firstNav,
        grip.y+grip.height/2,{steps:10})
      await page.mouse.up()
    }
    const realNav=await nav.evaluate(el=>el.getBoundingClientRect().width)
    assert.ok(Math.abs(realNav-profile.navigation)<18,
      'Settings sidebar did not reach requested width: '+realNav+' vs '+profile.navigation)
    process.stdout.write('AUDIT WINDOW '+profile.name+' panel='+Math.round(expanded)+
      ' nav='+Math.round(realNav)+' dashboardLeft='+Math.round(newLeft)+'\n')
    for(let idx=0;idx<tabs.length;idx++) {
      const [key,title,heading]=tabs[idx]
      const button=page.locator('.live-settings-nav-item').filter({hasText:title})
      await button.click()
      await page.getByText(heading,{exact:true}).waitFor({timeout:7000})
      const item=await page.evaluate(() => {
        const main=document.querySelector('.live-settings-main')
        if(!main)throw Error('No main settings panel')
        const grid=main.querySelector(':scope > .live-settings-grid, :scope > .live-settings-video-grid')
        if(!grid)throw Error('Settings page lacks a content grid')
        const cards=Array.from(grid.children).filter(v=>v.classList.contains('live-settings-card'))
        if(!cards.length)throw Error('Settings page has no cards')
        const mainBox=main.getBoundingClientRect()
        const gridBox=grid.getBoundingClientRect()
        const style=getComputedStyle(main)
        const padLeft=parseFloat(style.paddingLeft)||0
        const padRight=parseFloat(style.paddingRight)||0
        const mainInnerWidth=mainBox.width-padLeft-padRight
        const mainInnerRight=mainBox.right-padRight
        const boxes=cards.map(card=>{
          const rect=card.getBoundingClientRect()
          return {x:Math.round(rect.x),width:Math.round(rect.width),height:Math.round(rect.height),right:Math.round(rect.right),scrollWidth:card.scrollWidth,clientWidth:card.clientWidth}
        })
        return {
          mainWidth:Math.round(mainBox.width),
          mainInnerWidth:Math.round(mainInnerWidth),
          gridWidth:Math.round(gridBox.width),
          gridRight:Math.round(gridBox.right),
          mainInnerRight:Math.round(mainInnerRight),
          columns:getComputedStyle(grid).gridTemplateColumns,
          cards:boxes,
          rightMost:Math.max(...boxes.map(v=>v.right)),
          overflow:main.scrollWidth-main.clientWidth,
          docOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
          cardOverflows:boxes.filter(v=>v.scrollWidth>v.clientWidth+3).length,
        }
      })
      process.stdout.write(JSON.stringify({profile:profile.name,tab:key,...item})+'\n')
      assert.ok(item.mainInnerWidth>=350,'settings work area too narrow for profile '+profile.name)
      const tracks=item.columns.trim().split(/\s+/).filter(Boolean).length
      if(profile.name==='compact-1024') {
        assert.equal(tracks,1,'Compact settings should show one readable full-width column: '+key)
      } else if(key==='voice'||key==='video') {
        assert.ok(tracks>=2,'Wide settings must show TWO full-width card columns: '+profile.name+'/'+key+' '+item.columns)
        assert.ok(item.cards[0].width>=390,'Wide settings cards must be comfortably readable: '+item.cards[0].width)
      }
      assert.ok(item.gridWidth>=item.mainInnerWidth*.96,
        'GRID LEAVES EMPTY SPACE: '+profile.name+'/'+key+' ('+item.gridWidth+' of '+item.mainInnerWidth+')')
      assert.ok(item.rightMost>=item.mainInnerRight-26,
        'CARDS ONLY OCCUPY LEFT SIDE: '+profile.name+'/'+key+' rightmost '+item.rightMost+' vs '+item.mainInnerRight+
        ', columns='+item.columns)
      assert.ok(item.overflow<=4, 'Horizontal overflow in main settings: '+profile.name+'/'+key+' px='+item.overflow)
      assert.ok(item.docOverflow<=4, 'Page overflow: '+profile.name+'/'+key+' px='+item.docOverflow)
      assert.equal(item.cardOverflows,0, 'Controls overflow their cards on '+profile.name+'/'+key)
      const num=String(idx+1).padStart(2,'0')
      await page.screenshot({path:path.join(root,profile.name+'-'+num+'-'+key+'.jpg'),type:'jpeg',quality:74})
    }
    assert.deepEqual(errors,[], 'Browser errors on '+profile.name)
  } catch(e) {
    await page.screenshot({path:path.join(root,profile.name+'-FAIL.png')}).catch(()=>{})
    throw e
  } finally {
    await ctx.close()
  }
}

let browser
try {
  await waitForPreview()
  browser=await chromium.launch({headless:true})
  for(const profile of profiles) await audit(browser,profile)
  process.stdout.write('PASS: 9 settings tabs × 3 viewports + main dashboard, no clipped/half-width layouts\n')
} catch(e) {
  fail.push(e instanceof Error?e.stack||e.message:String(e))
} finally {
  await browser?.close()
  server.kill()
}
if(fail.length) {
  process.stderr.write(fail.join('\n')+'\n')
  process.exitCode=1
}
