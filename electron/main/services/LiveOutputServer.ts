import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { ObsAudioRelay } from './ObsAudioRelay'

export interface VisualAsset {
  id: string
  kind: 'image' | 'video'
  mime: string
  absolutePath: string
  size: number
}
export type VisualResolver = (accountId: string, mediaId: string) => VisualAsset | null
export interface PlaylistItem { id: string; durationMs?: number }

const validId = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/u.test(id)
const supported = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime',
])
const pageHtml = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Live Commerce · OBS Output</title>
<style>
html,body { margin:0; width:100%; height:100%; background:#10131b; overflow:hidden }
img,video { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; display:none }
</style></head><body>
<img id="still" alt="商品画面"><video id="moving" muted playsinline></video><audio id="voice"></audio>
<script>
const base = location.pathname.slice(0,location.pathname.lastIndexOf("/") + 1);
const image = document.getElementById("still"), video = document.getElementById("moving");
let revision=-1, playlist=[], cursor=0, timeout=null;
function reset() {
  if(timeout !== null) clearTimeout(timeout);
  timeout=null; video.pause();video.removeAttribute("src");video.load();
  image.style.display="none";video.style.display="none";
}
function advance() {
  if(!playlist.length) return;
  cursor = (cursor + 1) % playlist.length;
  playCurrent();
}
function reportReady() { fetch(base+"ready", {method:"POST"}).catch(()=>{}); }
function playCurrent() {
  reset();
  if(!playlist.length) return;
  const entry=playlist[cursor];
  if(entry.kind==="image") {
    image.onload=()=>{reportReady();timeout=setTimeout(advance,entry.durationMs)};
    image.onerror=()=>{timeout=setTimeout(advance,1000)};
    image.src=base+"media/"+encodeURIComponent(entry.id);
    image.style.display="block";
  } else {
    video.oncanplay=reportReady;
    video.onended=advance;
    video.onerror=()=>{timeout=setTimeout(advance,1000)};
    video.src=base+"media/"+encodeURIComponent(entry.id);
    video.style.display="block";
    video.muted=true;
    video.play().catch(()=>{timeout=setTimeout(advance,1000)});
  }
}
async function sync() {
  try {
    const r=await fetch(base+"playlist",{cache:"no-store"});
    if(!r.ok)return;
    const data=await r.json();
    if(data.revision!==revision){
      revision=data.revision;playlist=data.items;cursor=0;playCurrent();
    }
  }catch{}
}
sync();setInterval(sync,1000);
const speaker=document.getElementById("voice");
let audioId=null;
function stopVoice(){speaker.pause();speaker.removeAttribute("src");speaker.load()}
async function ackAudio(id,failed){
  try{await fetch(base+"audio/completed/"+encodeURIComponent(id)+(failed?"?error=1":""),{method:"POST"})}catch{}
}
async function pollAudio(){
  try {
    const r=await fetch(base+"audio/status",{cache:"no-store"});
    if(!r.ok)return;
    const state=await r.json();
    if(state.id===audioId)return;
    stopVoice();audioId=state.id;
    if(!audioId)return;
    const active=audioId;
    speaker.onended=()=>void ackAudio(active,false);
    speaker.onerror=()=>void ackAudio(active,true);
    speaker.src=base+"audio/data/"+encodeURIComponent(active);
    speaker.volume=1;
    speaker.muted=false;
    void speaker.play().catch(()=>void ackAudio(active,true));
  } catch {}
}
pollAudio();setInterval(pollAudio,200);
</script></body></html>`

const noCache: Record<string,string> = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
}

/** Session-scoped, token-protected loopback player used by OBS Browser Source.
 * Only opaque IDs from the imported media library may be served; never arbitrary paths.
 * This service contains video/pictures only. Audio readiness is a separate gate.
 */
export class LiveOutputServer {
  private server: Server | null = null
  private port = 0
  private token = randomBytes(24).toString('hex')
  private accountId: string | null = null
  private items: Array<PlaylistItem & {kind: 'image' | 'video'}> = []
  private revision = 0
  private readyRevision = -1
  // Counters intentionally contain no token, media names or URL. Used for
  // diagnosing whether real OBS CEF has requested the first playable frame.
  private requests = {index:0,playlist:0,media:0,ready:0,denied:0}
  readonly audio = new ObsAudioRelay()

  constructor(private readonly resolveVisual: VisualResolver) {}

  configure(accountId: string, requested: PlaylistItem[]): void {
    if (!validId(accountId) || !Array.isArray(requested) || requested.length < 1 || requested.length > 100)
      throw new Error('请选择有效账号及1–100项商品素材')
    const ids = new Set<string>()
    const normalized = requested.map(item => {
      if (!validId(item.id) || ids.has(item.id)) throw new Error('播放列表包含非法或重复的素材')
      ids.add(item.id)
      const asset = this.resolveVisual(accountId, item.id)
      if (!asset || asset.id !== item.id || !supported.has(asset.mime) ||
          !asset.mime.startsWith(asset.kind + '/') ||
          !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 250 * 1024 * 1024)
        throw new Error('商品图片或视频不存在或格式不受支持')
      const actual = statSync(asset.absolutePath)
      if (!actual.isFile() || actual.size !== asset.size) throw new Error('素材文件已变化，请重新导入')
      const durationMs = item.durationMs ?? 8000
      if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 120000)
        throw new Error('图片展示时间必须为1–120秒')
      return { id:item.id, kind:asset.kind, durationMs }
    })
    this.accountId = accountId
    this.items = normalized
    this.revision++
    this.readyRevision = -1
    this.requests = {index:0,playlist:0,media:0,ready:0,denied:0}
  }

  isReady(): boolean { return this.readyRevision === this.revision && this.items.length > 0 }
  diagnostics(): {index:number;playlist:number;media:number;ready:number;denied:number} {
    return {...this.requests}
  }
  async playAudio(wavBase64: string): Promise<void> {
    if(!this.server || !this.isReady()) throw new Error('OBS 画面/音频输出页面尚未就绪')
    await this.audio.play(wavBase64)
  }
  cancelAudio(): void { this.audio.cancel() }
  audioStatus(): { ready: boolean; active: boolean } {
    return {ready:this.isReady(), active:this.audio.status().id!==null}
  }
  getUrl(): string {
    if (!this.server) throw new Error('本机直播画面服务尚未启动')
    return 'http://127.0.0.1:' + this.port + '/' + this.token + '/index.html'
  }
  async start(): Promise<string> {
    if (this.server) return this.getUrl()
    const server = createServer((req,res) => this.handle(req,res))
    await new Promise<void>((resolve,reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error',reject); resolve() })
    })
    this.server = server
    this.port = (server.address() as AddressInfo).port
    return this.getUrl()
  }
  async stop(): Promise<void> {
    this.audio.cancel()
    const server = this.server
    if (!server) return
    this.server = null
    this.port = 0
    this.readyRevision = -1
    this.accountId = null
    this.items = []
    await new Promise<void>(resolve => {
      server.close(()=>resolve())
      server.closeAllConnections()
    })
    this.token = randomBytes(24).toString('hex')
  }
  private respond(res:ServerResponse, status:number, type:string, body:string):void {
    res.writeHead(status, {...noCache, 'Content-Type':type, 'Content-Length':Buffer.byteLength(body)})
    res.end(body)
  }
  private handle(req:IncomingMessage,res:ServerResponse):void {
    const denied=()=>this.respond(res,404,'text/plain','Not Found')
    if(req.headers.host !== '127.0.0.1:' + this.port){
      this.requests.denied++
      return denied()
    }
    const raw=req.url??''
    // Do not normalize ".." segments into valid routes.
    if(raw.includes('..') || raw.includes('%2e') || raw.includes('%2E') || raw.includes('%2f') || raw.includes('%2F'))
      return denied()
    let path:string
    let parsed: URL
    try{parsed=new URL(raw,'http://localhost');path=parsed.pathname}
    catch{return denied()}
    const prefix='/'+this.token+'/'
    if(!path.startsWith(prefix)){this.requests.denied++;return denied()}
    const action=path.slice(prefix.length)
    if(action==='index.html')this.requests.index++
    else if(action==='playlist')this.requests.playlist++
    else if(action==='ready')this.requests.ready++
    else if(action.startsWith('media/'))this.requests.media++
    if(action==='ready' && req.method==='POST'){
      this.readyRevision=this.revision
      return this.respond(res,204,'text/plain','')
    }
    if(action.startsWith('audio/completed/') && req.method==='POST') {
      const id=action.slice('audio/completed/'.length)
      if(!validId(id))return denied()
      const acknowledged=this.audio.complete(id,parsed.searchParams.get('error')!=='1')
      return this.respond(res,acknowledged?204:404,'text/plain','')
    }
    if(req.method!=='GET' && req.method!=='HEAD') return denied()
    if(action==='audio/status') {
      return this.respond(res,200,'application/json; charset=utf-8',JSON.stringify(this.audio.status()))
    }
    if(action.startsWith('audio/data/')){
      const id=action.slice('audio/data/'.length)
      const data=this.audio.data(id)
      if(!data || !validId(id))return denied()
      const size=data.length
      let start=0,end=size-1,status=200
      if(req.headers.range){
        const match=/^bytes=(\d+)-(\d*)$/u.exec(req.headers.range)
        if(!match){res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return}
        start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){
          res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return
        }
        status=206
      }
      res.writeHead(status,{...noCache,'Content-Type':'audio/wav','Accept-Ranges':'bytes',
        'Content-Length':end-start+1,...(status===206?{'Content-Range':'bytes '+start+'-'+end+'/'+size}:{})})
      res.end(req.method==='HEAD'?undefined:data.subarray(start,end+1))
      return
    }
    if(action==='index.html'){
      res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; connect-src 'self'")
      return this.respond(res,200,'text/html; charset=utf-8',pageHtml)
    }
    if(action==='playlist'){
      return this.respond(res,200,'application/json; charset=utf-8',JSON.stringify({revision:this.revision,items:this.items}))
    }
    const id=action.startsWith('media/')?action.slice(6):''
    if(!validId(id)||!this.accountId||!this.items.some(x=>x.id===id))return denied()
    const item=this.resolveVisual(this.accountId,id)
    if(!item||!supported.has(item.mime)||!item.mime.startsWith(item.kind+'/'))return denied()
    let size:number
    try {
      const st=statSync(item.absolutePath)
      if(!st.isFile() || st.size !== item.size) return denied()
      size=st.size
    } catch {return denied()}
    let start=0,end=size-1,status=200
    if(req.headers.range){
      const match=/^bytes=(\d+)-(\d*)$/u.exec(req.headers.range)
      if(!match){res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return}
      start=Number(match[1])
      end=match[2]?Math.min(Number(match[2]),size-1):size-1
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size){
        res.writeHead(416,{'Content-Range':'bytes */'+size});res.end();return
      }
      status=206
    }
    res.writeHead(status,{...noCache,'Content-Type':item.mime,'Accept-Ranges':'bytes',
      'Content-Length':end-start+1,...(status===206?{'Content-Range':'bytes '+start+'-'+end+'/'+size}:{})})
    if(req.method==='HEAD'){res.end();return}
    createReadStream(item.absolutePath,{start,end}).on('error',()=>res.destroy()).pipe(res)
  }
}
