import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8')

test('quick-settings CSS and full-settings CSS never reuse grid class',()=>{
  const main=read('src/pages/LiveWorkbench/liveWorkbench.css')
  const full=read('src/pages/LiveWorkbench/advancedSettings.css')
  const mainUI=read('src/pages/LiveWorkbench/index.tsx')
  const fullUI=read('src/pages/LiveWorkbench/AdvancedSettings.tsx')
  assert.doesNotMatch(main,/\.live-settings-grid(?:\b|[\s.#:]|$)/)
  assert.match(main,/\.live-quick-settings-grid\b/)
  assert.match(mainUI,/className="live-quick-settings-grid"/)
  assert.match(full,/\.live-settings-grid\b/)
  assert.match(fullUI,/className="live-settings-grid"/)
})

test('responsive settings fills both columns, and stacked cards when narrow',()=>{
  const css=read('src/pages/LiveWorkbench/advancedSettings.css')
  assert.match(css,/\.live-settings-main > \.live-settings-grid/)
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
  assert.match(css,/@container \(max-width:920px\)/)
  assert.match(css,/\.live-settings-main > \.live-settings-grid > \.live-settings-card\.wide/)
})

test('all settings categories have independent width audits',()=>{
  const script=read('scripts/layout-audit.mjs')
  for(const tab of ['products','interaction','voice','video','inventory','analytics','connection','automation','application'])
    assert.ok(script.includes("'"+tab+"'"))
  for(const name of ['wide-1920','desktop-1440','compact-1024'])
    assert.ok(script.includes(name))
  assert.ok(script.includes('CARDS ONLY OCCUPY LEFT SIDE'))
  assert.ok(script.includes('GRID LEAVES EMPTY SPACE'))
})
