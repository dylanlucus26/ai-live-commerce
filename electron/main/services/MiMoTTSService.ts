import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

export type TtsVoice = 'mimo_default' | '冰糖' | '茉莉' | '苏打' | '白桦' | 'Mia' | 'Chloe' | 'Milo' | 'Dean'
const VOICES = new Set<TtsVoice>(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])
const ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions'
const MAX_AUDIO_BASE64 = 12 * 1024 * 1024
const cache = new Map<string, string>()

function pathToSecret() {
  return join(app.getPath('userData'), 'mimo-tts-key.enc')
}
function ensureStorage() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全密钥存储不可用，请使用已解锁的系统账号')
}

export function saveMiMoKey(key: string): void {
  ensureStorage()
  const value = key.trim()
  if (!value || value.length > 2048 || /[\r\n]/u.test(value)) throw new Error('MiMo API Key 格式不正确')
  const target = pathToSecret()
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(target, safeStorage.encryptString(value).toString('base64'), { mode: 0o600 })
  cache.clear()
}
export function hasMiMoKey(): boolean {
  return existsSync(pathToSecret())
}
export function clearMiMoKey(): void {
  rmSync(pathToSecret(), { force: true })
  cache.clear()
}
function loadKey(): string {
  ensureStorage()
  if (!hasMiMoKey()) throw new Error('请先在语音设置中保存 MiMo API Key')
  try {
    return safeStorage.decryptString(Buffer.from(readFileSync(pathToSecret(), 'utf8'), 'base64'))
  } catch {
    throw new Error('MiMo 密钥无法解密，请重新保存')
  }
}

export interface SynthesisInput {
  text: string
  voice: string
  style: string
}
export async function synthesizeMiMo(input: SynthesisInput): Promise<{ audioBase64: string; mimeType: 'audio/wav' }> {
  const text = input.text.trim()
  if (!text || Array.from(text).length > 180) throw new Error('MiMo 单段文字不能超过 180 字')
  if (!VOICES.has(input.voice as TtsVoice)) throw new Error('MiMo 音色配置无效')
  if (input.style.length > 200) throw new Error('声音风格描述过长')
  const key = loadKey()
  const cacheKey = JSON.stringify([text, input.voice, input.style])
  const hit = cache.get(cacheKey)
  if (hit) {
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)
    return { audioBase64: hit, mimeType: 'audio/wav' }
  }

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        messages: [
          { role: 'user', content: input.style.trim() || '自然、清晰、适合中文商品讲解的语调。' },
          { role: 'assistant', content: text },
        ],
        audio: { format: 'wav', voice: input.voice },
        stream: false,
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('MiMo TTS 请求超时')
    throw new Error('无法连接 MiMo 语音服务，请检查网络')
  }
  // 故意不返回供应商错误正文，避免意外包含用户数据或密钥。
  if (!response.ok) throw new Error('MiMo TTS API 返回 HTTP ' + response.status + '，请检查密钥和额度')
  if (Number(response.headers.get('content-length') ?? 0) > MAX_AUDIO_BASE64) {
    throw new Error('MiMo 音频响应超出大小限制')
  }
  const raw = await response.text()
  if (raw.length > MAX_AUDIO_BASE64) throw new Error('MiMo 音频响应超出大小限制')
  let data: unknown
  try { data = JSON.parse(raw) } catch { throw new Error('MiMo 返回的数据不是合法 JSON') }
  const choices = (data as { choices?: Array<{ message?: { audio?: { data?: unknown } } }> })?.choices
  const base64 = choices?.[0]?.message?.audio?.data
  if (typeof base64 !== 'string' || !base64 || base64.length > MAX_AUDIO_BASE64 || !/^[A-Za-z0-9+/=\r\n]+$/u.test(base64)) {
    throw new Error('MiMo 没有返回有效的 WAV 音频')
  }
  if (cache.size >= 24) cache.delete(cache.keys().next().value as string)
  cache.set(cacheKey, base64)
  return { audioBase64: base64, mimeType: 'audio/wav' }
}
