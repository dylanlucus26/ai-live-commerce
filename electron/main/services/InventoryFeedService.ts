import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
const settings = (account: string) => {
  if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(account)) throw new Error('账号标识无效')
  return path.join(app.getPath('userData'), 'inventory-feeds', hash(account) + '.json')
}
function source(account: string): string | null {
  const file = settings(account)
  if (!existsSync(file)) return null
  const parsed: unknown = JSON.parse(readFileSync(file,'utf8'))
  if (typeof parsed !== 'object' || parsed === null || !('file' in parsed) || typeof parsed.file !== 'string') return null
  return parsed.file
}
export async function selectInventoryFile(account: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const opts = {
    title: '选择商家已授权的商品库存导出文件',
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: '商品 CSV / JSON', extensions: ['csv','json'] }],
  }
  const selection = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (selection.canceled || selection.filePaths.length !== 1) return null
  const file = selection.filePaths[0]
  if (!['.csv','.json'].includes(path.extname(file).toLowerCase())) throw new Error('只支持 CSV 或 JSON')
  const stat = statSync(file)
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('库存文件必须小于 1MB')
  mkdirSync(path.dirname(settings(account)), { recursive: true })
  writeFileSync(settings(account), JSON.stringify({ file }), { mode: 0o600 })
  return path.basename(file)
}
export function readInventoryFile(account: string): { content: string; extension: string; filename: string; modifiedAt: number } {
  const file = source(account)
  if (!file) throw new Error('请先选择库存数据源（CSV/JSON）')
  if (!['.csv','.json'].includes(path.extname(file).toLowerCase())) throw new Error('库存数据格式无效')
  if (!existsSync(file)) throw new Error('库存数据源不存在，请重新选择')
  const stat = statSync(file)
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('库存文件必须小于 1MB')
  return {
    content: readFileSync(file,'utf8'),
    extension: path.extname(file).toLowerCase(),
    filename: path.basename(file),
    modifiedAt: stat.mtimeMs,
  }
}
export function inventorySourceName(account: string): string | null {
  const file = source(account)
  return file ? path.basename(file) : null
}
export function clearInventorySource(account: string): boolean {
  const file = settings(account)
  if (existsSync(file)) writeFileSync(file, JSON.stringify({ file: '' }))
  return true
}
