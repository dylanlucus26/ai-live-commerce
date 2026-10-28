import { randomUUID } from 'node:crypto'
import type { LiveStreamObsConfig } from 'shared/liveStream'
import { createObsManagedScene, createObsBrowserInput, removeObsManagedScene, switchObsScene, getObsSceneInfo, getObsCanvasSize } from './ObsService'

export interface ManagedScene {
  sceneName: string
  sourceName: string
  previousScene: string
}
export interface ObsSceneActions {
  current(config: LiveStreamObsConfig): Promise<string>
  canvas?(config: LiveStreamObsConfig): Promise<{width:number;height:number}>
  createScene(config: LiveStreamObsConfig, name: string): Promise<void>
  createBrowser(config: LiveStreamObsConfig, params: {
    sceneName: string; inputName: string; url: string; width: number; height: number
  }): Promise<void>
  switch(config: LiveStreamObsConfig, name: string): Promise<void>
  remove(config: LiveStreamObsConfig, name: string): Promise<void>
  /** Optional for fake transports; real OBS must confirm deletion took effect. */
  listScenes?(config: LiveStreamObsConfig): Promise<string[]>
}
const realActions: ObsSceneActions = {
  current: async config => (await getObsSceneInfo(config)).currentScene,
  canvas: getObsCanvasSize,
  createScene: createObsManagedScene,
  createBrowser: createObsBrowserInput,
  switch: async (config,name)=>{ await switchObsScene({...config,sceneName:name}) },
  remove: removeObsManagedScene,
  listScenes: async config => (await getObsSceneInfo(config)).scenes,
}
export class ManagedObsSceneController {
  constructor(private readonly actions: ObsSceneActions = realActions) {}

  async prepare(config: LiveStreamObsConfig, pageUrl: string): Promise<ManagedScene> {
    let parsed: URL
    try { parsed=new URL(pageUrl) } catch { throw new Error('OBS 媒体地址无效') }
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||
      parsed.password||!/^\/[a-f0-9]{48}\/index\.html$/u.test(parsed.pathname) || parsed.search || parsed.hash)
      throw new Error('OBS 只能使用本机受控素材输出地址')
    const previousScene=await this.actions.current(config)
    if(!previousScene) throw new Error('OBS 当前没有可恢复的场景')
    const sceneName='AI Live Commerce - '+randomUUID().slice(0,8)
    const sourceName=sceneName+' - 商品画面'
    const size=this.actions.canvas?await this.actions.canvas(config):{width:1080,height:1920}
    let created=false
    try {
      await this.actions.createScene(config,sceneName)
      created=true
      await this.actions.createBrowser(config,{
        sceneName,inputName:sourceName,url:pageUrl,width:size.width,height:size.height,
      })
      await this.actions.switch(config,sceneName)
      return {sceneName,sourceName,previousScene}
    } catch(error) {
      if(created){
        try { if(await this.actions.current(config)===sceneName) await this.actions.switch(config,previousScene) }
        catch { /* leave the source identifiable for manual cleanup */ }
        try { await this.actions.remove(config,sceneName) }
        catch { /* preserve original exception */ }
      }
      throw error
    }
  }

  async cleanup(config: LiveStreamObsConfig, item: ManagedScene): Promise<void> {
    // Never change user's currently selected scene unless it is still our own scene.
    const current=await this.actions.current(config)
    if(current===item.sceneName) await this.actions.switch(config,item.previousScene)
    // Only the unique scene created by this session is eligible for removal.
    // OBS may acknowledge RemoveScene before its scene list reflects deletion,
    // especially after sustained streaming. Verify actual state, do not report
    // success merely because the command returned HTTP/WebSocket success.
    const listScenes = this.actions.listScenes
    if (!listScenes) {
      await this.actions.remove(config,item.sceneName)
      return
    }
    if (!(await listScenes(config)).includes(item.sceneName)) return
    await this.actions.remove(config,item.sceneName)
    for (let attempt = 0; attempt < 12; attempt++) {
      const scenes = await listScenes(config)
      if (!scenes.includes(item.sceneName)) return
      // Retrying removal is limited to this session's randomly generated scene,
      // never any unrelated input or scene. The second request may be redundant
      // but can recover from OBS GUI state not yet committed.
      if (attempt === 5) {
        try { await this.actions.remove(config,item.sceneName) }
        catch {
          if (!(await listScenes(config)).includes(item.sceneName)) return
          // Preserve the genuine removal error below if the scene still exists.
        }
      }
      await new Promise<void>(resolve => setTimeout(resolve, 200))
    }
    const leftover = await listScenes(config)
    throw new Error('OBS 临时场景删除未生效：' + item.sceneName
      + '；仍存在的场景：' + leftover.join('、'))
  }
}
