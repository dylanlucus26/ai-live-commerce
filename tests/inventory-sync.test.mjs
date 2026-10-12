import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyInventorySnapshot } from '../src/features/voiceCommerce/inventory.ts'
import { parseProductCsv } from '../src/features/voiceCommerce/csv.ts'

test('stock matching prioritizes SKU even when product names repeat', () => {
  const old = [
    { id:'a', sku:'SKU-A', name:'衣服', price:'99元', stock:'5', highlights:'旧卖点', faq:'' },
    { id:'b', sku:'SKU-B', name:'衣服', price:'199元', stock:'8', highlights:'旧卖点2', faq:'' },
  ]
  const rows = parseProductCsv('SKU,商品名称,价格,库存\nSKU-A,衣服,88元,7\nSKU-B,衣服,189元,20')
  const next = applyInventorySnapshot(old, rows)
  assert.equal(next.changed, 2)
  assert.equal(next.products[0].stock, '7')
  assert.equal(next.products[1].price, '189元')
  assert.equal(next.products[1].highlights, '旧卖点2')
})

test('missing, ambiguous and blank stock never invent or override data', () => {
  const old = [{ id:'a', name:'鞋', price:'99元', stock:'5', highlights:'通过质检', faq:'' }]
  const updates = [{ id:'b', name:'鞋', price:'',stock:'',highlights:'',faq:'' }]
  assert.deepEqual(applyInventorySnapshot(old, updates).products, old)
  assert.equal(applyInventorySnapshot(old,[...updates,...updates]).unmatched,1)
})
