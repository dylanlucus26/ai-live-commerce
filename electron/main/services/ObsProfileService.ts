import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { LiveStreamObsConfig } from 'shared/liveStream'

const safeId=(account:string)=>/^[a-zA-Z0-9_-]{1,120}$/u.test(account)
const pathFor=(account:string)=>{
  if(!safeId(account))throw new Error('OBS 配置账号无效')
  const hash=createHash('sha256').update(account).digest('hex').slice(0,24)
  return join(app.getPath('userData'),'obs-profiles',hash+'.enc')
}
const requireEncryption=()=>{
  if(!safeStorage.isEncryptionAvailable())
    throw new Error('系统安全存储不可用，不允许明文保存 OBS 密码')
}
export function saveObsProfile(accountId:string,config:LiveStreamObsConfig,accepted:boolean):boolean {
  requireEncryption()
  if(!accepted)throw new Error('请先确认你有权使用当前推流服务')
  if(!Number.isInteger(config.port)||config.port<1024||config.port>65535||
    typeof config.password!=='string'||config.password.length>256)
    throw new Error('OBS WebSocket 配置不合法')
  const filename=pathFor(accountId)
  mkdirSync(join(app.getPath('userData'),'obs-profiles'),{recursive:true})
  const encoded=safeStorage.encryptString(JSON.stringify({port:config.port,password:config.password}))
  writeFileSync(filename,encoded,{mode:0o600})
  return true
}
export function loadObsProfile(accountId:string):LiveStreamObsConfig {
  requireEncryption()
  const filename=pathFor(accountId)
  if(!existsSync(filename))throw new Error('请先在 OBS 设置里保存授权连接配置')
  try{
    const raw=safeStorage.decryptString(readFileSync(filename))
    const data:unknown=JSON.parse(raw)
    if(!data||typeof data!=='object')throw Error('bad type')
    const obj=data as Record<string,unknown>
    if(!Number.isInteger(obj.port)||Number(obj.port)<1024||Number(obj.port)>65535||
      typeof obj.password!=='string'||obj.password.length>256)throw Error('bad payload')
    return {port:Number(obj.port),password:obj.password}
  }catch{
    throw new Error('OBS 安全配置无法解密，请重新保存')
  }
}
export function obsProfileInfo(accountId:string):{configured:boolean;port:number|null}{
  const filename=pathFor(accountId)
  if(!existsSync(filename))return {configured:false,port:null}
  const value=loadObsProfile(accountId)
  return {configured:true,port:value.port}
}
