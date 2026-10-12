import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'

const VALID_ACCOUNT = /^[a-zA-Z0-9_-]{1,120}$/u
const MAX_BYTES = 7 * 1024 * 1024 // Base64 stays below MiMo's 10 MB upload limit.
function refPath(accountId: string): string {
  if (!VALID_ACCOUNT.test(accountId)) throw new Error('无效的账号')
  const name = createHash('sha256').update(accountId).digest('hex')
  return path.join(app.getPath('userData'), 'voice-references', name + '.enc')
}
export function hasVoiceReference(accountId: string): boolean { return existsSync(refPath(accountId)) }
export function deleteVoiceReference(accountId: string): boolean {
  rmSync(refPath(accountId), { force: true })
  return true
}
export async function chooseVoiceReference(accountId: string, consent: boolean): Promise<boolean> {
  if (!consent) throw new Error('仅可克隆本人或已经取得明确授权的主播声音')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 当前不支持安全加密保存声音样本')
  const win = BrowserWindow.getFocusedWindow()
  const options = {
    title: '导入已授权主播声音样本',
    filters: [{ name: 'MP3 或 WAV', extensions: ['mp3', 'wav'] }],
    properties: ['openFile'] as Array<'openFile'>,
  }
  const selected = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (selected.canceled || selected.filePaths.length !== 1) return false
  const file = selected.filePaths[0]
  const ext = path.extname(file).toLowerCase()
  if (!['.mp3', '.wav'].includes(ext)) throw new Error('仅支持 MP3/WAV')
  const buf = readFileSync(file)
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('请使用小于 7MB 的干净人声音频')
  const mime = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav'
  const payload = JSON.stringify({ mime, content: buf.toString('base64') })
  const dest = refPath(accountId)
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, safeStorage.encryptString(payload), { mode: 0o600 })
  return true
}
export function getAuthorizedVoiceDataURL(accountId: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用')
  const p = refPath(accountId)
  if (!existsSync(p)) throw new Error('请先导入已授权的主播人声样本')
  let obj: { mime: string; content: string }
  try { obj = JSON.parse(safeStorage.decryptString(readFileSync(p))) } catch { throw new Error('主播声音样本解密失败') }
  if (!['audio/mpeg', 'audio/wav'].includes(obj.mime) || typeof obj.content !== 'string' ||
      obj.content.length > 10 * 1024 * 1024) throw new Error('存储的声音样本不符合 MiMo 要求')
  return 'data:' + obj.mime + ';base64,' + obj.content
}
