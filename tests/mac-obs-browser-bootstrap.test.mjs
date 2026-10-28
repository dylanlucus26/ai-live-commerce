import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MacObsBrowserBootstrap } from '../electron/main/services/MacObsBrowserBootstrap.ts'
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'obs-bootstrap-'))
  const dir = join(root, 'basic', 'scenes')
  mkdirSync(dir, {recursive: true})
  const original = JSON.stringify({name: 'Operator', sources: [{name: 'Do not edit', private: 'operator-only'}]})
  writeFileSync(join(dir, 'Operator.json'), original)
  let current = 'Operator', active = false, failLoad = false, interfere = false
  const names = ['Operator'], calls = []
  const request = async (type, data = {}) => {
    calls.push({type, data})
    if (['GetStreamStatus','GetRecordStatus','GetVirtualCamStatus','GetReplayBufferStatus'].includes(type))
      return {outputActive: type === 'GetRecordStatus' && active, outputReconnecting: false}
    if (type === 'GetSceneCollectionList') return {currentSceneCollectionName: current, sceneCollections: [...names]}
    if (type === 'GetSceneList') return {currentProgramSceneName: 'Operator scene', scenes: [{sceneName: 'Operator scene'}]}
    if (type === 'CreateSceneCollection') {
      names.push(data.sceneCollectionName)
      current = data.sceneCollectionName
      writeFileSync(join(dir, current + '.json'), JSON.stringify({name: current, sources: []}))
      return {}
    }
    if (type === 'SetCurrentSceneCollection') {
      current = data.sceneCollectionName
      if (current.startsWith('AI_Live_Commerce_CEF_') && failLoad) throw Error('lost switch acknowledgement')
      if (current.startsWith('AI_Live_Commerce_CEF_') && interfere) current = 'Operator chose another collection'
      return {}
    }
    throw Error('unexpected request ' + type)
  }
  return {root, dir, request, calls, names, subject: new MacObsBrowserBootstrap(root),
    current: () => current, active: () => {active = true},
    failLoad: () => {failLoad = true}, interfere: () => {interfere = true},
    assertOriginal: () => assert.equal(readFileSync(join(dir, 'Operator.json'), 'utf8'), original),
    cleanup: () => rmSync(root, {recursive: true, force: true})}
}
test('cold bootstrap loads its own silent collection, restores original, and reuses ownership record', async () => {
  const s = setup()
  try {
    await s.subject.initialize(s.request)
    assert.equal(s.current(), 'Operator')
    s.assertOriginal()
    assert.equal(s.names.length, 2)
    const file = readdirSync(s.dir).find(name => name !== 'Operator.json')
    const collection = JSON.parse(readFileSync(join(s.dir, file), 'utf8'))
    const browser = collection.sources.find(source => source.id === 'browser_source')
    assert.equal(browser.settings.url, 'about:blank')
    assert.equal(browser.muted, true)
    assert.equal(browser.mixers, 0)
    assert.equal(collection.sources[1].settings.items[0].visible, false)
    await s.subject.initialize(s.request)
    assert.equal(s.names.length, 2)
    assert.equal(s.current(), 'Operator')
    s.assertOriginal()
  } finally { s.cleanup() }
})
test('recording OBS is refused before creating files or switching collections', async () => {
  const s = setup()
  try {
    s.active()
    await assert.rejects(s.subject.initialize(s.request), /正在推流、录制或输出/u)
    assert.equal(s.calls.some(x => /CreateSceneCollection|SetCurrentSceneCollection/u.test(x.type)), false)
    assert.deepEqual(readdirSync(s.dir), ['Operator.json'])
    s.assertOriginal()
  } finally { s.cleanup() }
})
test('lost collection-load acknowledgement restores the exact original collection', async () => {
  const s = setup()
  try {
    s.failLoad()
    await assert.rejects(s.subject.initialize(s.request), /lost switch acknowledgement/u)
    assert.equal(s.current(), 'Operator')
    s.assertOriginal()
  } finally { s.cleanup() }
})
test('manual collection switch is not overwritten by bootstrap recovery', async () => {
  const s = setup()
  try {
    s.interfere()
    await assert.rejects(s.subject.initialize(s.request), /加载未确认/u)
    assert.equal(s.current(), 'Operator chose another collection')
    s.assertOriginal()
  } finally { s.cleanup() }
})
test('invalid ownership record never authorizes writing an operator collection', async () => {
  const s = setup()
  try {
    const dir = join(s.root, 'plugin_config', 'ai-live-commerce')
    mkdirSync(dir, {recursive: true})
    writeFileSync(join(dir, 'browser-bootstrap.json'), JSON.stringify({name: 'Operator', file: 'Operator.json'}))
    await assert.rejects(s.subject.initialize(s.request), /初始化记录无效/u)
    assert.equal(s.names.length, 1)
    assert.equal(s.current(), 'Operator')
    s.assertOriginal()
  } finally { s.cleanup() }
})
