import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('unified settings contains no legacy management links', () => {
  const page = read('src/pages/LiveWorkbench/AdvancedSettings.tsx')
  for (const old of ['原有管理能力','完整 AI 语音带货管理','完整自动回复规则','更多工具','goTo(', "id: 'tools'"])
    assert.ok(!page.includes(old), 'legacy entry was not removed: '+old)
  for (const value of ['直播连接','直播任务','软件设置','OperationsSettings','商品与讲品','AI 互动','主播声音','画面与 OBS','库存同步','运营数据'])
    assert.ok(page.includes(value), 'unified settings missing: '+value)
})
test('features previously behind legacy routes have new first-class controls', () => {
  const ui = read('src/pages/LiveWorkbench/OperationsSettings.tsx')
  const old = ['浏览器与登录状态', '定时直播发言', '商品橱窗弹窗',
    '商品快捷键','软件信息与更新','日志与诊断','本机账号管理','启动发言任务','启动弹窗任务']
  for (const item of old) assert.ok(ui.includes(item),'missing first-class control: '+item)
  for (const oldNavigation of ['navigate(','goTo(','/auto-message','/auto-popup','/settings'])
    assert.ok(!ui.includes(oldNavigation),'direct legacy navigation in operations settings: '+oldNavigation)
  assert.match(ui,/permission/)
  assert.match(ui,/IPC_CHANNELS\.tasks\.autoMessage\.start/)
  assert.match(ui,/IPC_CHANNELS\.tasks\.autoPopUp\.start/)
})
test('popup keyboard shortcuts continue working while settings are closed',()=>{
  const root = read('src/components/common/VoiceRuntimeHost.tsx')
  assert.match(root,/import \{ useShortcutListener \}/)
  assert.match(root,/useShortcutListener\(\)/)
})
