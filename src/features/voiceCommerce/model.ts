/**
 * AI 语音带货的商品资料只作为已核实的事实来源。
 * 价格/库存/优惠没有配置时，禁止模型自行编造。
 */
export interface CommerceProduct {
  id: string
  sku?: string
  name: string
  price: string
  stock: string
  highlights: string
  faq: string
  script?: string
}

export function createProduct(): CommerceProduct {
  return { id: crypto.randomUUID(), sku: '', name: '', price: '', stock: '', highlights: '', faq: '', script: '' }
}

export function productFacts(product: CommerceProduct): string {
  return [
    `商品名称：${product.name.trim() || '未填写'}`,
    `实际售价：${product.price.trim() || '未知，不允许报价'}`,
    `库存：${product.stock.trim() || '未知，不允许承诺有货'}`,
    `已核实卖点：${product.highlights.trim() || '未填写'}`,
    `常见问题与已核实答案：\n${product.faq.trim() || '未填写'}`,
  ].join('\n')
}

export function productIntro(product: CommerceProduct): string {
  const lines = [`大家好，现在介绍${product.name.trim() || '这款商品'}。`]
  if (product.highlights.trim()) lines.push(product.highlights.trim())
  if (product.price.trim()) lines.push(`当前商品资料显示价格为${product.price.trim()}，实际请以商品页面为准。`)
  lines.push('关于尺寸、库存和使用问题，欢迎在直播间提问。')
  return lines.join(' ')
}

export function replySystemPrompt(product: CommerceProduct): string {
  return [
    '你是直播带货辅助客服。请只使用以下经商家确认的商品资料回复观众，使用简短自然的中文，最多80字。',
    '不要捏造价格、库存、折扣、功效、发货承诺或官方背书。',
    '缺少信息时明确说暂不能确认，并请观众查看商品详情或咨询人工。',
    '不要主动催促购买，不要出现虚假的稀缺性描述。',
    productFacts(product),
  ].join('\n\n')
}

export function parseProductJson(input: string): CommerceProduct[] {
  const raw: unknown = JSON.parse(input)
  if (!Array.isArray(raw)) throw new Error('请选择 JSON 商品数组文件')
  if (raw.length > 500) throw new Error('最多导入 500 件商品')
  return raw.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`第 ${index + 1} 条不是商品对象`)
    }
    const item = row as Record<string, unknown>
    const field = (key: string) =>
      typeof item[key] === 'string' || typeof item[key] === 'number'
        ? String(item[key]).slice(0, 6000)
        : ''
    const name = field('name').trim()
    if (!name) throw new Error(`第 ${index + 1} 条缺少 name`)
    return {
      id: field('id') || crypto.randomUUID(),
      sku: field('sku'),
      name,
      price: field('price'),
      stock: field('stock'),
      highlights: field('highlights'),
      faq: field('faq'),
      script: field('script'),
    }
  })
}
