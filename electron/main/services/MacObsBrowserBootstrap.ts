import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Response = Record<string, unknown>
export type ObsBootstrapRequest = (type: string, data?: Response) => Promise<Response>
interface OwnedCollection { name: string; file: string }
const prefix = 'AI_Live_Commerce_CEF_'
const manifestName = 'browser-bootstrap.json'

/** Load a silent blank source on OBS's UI thread before worker-side CreateInput.
 * Only an app-owned collection is written. Original collection/scene is restored.
 * Product readiness still requires the real media page's independent /ready.
 */
export class MacObsBrowserBootstrap {
  private busy = false
  constructor(private readonly root = join(homedir(), 'Library', 'Application Support', 'obs-studio')) {}

  private findFile(name: string): string {
    const dir = join(this.root, 'basic', 'scenes')
    const found = readdirSync(dir).filter(file => {
      if (!file.endsWith('.json') || lstatSync(join(dir, file)).isSymbolicLink()) return false
      try { return JSON.parse(readFileSync(join(dir, file), 'utf8')).name === name } catch { return false }
    })
    if (found.length !== 1) throw new Error('无法唯一确认软件专用 OBS 初始化集合，未修改文件')
    return found[0]
  }

  async initialize(request: ObsBootstrapRequest): Promise<void> {
    if (this.busy) throw new Error('OBS 浏览器初始化正在进行')
    this.busy = true
    let original = ''
    let owned: OwnedCollection | null = null
    let changed = false
    try {
      const stream = await request('GetStreamStatus')
      const outputList = await request('GetOutputList')
      if (typeof stream.outputActive !== 'boolean' || !Array.isArray(outputList.outputs)
        || outputList.outputs.some(output => !output || typeof output.outputActive !== 'boolean'))
        throw new Error('无法确认 OBS 输出状态，未切换场景集合')
      if (stream.outputActive || stream.outputReconnecting === true
        || outputList.outputs.some(output => output.outputActive))
        throw new Error('OBS 正在推流、录制或输出，请先停止后再初始化浏览器源')
      const before = await request('GetSceneCollectionList')
      original = typeof before.currentSceneCollectionName === 'string' ? before.currentSceneCollectionName : ''
      if (!original || !Array.isArray(before.sceneCollections) || !before.sceneCollections.includes(original))
        throw new Error('OBS 当前场景集合无法确认')
      const scene = await request('GetSceneList')
      const originalScene = scene.currentProgramSceneName
      if (typeof originalScene !== 'string' || !originalScene) throw new Error('OBS 当前场景无法确认')

      const manifestDir = join(this.root, 'plugin_config', 'ai-live-commerce')
      const manifest = join(manifestDir, manifestName)
      let text: string | null = null
      try { text = readFileSync(manifest, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (text !== null) {
        const saved = JSON.parse(text) as OwnedCollection
        if (!new RegExp('^' + prefix + '[a-f0-9]{32}$', 'u').test(saved.name)
          || typeof saved.file !== 'string' || !/^[a-zA-Z0-9_-]+\.json$/u.test(saved.file))
          throw new Error('软件专用 OBS 初始化记录无效，未修改其他集合')
        if (!before.sceneCollections.includes(saved.name) || this.findFile(saved.name) !== saved.file)
          throw new Error('软件专用 OBS 初始化集合不存在或已改变，未修改其他集合')
        owned = saved
      } else {
        owned = {name: prefix + randomUUID().replaceAll('-', ''), file: ''}
        // A lost CreateSceneCollection acknowledgement can still change OBS.
        changed = true
        await request('CreateSceneCollection', {sceneCollectionName: owned.name})
        const created = await request('GetSceneCollectionList')
        if (created.currentSceneCollectionName !== owned.name) throw new Error('OBS 专用初始化集合创建未确认')
        await request('SetCurrentSceneCollection', {sceneCollectionName: original})
        const restored = await request('GetSceneCollectionList')
        if (restored.currentSceneCollectionName !== original) throw new Error('OBS 原场景集合恢复未确认')
        changed = false
        owned.file = this.findFile(owned.name)
        mkdirSync(manifestDir, {recursive: true})
        writeFileSync(manifest, JSON.stringify(owned) + '\n', {flag: 'wx', mode: 0o600})
      }
      if (original === owned.name) throw new Error('请先切回正式 OBS 场景集合，再启动商品画面')
      const filename = join(this.root, 'basic', 'scenes', owned.file)
      if (this.findFile(owned.name) !== owned.file) throw new Error('OBS 专用初始化集合文件发生变化')
      const blankName = 'AI Live Commerce CEF - silent blank'
      const collection = {
        name: owned.name, current_scene: 'Bootstrap', current_program_scene: 'Bootstrap',
        scene_order: [{name: 'Bootstrap'}],
        sources: [{
          name: blankName, id: 'browser_source', versioned_id: 'browser_source',
          settings: {url: 'about:blank', width: 16, height: 16, shutdown: false, reroute_audio: false},
          mixers: 0, sync: 0, flags: 0, volume: 0, balance: 0.5, enabled: true, muted: true, hotkeys: {},
        }, {
          name: 'Bootstrap', id: 'scene', versioned_id: 'scene',
          settings: {id_counter: 1, custom_size: false, items: [{
            name: blankName, id: 1, visible: false, locked: true,
            pos: {x: 0, y: 0}, scale: {x: 1, y: 1},
          }]},
          mixers: 0, sync: 0, flags: 0, volume: 1, balance: 0.5, enabled: true, muted: false,
          hotkeys: {'OBSBasic.SelectScene': []},
        }],
        groups: [], transitions: [], quick_transitions: [],
        current_transition: 'Fade', transition_duration: 300, preview_locked: false, scaling_enabled: false,
      }
      const temporary = filename + '.' + randomUUID() + '.tmp'
      writeFileSync(temporary, JSON.stringify(collection), {flag: 'wx', mode: 0o600})
      renameSync(temporary, filename)
      // This official RPC queues scene loading on OBS_TASK_UI, unlike CreateInput.
      changed = true
      await request('SetCurrentSceneCollection', {sceneCollectionName: owned.name})
      const loaded = await request('GetSceneCollectionList')
      if (loaded.currentSceneCollectionName !== owned.name) throw new Error('OBS 主线程初始化集合加载未确认')
      await request('SetCurrentSceneCollection', {sceneCollectionName: original})
      const after = await request('GetSceneCollectionList')
      if (after.currentSceneCollectionName !== original) throw new Error('OBS 原场景集合恢复未确认')
      changed = false
      const restoredScene = await request('GetSceneList')
      if (restoredScene.currentProgramSceneName !== originalScene)
        throw new Error('OBS 原场景恢复未确认，已停止商品画面启动')
    } finally {
      try {
        if (changed && owned && original) {
          const state = await request('GetSceneCollectionList')
          if (state.currentSceneCollectionName === owned.name) {
            await request('SetCurrentSceneCollection', {sceneCollectionName: original})
            const restored = await request('GetSceneCollectionList')
            if (restored.currentSceneCollectionName !== original) throw new Error('OBS 初始化异常后原集合恢复失败')
          }
        }
      } finally { this.busy = false }
    }
  }
}
