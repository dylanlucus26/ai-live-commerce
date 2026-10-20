import type { LiveVisualPreviewOptions, LiveVisualPreviewSnapshot, LiveStreamObsConfig } from 'shared/liveStream'
import type { ManagedScene } from './ManagedObsSceneController'
import type { PlaylistItem } from './LiveOutputServer'

interface Output {
  configure(accountId: string, items: PlaylistItem[]): void
  start(): Promise<string>
  stop(): Promise<void>
  isReady(): boolean
}
interface Scene {
  prepare(config: LiveStreamObsConfig, url: string): Promise<ManagedScene>
  cleanup(config: LiveStreamObsConfig, scene: ManagedScene): Promise<void>
}
type StatusFn = (config: LiveStreamObsConfig) => Promise<{active:boolean}>
const pause = (ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
const empty = (): LiveVisualPreviewSnapshot => ({
  accountId:null,previewing:false,visualReady:false,obsScene:null,error:null,
})

/** Preview stage creates OBS visuals but NEVER starts the OBS stream. */
export class VisualPreviewController {
  private owner: {accountId:string;config:LiveStreamObsConfig;scene:ManagedScene} | null=null
  private state=empty()
  private busy=false
  constructor(
    private readonly output:Output,
    private readonly scenes:Scene,
    private readonly streamStatus:StatusFn,
  ) {}
  snapshot():LiveVisualPreviewSnapshot{return {...this.state}}

  async start(options:LiveVisualPreviewOptions):Promise<LiveVisualPreviewSnapshot>{
    if(this.busy)throw new Error('画面预览操作正在进行')
    if(this.owner) {
      if(this.owner.accountId===options.accountId)return this.snapshot()
      throw new Error('当前存在其他账号的 OBS 画面预览')
    }
    if(!/^[a-zA-Z0-9_-]{1,120}$/u.test(options.accountId))throw new Error('直播账号无效')
    this.busy=true
    const config={port:options.port,password:options.password}
    let created:ManagedScene|null=null
    try{
      if((await this.streamStatus(config)).active)
        throw new Error('OBS 正在推流，不能切换为预览场景')
      this.output.configure(options.accountId,options.mediaIds.map(id=>({id})))
      const url=await this.output.start()
      created=await this.scenes.prepare(config,url)
      // CEF Browser Source must actually load an image or video before ready=true.
      for(let i=0;i<60&&!this.output.isReady();i++)await pause(200)
      if(!this.output.isReady())throw new Error('OBS 画面未就绪，请检查 Browser Source 是否正常加载')
      this.owner={accountId:options.accountId,config,scene:created}
      this.state={accountId:options.accountId,previewing:true,visualReady:true,
        obsScene:created.sceneName,error:null}
      return this.snapshot()
    }catch(error){
      if(created){
        try{await this.scenes.cleanup(config,created)}catch{/* keep original error */}
      }
      await this.output.stop()
      this.owner=null
      this.state={...empty(),error:error instanceof Error?error.message:'OBS 画面预览失败'}
      throw error
    }finally{this.busy=false}
  }

  async stop(accountId:string):Promise<LiveVisualPreviewSnapshot>{
    if(this.busy)throw new Error('预览操作正在进行')
    if(!this.owner)return this.snapshot()
    if(this.owner.accountId!==accountId)throw new Error('账号不匹配，不能关闭其他账号的预览')
    this.busy=true
    try {
      const owner=this.owner
      if((await this.streamStatus(owner.config)).active)
        throw new Error('OBS 已在推流，请先停止推流再清理预览场景')
      await this.scenes.cleanup(owner.config,owner.scene)
      await this.output.stop()
      this.owner=null
      this.state=empty()
      return this.snapshot()
    }catch(error){
      this.state={...this.state,error:error instanceof Error?error.message:'结束预览失败'}
      throw error
    }finally{this.busy=false}
  }
}
