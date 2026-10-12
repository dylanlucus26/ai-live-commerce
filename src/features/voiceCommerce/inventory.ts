import type { CommerceProduct } from './model'

/**
 * Updates only verifiable price/stock, never overwrites marketing descriptions.
 * Match by SKU first, then unique exact name for legacy product lists.
 */
export function applyInventorySnapshot(
  products: CommerceProduct[],
  incoming: CommerceProduct[],
): { products: CommerceProduct[]; changed: number; unmatched: number } {
  const bySku = new Map<string, CommerceProduct[]>()
  const byName = new Map<string, CommerceProduct[]>()
  for (const item of incoming) {
    const sku = (item.sku ?? '').trim()
    const name = item.name.trim()
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), item])
    if (name) byName.set(name, [...(byName.get(name) ?? []), item])
  }
  let changed = 0
  let unmatched = 0
  const updates = products.map(item => {
    const sku = (item.sku ?? '').trim()
    const candidates = sku ? (bySku.get(sku) ?? []) : (byName.get(item.name.trim()) ?? [])
    if (candidates.length !== 1) { unmatched++; return item }
    const source = candidates[0]
    const price = source.price.trim() || item.price
    const stock = source.stock.trim() || item.stock
    if (price === item.price && stock === item.stock) return item
    changed++
    return { ...item, price, stock }
  })
  return { products: updates, changed, unmatched }
}
