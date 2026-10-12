import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProductJson, productIntro, replySystemPrompt } from '../src/features/voiceCommerce/model.ts'

test('unknown inventory is never invented', () => {
  const product = { id: '1', name: '演示产品', price: '99元', stock: '', highlights: '可水洗', faq: '' }
  assert.match(replySystemPrompt(product), /未知，不允许承诺有货/)
  assert.doesNotMatch(productIntro(product), /现货/)
})

test('imports product array', () => {
  const [product] = parseProductJson('[{"name":"商品A","price":199}]')
  assert.equal(product.name, '商品A')
  assert.equal(product.price, '199')
  assert.ok(product.id)
})

test('rejects missing product name', () => {
  assert.throws(() => parseProductJson('[{"price":"1"}]'), /缺少 name/)
  assert.throws(() => parseProductJson('{}'), /JSON 商品数组/)
})
