import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getObsStreamStatus } from './ObsService'
import type { LiveStreamObsConfig } from 'shared/liveStream'

export interface ObsProcessActions {
  probe(config:LiveStreamObsConfig):Promise<void>
  launch():Promise<void>
}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
const defaultActions: ObsProcessActions={
  probe: async config=>{await getObsStreamStatus(config)},
  launch:async()=>{
    if(process.platform==='darwin'){
      const location='/Applications/OBS.app'
      if(!existsSync(location)) throw new Error('未找到 OBS Studio，请先安装 OBS')
      await new Promise<void>((resolve,reject)=>{
        const proc=spawn('/usr/bin/open',['-a',location],{stdio:'ignore'})
        proc.once('error',reject)
        proc.once('close',code=>code===0?resolve():reject(new Error('macOS 启动 OBS 失败')))
      })
      return
    }
    if(process.platform==='win32'){
      const programFiles=process.env['ProgramFiles']??'C:\\Program Files'
      const x86=process.env['ProgramFiles(x86)']??'C:\\Program Files (x86)'
      const options=[join(programFiles,'obs-studio','bin','64bit','obs64.exe'),
        join(x86,'obs-studio','bin','64bit','obs64.exe')]
      const executable=options.find(path=>existsSync(path))
      if(!executable)throw new Error('未找到 OBS Studio，请先安装 OBS')
      await new Promise<void>((resolve,reject)=>{
        const proc=spawn(executable,[],{cwd:dirname(executable),detached:true,windowsHide:true,stdio:'ignore'})
        proc.once('error',reject)
        proc.once('spawn',()=>{proc.unref();resolve()})
      })
      return
    }
    throw new Error('当前系统不支持自动启动 OBS')
  },
}

/** Auto-opens local OBS if it is not running. Never force closes the user's OBS process. */
export class ObsProcessManager {
  constructor(private readonly actions:ObsProcessActions=defaultActions){}
  async ensureReady(config:LiveStreamObsConfig, attempts=30, intervalMs=500):Promise<void>{
    try{await this.actions.probe(config);return}
    catch(error){
      const message=error instanceof Error?error.message:''
      if(/密码|拒绝操作|端口范围/u.test(message))throw error
    }
    await this.actions.launch()
    let last:unknown
    for(let i=0;i<attempts;i++){
      try{await this.actions.probe(config);return}
      catch(error){last=error}
      await sleep(intervalMs)
    }
    throw new Error('OBS 已尝试启动，但 WebSocket 尚未就绪：'+(last instanceof Error?last.message:'请检查端口和密码'))
  }
}
