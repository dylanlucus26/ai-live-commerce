/** Local authorized ERP bridge adapter.
 * This software deliberately does not scrape or sign Douyin merchant endpoints.
 * Merchants can supply an independently authorized service that conforms to /inventory.
 */
export interface BridgeInventoryRow {
  sku: string
  name?: string
  price?: string
  stock?: string
}
const PORT_MIN = 1024
const PORT_MAX = 65535
const MAX_RESPONSE_BYTES = 512 * 1024

export function validateBridgePort(port: number): number {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX)
    throw new Error('库存适配服务端口必须介于 1024 和 65535')
  return port
}
export function parseBridgeInventory(raw: unknown): BridgeInventoryRow[] {
  if (!raw || typeof raw !== 'object' || !('products' in raw))
    throw new Error('库存适配服务应返回 { products: [...] }')
  const rows = (raw as { products: unknown }).products
  if (!Array.isArray(rows) || rows.length > 500) throw new Error('库存适配服务最多返回 500 个 SKU')
  const seen = new Set<string>()
  return rows.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error('库存第 ' + (index + 1) + ' 行无效')
    const row = item as Record<string, unknown>
    const sku = String(row.sku ?? '').trim()
    if (!sku || sku.length > 120 || seen.has(sku)) throw new Error('SKU 为空、过长或重复: ' + sku.slice(0, 50))
    seen.add(sku)
    const field = (key: string) =>
      (typeof row[key] === 'string' || typeof row[key] === 'number') ? String(row[key]).slice(0, 300) : ''
    return { sku, name: field('name'), price: field('price'), stock: field('stock') }
  })
}
export async function fetchBridgeInventory(port: number): Promise<BridgeInventoryRow[]> {
  validateBridgePort(port)
  const response = await fetch('http://127.0.0.1:' + port + '/inventory', {
    method: 'GET',
    signal: AbortSignal.timeout(7000),
    headers: { 'Accept': 'application/json' },
    redirect: 'error',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('本机授权库存服务响应 HTTP ' + response.status)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_RESPONSE_BYTES) throw new Error('库存服务返回数据过大')
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('库存服务返回数据过大')
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error('库存服务返回非 JSON') }
  return parseBridgeInventory(data)
}
