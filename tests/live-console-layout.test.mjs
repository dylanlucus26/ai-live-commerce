import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL('../' + path,import.meta.url),'utf8')
test('default route remains the compact dashboard',()=>{
  const r=read('src/router/index.tsx')
  assert.match(r,/path:\s*'\/'[\s\S]{0,60}element:\s*<LiveWorkbench\s*\/>/)
  assert.match(r,/path:\s*'\/voice-commerce'/)
})
test('real operator console shows start broadcast label and actual stream limitation',()=>{
  const ui=read('src/pages/LiveWorkbench/index.tsx')
  for(const phrase of ['直播间互动','当前商品与直播文案','主播人设与 AI 回复规则','开始直播','紧急静音','模拟弹幕问答']){
    assert.ok(ui.includes(phrase),'Missing operator action: '+phrase)
  }
  assert.match(ui,/平台直播间开播、推流接收及声音需单独验收/)
  assert.match(ui,/<AdvancedSettings open=\{advancedOpen\}/)
  assert.match(ui,/<LiveAccountControl\s*\/>/)
  assert.doesNotMatch(ui,/<Sheet\s/)
  assert.doesNotMatch(ui,/开始播讲/)
})
test('dark settings are native pages rather than white legacy page embedded in drawer',()=>{
  const ui=read('src/pages/LiveWorkbench/AdvancedSettings.tsx')
  assert.match(ui,/直播设置中心/)
  assert.match(ui,/role="dialog"/)
  assert.match(ui,/商品与讲品/)
  assert.match(ui,/库存数据同步/)
  assert.doesNotMatch(read('src/pages/LiveWorkbench/index.tsx'),/<VoiceCommerce\s*\/>/)
})
test('old management routes are preserved',()=>{
  const r=read('src/router/index.tsx')
  for(const route of ['live-control','auto-message','auto-popup','settings'])
    assert.ok(r.includes("path: '/" + route + "'"))
  assert.ok(r.includes("path: 'auto-reply'"))
})
