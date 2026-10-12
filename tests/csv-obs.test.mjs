import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProductCsv, serializeProductCsv } from '../src/features/voiceCommerce/csv.ts'
import { obsAuthentication } from '../electron/main/services/ObsService.ts'
import { createHash } from 'node:crypto'

test('CSV imported from Excel supports Chinese headers, quoted comma and line breaks', () => {
  const products = parseProductCsv('\uFEFF商品名称,售价,库存,卖点,常见问题\r\n"衣服,纯棉",99元,10,"面料好,\n耐用","问：颜色？答：黑色"\r\n')
  assert.equal(products.length, 1)
  assert.equal(products[0].name, '衣服,纯棉')
  assert.equal(products[0].highlights, '面料好,\n耐用')
})

test('CSV export roundtrips and mitigates Excel formula injection', () => {
  const source = [{id:'1',name:'样品',price:'99元',stock:'10',highlights:'优秀',faq:'支持大码'}]
  const exported = serializeProductCsv(source)
  assert.equal(parseProductCsv(exported)[0].faq, '支持大码')
  assert.match(serializeProductCsv([{...source[0],name:'=HYPERLINK("x")'}]), /'=HYPERLINK/)
})

test('CSV rejects malformed header and dangling quote', () => {
  assert.throws(() => parseProductCsv('价格\n1'), /商品名称/)
  assert.throws(() => parseProductCsv('name\n"no'), /引号未闭合/)
})

test('OBS v5 authentication challenge is sha256(sha256(password+salt)+challenge)', () => {
  const hash = value => createHash('sha256').update(value).digest('base64')
  const expected = hash(hash('password' + 'salt') + 'challenge')
  assert.equal(obsAuthentication('password', 'challenge','salt'), expected)
})
