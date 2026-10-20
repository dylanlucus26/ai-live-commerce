import type { BroadcastSnapshot, LiveVisualPreviewOptions, LiveVisualPreviewSnapshot, LiveStreamSnapshot } from 'shared/liveStream'

interface Preview {
  start(options:LiveVisualPreviewOptions):Promise<LiveVisualPreviewSnapshot>
  stop(accountId:string):Promise<LiveVisualPreviewSnapshot>
  snapshot():LiveVisualPreviewSnapshot
}
interface Stream {
  start(options:LiveVisualPreviewOptions):Promise<LiveStreamSnapshot>
  stop(accountId:string):Promise<LiveStreamSnapshot>
  snapshot():LiveStreamSnapshot
  refresh():Promise<LiveStreamSnapshot>
}
const idle=():BroadcastSnapshot=>({phase:'idle',accountId:null,obsStreaming:false,visualReady:false,error:null})

/** OBS transport only; platform room state and real audio track still require external verification. */
export class LiveBroadcastController {
  private state=idle()
  private busy=false
  constructor(private readonly visual:Preview,private readonly stream:Stream){}
  snapshot():BroadcastSnapshot{return {...this.state}}
  async refresh():Promise<BroadcastSnapshot>{
    if(this.busy || this.state.phase!=='streaming')return this.snapshot()
    const status=await this.stream.refresh()
    if(!status.obsStreaming || !status.ownedByApp) {
      this.state={...this.state,phase:'failed',obsStreaming:status.obsStreaming,
        error:status.error??'OBS 推流已断开，请先确认实际输出状态'}
    }
    return this.snapshot()
  }
  async start(options:LiveVisualPreviewOptions):Promise<BroadcastSnapshot>{
    if(this.busy)throw new Error('直播启停操作正在进行')
    if(this.state.phase==='streaming'){
      if(this.state.accountId===options.accountId)return this.snapshot()
      throw new Error('其他账号正在推流，请先结束原会话')
    }
    if(this.stream.snapshot().ownedByApp || this.visual.snapshot().previewing)
      throw new Error('已有独立的 OBS 推流或预览任务，请先结束后再一键启动')
    this.busy=true
    this.state={phase:'preparing',accountId:options.accountId,obsStreaming:false,visualReady:false,error:null}
    try {
      const ready=await this.visual.start(options)
      if(!ready.visualReady)throw new Error('OBS 画面尚未就绪，禁止推流')
      this.state={...this.state,visualReady:true}
      const started=await this.stream.start(options)
      if(!started.obsStreaming || !started.ownedByApp)
        throw new Error('OBS 未确认本次推流启动成功')
      this.state={...this.state,phase:'streaming',obsStreaming:true}
      return this.snapshot()
    }catch(error){
      try{if(this.stream.snapshot().ownedByApp)await this.stream.stop(options.accountId)}catch{/* leave ownership intact for manual recovery */}
      try{if(!this.stream.snapshot().ownedByApp && this.visual.snapshot().previewing)
        await this.visual.stop(options.accountId)}catch{/* error state remains visible */}
      this.state={...this.state,phase:'failed',obsStreaming:this.stream.snapshot().obsStreaming,
        visualReady:this.visual.snapshot().visualReady,
        error:error instanceof Error?error.message:'OBS 一键推流失败'}
      throw error
    }finally{this.busy=false}
  }
  async stop(accountId:string):Promise<BroadcastSnapshot>{
    if(this.busy)throw new Error('直播操作正在进行')
    if(this.state.accountId && this.state.accountId!==accountId)
      throw new Error('当前账号无法停止其他账号的直播')
    this.busy=true
    this.state={...this.state,phase:'stopping',error:null}
    try{
      if(this.stream.snapshot().ownedByApp)await this.stream.stop(accountId)
      if(this.visual.snapshot().previewing)await this.visual.stop(accountId)
      this.state=idle()
      return this.snapshot()
    }catch(error){
      this.state={...this.state,phase:'failed',obsStreaming:this.stream.snapshot().obsStreaming,
        error:error instanceof Error?error.message:'停止 OBS 推流失败'}
      throw error
    }finally{this.busy=false}
  }
}
