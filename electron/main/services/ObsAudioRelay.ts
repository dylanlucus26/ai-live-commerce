import { randomUUID } from 'node:crypto'

interface ActiveAudio {
  id: string
  data: Buffer
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const MAX_BYTES=6*1024*1024
/** One uncompressed WAV clip at a time. The browser source must acknowledge completion. */
export class ObsAudioRelay {
  private active: ActiveAudio | null=null

  status(): {id:string|null} { return {id:this.active?.id??null} }
  data(id:string): Buffer|null { return this.active?.id===id?this.active.data:null }
  async play(wavBase64:string, timeoutMs=60000):Promise<void> {
    if(this.active)throw new Error('OBS 语音通道忙碌，无法重复播放')
    if(typeof wavBase64!=='string'||wavBase64.length>MAX_BYTES*1.4||
      wavBase64.length%4!==0||!/^[a-zA-Z0-9+/]*={0,2}$/u.test(wavBase64))
      throw new Error('不允许无效或过大的语音数据')
    const data=Buffer.from(wavBase64,'base64')
    if(data.length<12||data.length>MAX_BYTES||
      data.subarray(0,4).toString('ascii')!=='RIFF'||
      data.subarray(8,12).toString('ascii')!=='WAVE')
      throw new Error('OBS 只支持有效的 WAV 音频数据')
    return new Promise<void>((resolve,reject)=>{
      const id=randomUUID()
      const timer=setTimeout(()=>{
        if(this.active?.id!==id)return
        this.active=null
        reject(new Error('OBS 语音播放超时，未收到播放完成回执'))
      },Math.max(1000,Math.min(timeoutMs,120000)))
      this.active={id,data,resolve,reject,timer}
    })
  }
  complete(id:string,success:boolean):boolean {
    const current=this.active
    if(!current || current.id!==id)return false
    this.active=null
    clearTimeout(current.timer)
    if(success)current.resolve()
    else current.reject(new Error('OBS Browser Source 无法播放语音'))
    return true
  }
  cancel():void {
    const current=this.active
    if(!current)return
    this.active=null
    clearTimeout(current.timer)
    current.reject(new Error('OBS 语音播放已取消'))
  }
}
