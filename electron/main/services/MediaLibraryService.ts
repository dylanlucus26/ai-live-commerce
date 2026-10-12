import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { app, dialog, protocol, BrowserWindow } from 'electron'

type Kind = 'audio' | 'video'
export interface StoredMedia {
  id: string
  name: string
  kind: Kind
  mime: string
  size: number
  createdAt: string
  url: string
}
interface InternalMedia extends Omit<StoredMedia, 'url'> { ext: string }
const validId = (v: string) => /^[a-zA-Z0-9_-]{1,120}$/u.test(v)
const allowed: Record<Kind, Record<string, string>> = {
  audio: { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' },
  video: { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' },
}
const hashAccount = (account: string) => createHash('sha256').update(account).digest('hex').slice(0, 32)
const folder = (account: string) => {
  if (!validId(account)) throw new Error('账号标识无效')
  return path.join(app.getPath('userData'), 'media-library', hashAccount(account))
}
const metadataPath = (account: string) => path.join(folder(account), 'assets.json')
function load(account: string): InternalMedia[] {
  const p = metadataPath(account)
  if (!existsSync(p)) return []
  const data: unknown = JSON.parse(readFileSync(p, 'utf8'))
  if (!Array.isArray(data)) throw new Error('本地素材元数据损坏')
  return data.filter(v => v && validId(v.id) && ['audio','video'].includes(v.kind) && typeof v.ext === 'string') as InternalMedia[]
}
function save(account: string, assets: InternalMedia[]): void {
  mkdirSync(folder(account), { recursive: true })
  const file = metadataPath(account)
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify(assets, null, 2))
  renameSync(temp, file)
}
function toPublic(account: string, asset: InternalMedia): StoredMedia {
  return {
    id: asset.id, name: asset.name, kind: asset.kind, mime: asset.mime,
    size: asset.size, createdAt: asset.createdAt,
    url: 'app-media://library/' + hashAccount(account) + '/' + asset.id,
  }
}
export function listMedia(account: string): StoredMedia[] {
  return load(account).map(v => toPublic(account, v))
}
export async function importMedia(account: string, kind: Kind): Promise<StoredMedia | null> {
  if (kind !== 'audio' && kind !== 'video') throw new Error('不支持的素材类型')
  const window = BrowserWindow.getFocusedWindow()
  const filters = [{ name: kind === 'audio' ? '主播录音' : '商品视频', extensions: Object.keys(allowed[kind]).map(v => v.slice(1)) }]
  const result = window
    ? await dialog.showOpenDialog(window, { title: '添加本地素材', properties: ['openFile'], filters })
    : await dialog.showOpenDialog({ title: '添加本地素材', properties: ['openFile'], filters })
  if (result.canceled || result.filePaths.length !== 1) return null
  const selected = result.filePaths[0]
  const ext = path.extname(selected).toLowerCase()
  const mime = allowed[kind][ext]
  if (!mime) throw new Error('不支持此素材格式')
  const stat = statSync(selected)
  if (!stat.isFile() || stat.size <= 0 || stat.size > (kind === 'audio' ? 60 : 250) * 1024 * 1024) {
    throw new Error('音频必须小于 60MB，视频必须小于 250MB')
  }
  const id = randomUUID()
  const entry: InternalMedia = {
    id, ext, kind, mime, size: stat.size, createdAt: new Date().toISOString(),
    name: path.basename(selected).slice(0, 160),
  }
  const destDir = folder(account)
  mkdirSync(destDir, { recursive: true })
  const dest = path.join(destDir, id + ext)
  copyFileSync(selected, dest)
  try { save(account, [...load(account), entry]) } catch (e) { rmSync(dest, { force: true }); throw e }
  return toPublic(account, entry)
}
export function deleteMedia(account: string, id: string): boolean {
  if (!validId(id)) throw new Error('素材标识无效')
  const assets = load(account)
  const item = assets.find(v => v.id === id)
  if (!item) return false
  save(account, assets.filter(v => v.id !== id))
  rmSync(path.join(folder(account), item.id + item.ext), { force: true })
  return true
}
export function registerMediaProtocol(): void {
  protocol.handle('app-media', request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    const url = new URL(request.url)
    if (url.hostname !== 'library' || url.search || url.hash) return new Response(null, { status: 404 })
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length !== 2 || !/^[a-f0-9]{32}$/u.test(parts[0]) || !validId(parts[1])) {
      return new Response(null, { status: 404 })
    }
    const accountFolder = path.join(app.getPath('userData'), 'media-library', parts[0])
    const metaPath = path.join(accountFolder, 'assets.json')
    if (!existsSync(metaPath)) return new Response(null, { status: 404 })
    let assets: InternalMedia[]
    try {
      const data: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
      if (!Array.isArray(data)) throw new Error('Invalid metadata')
      assets = data as InternalMedia[]
    } catch {
      return new Response(null, { status: 404 })
    }
    const entry = assets.find(v => v.id === parts[1] && ['audio','video'].includes(v.kind) &&
      allowed[v.kind]?.[v.ext] === v.mime)
    if (!entry) return new Response(null, { status: 404 })
    const file = path.join(accountFolder, entry.id + entry.ext)
    if (!existsSync(file)) return new Response(null, { status: 404 })
    const size = statSync(file).size
    const range = request.headers.get('range')
    let start = 0
    let end = size - 1
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/u.exec(range)
      if (!m) return new Response(null, { status: 416 })
      start = Number(m[1]); end = m[2] ? Number(m[2]) : end
      if (start >= size || end < start || end >= size) return new Response(null, { status: 416 })
    }
    const headers: Record<string,string> = {
      'Content-Type': entry.mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'no-store',
    }
    if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size
    if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream
    return new Response(stream, { status: range ? 206 : 200, headers })
  })
}
