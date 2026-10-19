import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8')
test('desktop window supports resizing in native macOS and Windows', () => {
  const main = read('electron/main/app.ts')
  assert.match(main,/resizable: true/)
  assert.match(main,/maximizable: true/)
})
test('settings has a draggable resizable frame and adjustable nav divider', () => {
  const component = read('src/pages/LiveWorkbench/AdvancedSettings.tsx')
  for (const snippet of ['settings-resize-','settings-sidebar-resizer','setPointerCapture',
    'dialogWidth','navigationWidth','fitDialogWidth','localStorage.setItem'])
    assert.ok(component.includes(snippet), 'missing resize behavior: ' + snippet)
  const css = read('src/pages/LiveWorkbench/advancedSettings.css')
  assert.match(css,/\.live-settings-window-resizer/)
  assert.match(css,/\.live-settings-nav-resizer/)
})
test('video and OBS layout fills the settings content and uses Chinese actions', () => {
  const component = read('src/pages/LiveWorkbench/AdvancedSettings.tsx')
  for(const txt of ['live-settings-video-grid','live-settings-video-preview','OBS 本机联动','从头播放','连接 / 刷新本机 OBS'])
    assert.ok(component.includes(txt),'video/OBS feature missing: '+txt)
  assert.doesNotMatch(component,/>\\{a\\}<\\/button>/)
  const css = read('src/pages/LiveWorkbench/advancedSettings.css')
  assert.match(css,/\.live-settings-video-grid/)
  assert.match(css,/@container\\s*\\(max-width/)
})
