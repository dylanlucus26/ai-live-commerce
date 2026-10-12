import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateBridgePort, parseBridgeInventory } from '../electron/main/services/LocalInventoryBridgeService.ts'

test('local authorized bridge rejects unsafe ports', () => {
  for (const port of [-1, 80, 0, 65536, 12.3, NaN]) assert.throws(() => validateBridgePort(port))
  assert.equal(validateBridgePort(18080), 18080)
})
test('local authorized bridge enforces unique SKU', () => {
  const rows = parseBridgeInventory({ products: [{ sku: 'A01', price: 99, stock: 10 }] })
  assert.deepEqual(rows, [{ sku: 'A01', name: '', price: '99', stock: '10' }])
  assert.throws(() => parseBridgeInventory({ products: [{ sku: 'A' }, { sku: 'A' }] }), /重复/)
  assert.throws(() => parseBridgeInventory({ nope: [] }), /products/)
})
