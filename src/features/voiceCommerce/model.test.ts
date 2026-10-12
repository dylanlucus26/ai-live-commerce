import { describe, expect, it, vi } from 'vitest'
import { parseProductJson, productIntro, replySystemPrompt } from './model'

vi.stubGlobal('crypto', { randomUUID: () => 'demo-id' })

describe('voice commerce product facts', () => {
  const sample = { id: '1', name: '演示产品', price: '99元', stock: '', highlights: '可水洗', faq: '保修多久？|请以详情页为准' }
  it('never invents a missing stock value', () => {
    expect(replySystemPrompt(sample)).toContain('未知，不允许承诺有货')
    expect(productIntro(sample)).not.toContain('现货')
  })
  it('imports a validated product array', () => {
    expect(parseProductJson('[{"name":"产品A","price":199}]')[0]).toMatchObject({ id: 'demo-id', name: '产品A', price: '199' })
  })
  it('rejects invalid product records', () => {
    expect(() => parseProductJson('[{"price":"1"}]')).toThrow('缺少 name')
    expect(() => parseProductJson('{}')).toThrow('JSON 商品数组')
  })
})
