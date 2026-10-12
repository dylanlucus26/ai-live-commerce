import { parseProductJson } from './model'
import type { CommerceProduct } from './model'

const HEADER_ALIASES: Record<string, keyof CommerceProduct> = {
  id: 'id', '编号': 'id', '商品编号': 'id',
  sku: 'sku', 'SKU': 'sku', '商品SKU': 'sku', '商家编码': 'sku',
  name: 'name', '商品名称': 'name', '名称': 'name',
  price: 'price', '售价': 'price', '价格': 'price',
  stock: 'stock', '库存': 'stock', '库存说明': 'stock',
  highlights: 'highlights', '卖点': 'highlights', '商品卖点': 'highlights',
  faq: 'faq', 'FAQ': 'faq', '常见问题': 'faq',
}

function readCsvRows(text: string): string[][] {
  const result: string[][] = []
  const raw = text.replace(/^\uFEFF/u, '')
  let row: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') { current += '"'; i++ }
      else if (ch === '"') quoted = false
      else current += ch
    } else if (ch === '"' && current.length === 0) quoted = true
    else if (ch === ',') { row.push(current); current = '' }
    else if (ch === '\n' || ch === '\r') {
      row.push(current)
      if (row.some(v => v.trim())) result.push(row)
      row = []
      current = ''
      if (ch === '\r' && raw[i + 1] === '\n') i++
    } else current += ch
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  row.push(current)
  if (row.some(v => v.trim())) result.push(row)
  return result
}

export function parseProductCsv(csv: string): CommerceProduct[] {
  const rows = readCsvRows(csv)
  if (!rows.length) return []
  const header = rows.shift() ?? []
  const mapping = header.map(x => HEADER_ALIASES[x.trim()] ?? null)
  if (!mapping.includes('name')) throw new Error('CSV 第一行必须包含 name 或 商品名称 列')
  if (rows.length > 500) throw new Error('最多导入 500 件商品')
  const objects = rows.map((row, index) => {
    const obj: Record<string, string> = {}
    for (let col = 0; col < mapping.length; col++) {
      const key = mapping[col]
      if (key) obj[key] = (row[col] ?? '').trim()
    }
    if (!obj.name) throw new Error('CSV 第 ' + (index + 2) + ' 行缺少商品名称')
    return obj
  })
  return parseProductJson(JSON.stringify(objects))
}

export function serializeProductCsv(products: CommerceProduct[]): string {
  const fields = ['sku','name','price','stock','highlights','faq'] as const
  const cell = (value: string) => {
    const safe = /^[=+@\-\t\r]/u.test(value.trimStart()) ? "'" + value : value
    return '"' + safe.replace(/"/gu, '""') + '"'
  }
  return '\uFEFF' + [
    fields.join(','),
    ...products.map(p => fields.map(key => cell(p[key] ?? '')).join(',')),
  ].join('\r\n')
}
