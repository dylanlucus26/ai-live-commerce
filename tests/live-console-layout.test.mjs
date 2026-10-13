import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
test('the default route is the one-screen live workbench', () => {
  const source = read('src/router/index.tsx')
  assert.match(source, /path:\s*'\/'[\s\S]{0,60}element:\s*<LiveWorkbench\s*\/>/)
  assert.match(source, /path:\s*'\/voice-commerce'/)
  assert.match(source, /path:\s*'\/live-control'/)
})
test('the console contains the key on-air zones', () => {
  const source = read('src/pages/LiveWorkbench/index.tsx')
  for (const title of ['直播间互动', '当前商品与直播文案', '主播人设与 AI 回复规则',
    '开始播讲', '停止', '紧急静音', '常用设置', '模拟弹幕问答', '高级设置与功能管理']) {
    assert.ok(source.includes(title), 'missing control: ' + title)
  }
  assert.match(source, /<VoiceCommerce\s*\/>/)
  assert.match(source, /startRuntimePitch/)
  assert.match(source, /autoSend:\s*true/)
})
test('the console hides legacy navigation and logs but keeps them for advanced pages', () => {
  const app = read('src/App.tsx')
  assert.match(app, /!isDesk && <Sidebar/)
  assert.match(app, /!isDesk && <Header/)
  assert.match(app, /!isDesk && <div className="h-\[180px\]/)
  assert.match(app, /autoSend:\s*false/)
})
test('product copy can be saved independently of product facts', () => {
  const model = read('src/features/voiceCommerce/model.ts')
  assert.match(model, /script\?: string/)
  assert.match(model, /script: field\('script'\)/)
})
