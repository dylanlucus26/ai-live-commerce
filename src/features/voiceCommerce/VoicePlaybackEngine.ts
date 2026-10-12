import { appendBounded, splitSpeechText } from './voiceScript'

export interface VoiceSettings {
  provider: 'system' | 'mimo'
  voiceRate: number
  mimoVoice: string
  mimoStyle: string
  outputDeviceId: string
  pitchGapMs: number
}
export type VoiceEvent =
  | { type: 'playing'; kind: 'pitch' | 'reply'; text: string }
  | { type: 'ended'; kind: 'pitch' | 'reply' }
  | { type: 'error'; detail: string }
  | { type: 'stopped' }

type MiMoResponse = { audioBase64: string; mimeType: 'audio/wav' }

/** 屏幕进程的播放器：弹幕优先、商品讲解次之，每次只允许一个播报声道。 */
export class VoicePlaybackEngine {
  private queuedReplies: string[] = []
  private pitchSegments: string[] = []
  private pitchCursor = 0
  private pitchActive = false
  private active: { id: number; kind: 'pitch' | 'reply'; stop: () => void } | null = null
  private sequence = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly settings: () => VoiceSettings,
    private readonly synthesize: (args: { text: string; voice: string; style: string }) => Promise<MiMoResponse>,
    private readonly notify: (event: VoiceEvent) => void,
  ) {}

  enqueueReply(value: string): void {
    if (this.disposed) return
    this.queuedReplies = appendBounded(this.queuedReplies, value)
    if (this.active?.kind === 'pitch') this.interrupt()
    this.clearDelay()
    this.pump()
  }

  startPitch(value: string[]): void {
    if (this.disposed) return
    const segments = value.flatMap(text => splitSpeechText(text))
    if (!segments.length) return
    this.pitchSegments = segments
    this.pitchCursor = 0
    this.pitchActive = true
    if (this.active?.kind === 'pitch') this.interrupt()
    this.clearDelay()
    this.pump()
  }

  stopPitch(): void {
    this.pitchActive = false
    this.pitchSegments = []
    if (this.active?.kind === 'pitch') this.interrupt()
    this.clearDelay()
    this.pump()
  }

  stopAll(): void {
    this.pitchActive = false
    this.pitchSegments = []
    this.queuedReplies = []
    this.clearDelay()
    this.interrupt()
    this.notify({ type: 'stopped' })
  }

  dispose(): void {
    this.stopAll()
    this.disposed = true
  }

  private interrupt() {
    if (!this.active) return
    const active = this.active
    this.active = null
    this.sequence++
    active.stop()
  }

  private clearDelay() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private pump() {
    if (this.disposed || this.active || this.timer !== null) return
    const kind = this.queuedReplies.length ? 'reply' : this.pitchActive ? 'pitch' : null
    if (!kind) return
    const text = kind === 'reply'
      ? this.queuedReplies.shift()
      : this.pitchSegments[this.pitchCursor % this.pitchSegments.length]
    if (!text) return
    const id = ++this.sequence
    this.active = { id, kind, stop: () => {} }
    this.notify({ type: 'playing', kind, text })
    void this.perform(id, kind, text)
  }

  private async perform(id: number, kind: 'pitch' | 'reply', text: string) {
    let succeeded = false
    try {
      const config = this.settings()
      if (config.provider === 'mimo') {
        const result = await this.synthesize({ text, voice: config.mimoVoice, style: config.mimoStyle })
        if (this.active?.id !== id) return
        await this.playAudio(id, result.audioBase64, config.outputDeviceId)
      } else {
        if (this.active?.id !== id) return
        await this.playSystem(id, text, config.voiceRate)
      }
      succeeded = true
    } catch (error) {
      if (this.active?.id !== id) return
      this.pitchActive = false // 防止密钥错误时不停循环请求 API
      this.queuedReplies = []
      this.notify({ type: 'error', detail: error instanceof Error ? error.message : '语音播放失败' })
    } finally {
      if (this.active?.id === id) {
        this.active = null
        if (succeeded) {
          if (kind === 'pitch' && this.pitchSegments.length) this.pitchCursor++
          this.notify({ type: 'ended', kind })
        }
        if (this.pitchActive && this.queuedReplies.length === 0 && this.settings().pitchGapMs > 0) {
          this.timer = setTimeout(() => {
            this.timer = null
            this.pump()
          }, this.settings().pitchGapMs)
        } else {
          this.pump()
        }
      }
    }
  }

  private playSystem(id: number, text: string, rate: number): Promise<void> {
    if (!window.speechSynthesis) throw new Error('Windows 当前缺少系统语音引擎')
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      utterance.rate = rate
      let done = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        utterance.onend = null
        utterance.onerror = null
        if (error) reject(error)
        else resolve()
      }
      const active = this.active
      if (!active || active.id !== id) return resolve()
      active.stop = () => { window.speechSynthesis.cancel(); finish() }
      utterance.onend = () => finish()
      utterance.onerror = () => finish(new Error('系统语音播放失败'))
      window.speechSynthesis.speak(utterance)
    })
  }

  private async playAudio(id: number, base64: string, deviceId: string): Promise<void> {
    // WAV 不执行脚本；只将音频交给浏览器播放，播放完立即释放 Object URL。
    const decoded = atob(base64)
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    const audio = new Audio(url)
    try {
      if (deviceId && deviceId !== 'default') {
        if (typeof audio.setSinkId !== 'function') throw new Error('当前 Chromium 不支持指定音频设备')
        await audio.setSinkId(deviceId)
      }
      if (this.active?.id !== id) return
      await new Promise<void>((resolve, reject) => {
        let done = false
        const finish = (error?: Error) => {
          if (done) return
          done = true
          audio.onended = null
          audio.onerror = null
          if (error) reject(error)
          else resolve()
        }
        const active = this.active
        if (!active || active.id !== id) return resolve()
        active.stop = () => { audio.pause(); audio.currentTime = 0; finish() }
        audio.onended = () => finish()
        audio.onerror = () => finish(new Error('MiMo 音频无法播放，请检查 Windows 音频设备'))
        void audio.play().catch(error => finish(error instanceof Error ? error : new Error('无法启动音频播放')))
      })
    } finally {
      audio.pause()
      URL.revokeObjectURL(url)
    }
  }
}
