import { createConnection } from 'node:net'
import { hasEstablishedLoopbackReceiver } from './LocalTcpConnectionService'

/** Only probes a streaming service explicitly configured for loopback.
 * Checks an accepted receiver socket first (single-connection servers may stop listening).
 * A TCP handshake is used only when no established local receiver was found; it
 * does not prove it has decoded media or that remote audiences can view it.
 * Remote RTMP endpoints are deliberately never probed here.
 */
export async function probeLocalRtmpReceiver(serverUrl: unknown, timeoutMs=1000): Promise<boolean | undefined> {
  if (typeof serverUrl !== 'string' || serverUrl.length > 2048) return undefined
  let url: URL
  try { url = new URL(serverUrl) } catch { return undefined }
  if (url.protocol !== 'rtmp:' && url.protocol !== 'rtmps:') return undefined
  if (url.username || url.password) return undefined
  let host: string
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') host='127.0.0.1'
  else if (url.hostname === '[::1]') host='::1'
  else return undefined
  const port=Number(url.port || (url.protocol==='rtmps:' ? 443 : 1935))
  if (!Number.isInteger(port) || port<1 || port>65535) return undefined
  const established=await hasEstablishedLoopbackReceiver(host,port)
  if(established===true)return true
  const listening=await new Promise<boolean>(resolve => {
    let finished=false
    const socket=createConnection({host,port})
    const done=(connected:boolean)=>{
      if(finished)return
      finished=true
      socket.destroy()
      resolve(connected)
    }
    socket.setTimeout(Math.min(3000,Math.max(100,timeoutMs)),()=>done(false))
    socket.once('connect',()=>done(true))
    socket.once('error',()=>done(false))
    socket.once('close',()=>done(false))
  })
  return listening?true:established===false?false:undefined
}
