import type { CommerceProduct } from './model'

/** MiMo 的非流式音频较长时延迟明显，分句且限制每个 API 请求长度。 */
export function splitSpeechText(value: string, limit = 160): string[] {
  if (!Number.isInteger(limit) || limit < 20) throw new Error('limit must be at least 20')
  const input = value.replace(/\s+/g, ' ').trim()
  if (!input) return []
  const clauses = input.match(/[^。！？；;，,]+[。！？；;，,]?/gu) ?? [input]
  const result: string[] = []
  let current = ''
  for (const clause of clauses) {
    const chars = Array.from(clause)
    for (let start = 0; start < chars.length; start += limit) {
      const part = chars.slice(start, start + limit).join('').trim()
      if (!part) continue
      if (current && Array.from(current + part).length > limit) {
        result.push(current)
        current = ''
      }
      current += part
    }
  }
  if (current.trim()) result.push(current.trim())
  return result
}

export function makePitchPlaylist(product: CommerceProduct): string[] {
  if (!product.name.trim()) return []
  const sentences = [
    "大家好，接下来为大家介绍" + product.name.trim() + "。",
    product.highlights.trim(),
    product.price.trim() ? "商品资料显示这款售价为" + product.price.trim() + "，下单前请以实际商品页面为准。" : '',
    "关于规格和使用方法，欢迎大家提问，具体情况请以商品详情为准。",
  ].filter(Boolean)
  return sentences.flatMap(sentence => splitSpeechText(sentence))
}

/** 丢弃最早等待的评论，避免高并发弹幕形成无限播放积压。 */
export function appendBounded(queue: string[], value: string, limit = 8): string[] {
  const newItems = splitSpeechText(value).filter(Boolean)
  return [...queue, ...newItems].slice(-Math.max(1, limit))
}
