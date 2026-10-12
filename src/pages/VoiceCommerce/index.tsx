import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAccounts } from '@/hooks/useAccounts'
import { useAIProvider } from '@/hooks/useAIProvider'
import { useAutoReply } from '@/hooks/useAutoReply'
import { useAutoReplyConfig } from '@/hooks/useAutoReplyConfig'
import { defaultCommerceContext, useVoiceCommerceStore } from '@/hooks/useVoiceCommerce'
import { createProduct, parseProductJson, productIntro, replySystemPrompt } from '@/features/voiceCommerce/model'
import type { CommerceProduct } from '@/features/voiceCommerce/model'

type ProductField = 'name' | 'price' | 'stock' | 'highlights' | 'faq'

/** 系统语音播放使用 Windows 当前默认输出设备，不经第三方 TTS。 */
export default function VoiceCommerce() {
  const accountId = useAccounts(s => s.currentAccountId)
  const contexts = useVoiceCommerceStore(s => s.contexts)
  const context = contexts[accountId] ?? defaultCommerceContext()
  const setProducts = useVoiceCommerceStore(s => s.setProducts)
  const selectProduct = useVoiceCommerceStore(s => s.selectProduct)
  const updateSettings = useVoiceCommerceStore(s => s.updateSettings)
  const ai = useAIProvider('autoReply')
  const { updateAIReplySettings } = useAutoReplyConfig()
  const { replies, isListening } = useAutoReply()

  const product = context.products.find(p => p.id === context.selectedId) ?? context.products[0]
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('先添加一个商品，再使用测试弹幕验证 AI 文字与语音。')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [spokenCount, setSpokenCount] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const seenReplies = useRef<Set<string>>(new Set())
  const speechQueue = useRef<string[]>([])
  const speechBusy = useRef(false)
  const playbackGeneration = useRef(0)

  const playNext = useCallback(function playNext() {
    if (speechBusy.current || speechQueue.current.length === 0) return
    if (!('speechSynthesis' in window)) {
      setStatus('当前系统缺少语音合成引擎，请安装中文系统语音或切换 TTS 服务。')
      speechQueue.current = []
      return
    }
    const text = speechQueue.current.shift()
    if (!text) return
    const generation = playbackGeneration.current
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = context.voiceRate
    speechBusy.current = true
    utterance.onend = () => {
      if (playbackGeneration.current !== generation) return
      speechBusy.current = false
      setSpokenCount(count => count + 1)
      playNext()
    }
    utterance.onerror = () => {
      if (playbackGeneration.current !== generation) return
      speechBusy.current = false
      setStatus('系统语音播报失败，请检查 Windows 中文语音和默认声音输出设备。')
      playNext()
    }
    window.speechSynthesis.speak(utterance)
  }, [context.voiceRate])

  const enqueue = useCallback((text: string) => {
    const clean = text.trim()
    if (!clean) return
    // 有界队列：优先保持新提问的时效，不让弹幕排队无穷增长。
    if (speechQueue.current.length >= 10) speechQueue.current.shift()
    speechQueue.current.push(clean.slice(0, 280))
    playNext()
  }, [playNext])

  const stopVoice = useCallback(() => {
    playbackGeneration.current += 1
    speechQueue.current = []
    speechBusy.current = false
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    audioRef.current?.pause()
    setStatus('已停止语音播报。')
  }, [])

  // 页面打开时不播报历史 AI 回复；只处理当前账号后续新生成的内容。
  useEffect(() => {
    seenReplies.current = new Set(replies.map(r => r.id))
    speechQueue.current = []
    speechBusy.current = false
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [accountId])

  useEffect(() => {
    const unseen = replies.filter(r => !seenReplies.current.has(r.id)).reverse()
    for (const item of unseen) {
      seenReplies.current.add(item.id)
      if (context.autoVoice) enqueue(item.replyContent)
    }
  }, [replies, context.autoVoice, enqueue])

  useEffect(() => () => {
    playbackGeneration.current += 1
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }, [])

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl) }, [audioUrl])
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])

  const addProduct = () => {
    const next = createProduct()
    setProducts(accountId, [...context.products, next])
    selectProduct(accountId, next.id)
    setStatus('已新建商品，请填写真实售价、库存、卖点和 FAQ。')
  }
  const updateProduct = (key: ProductField, value: string) => {
    if (!product) return
    setProducts(accountId, context.products.map(p => p.id === product.id ? { ...p, [key]: value } : p))
  }
  const importProducts = async (file: File | undefined) => {
    if (!file) return
    try {
      if (file.size > 1024 * 1024) throw new Error('JSON 文件不能超过 1 MB')
      const imported = parseProductJson(await file.text())
      setProducts(accountId, imported)
      selectProduct(accountId, imported[0]?.id ?? '')
      setStatus(`已成功导入 ${imported.length} 件商品，价格库存请再核实。`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '商品导入失败')
    }
  }
  const exportProducts = () => {
    const blob = new Blob([JSON.stringify(context.products, null, 2)], { type: 'application/json' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = 'voice-commerce-products.json'
    link.click()
    URL.revokeObjectURL(href)
  }
  const selectMedia = (file: File | undefined, kind: 'audio' | 'video') => {
    if (!file) return
    if (kind === 'audio') {
      if (!file.type.startsWith('audio/')) { setStatus('请选择有效的音频文件'); return }
      setAudioUrl(URL.createObjectURL(file))
    } else {
      if (!file.type.startsWith('video/')) { setStatus('请选择有效的视频文件'); return }
      setVideoUrl(URL.createObjectURL(file))
    }
    setStatus('素材仅作本地预览，不会自动向抖音开播或推流。')
  }
  const generateAnswer = async () => {
    if (!product || !question.trim()) return
    const { provider, model } = ai.config
    const apiKey = ai.apiKeys[provider]
    if (!apiKey) { setStatus('请先在「自动回复」或「AI 助手」页面配置 AI API Key。'); return }
    setBusy(true)
    setStatus('正在使用当前商品资料生成回答……')
    try {
      const content = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.aiChat.normalChat, {
        messages: [
          { role: 'system', content: replySystemPrompt(product) },
          { role: 'user', content: `直播观众提问：${question.trim().slice(0, 400)}` },
        ],
        apiKey, provider, model, customBaseURL: ai.customBaseURL,
      })
      if (!content) throw new Error('模型没有返回内容，请检查 API 配置或网络。')
      setAnswer(content)
      setStatus('AI 已生成文字回复。核对内容后可以点击播报。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'AI 请求失败')
    } finally { setBusy(false) }
  }

  const syncPrompt = () => {
    if (!product) return
    updateAIReplySettings({ prompt: replySystemPrompt(product) })
    setStatus('已将当前商品知识同步到自动回复提示词；没有更改原有自动发送开关。')
  }

  return (
    <div className="container py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">AI 语音带货</h1>
        <p className="text-sm text-muted-foreground mt-1">无显卡 MVP · 复用现有 DeepSeek AI 回复 · Windows 中文语音 · 商品资料按账号保存</p>
      </div>
      <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 p-3 text-sm">
        直播互动必须有相应平台权限。当前页面不会自动向平台发送文字，也不会自动录播开播；
        如需文字发送，须在原有自动回复设置中单独启用并确认符合平台规则。
      </div>
      <Card>
        <CardHeader><CardTitle>商品知识库</CardTitle><CardDescription>商品信息是 AI 唯一允许引用的价格、库存与卖点来源。</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <Button onClick={addProduct}>新增商品</Button>
            <label className="cursor-pointer border rounded-md px-3 py-2 text-sm">
              导入 JSON
              <input type="file" accept=".json,application/json" className="hidden"
                onChange={e => { void importProducts(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            <Button variant="outline" onClick={exportProducts} disabled={!context.products.length}>导出 JSON</Button>
            <select className="rounded-md border p-2 text-sm min-w-48" value={product?.id ?? ''}
              onChange={e => selectProduct(accountId, e.target.value)}>
              {context.products.length === 0 && <option value="">暂无商品</option>}
              {context.products.map(p => <option key={p.id} value={p.id}>{p.name || '未命名商品'}</option>)}
            </select>
            <Button variant="destructive" disabled={!product}
              onClick={() => {
                if (!product) return
                const rest = context.products.filter(p => p.id !== product.id)
                setProducts(accountId, rest)
                selectProduct(accountId, rest[0]?.id ?? '')
              }}>删除当前商品</Button>
          </div>
          {product && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div><Label>商品名称</Label><Input value={product.name} onChange={e => updateProduct('name', e.target.value)} placeholder="真实商品名称" /></div>
              <div><Label>价格（以商品页为准）</Label><Input value={product.price} onChange={e => updateProduct('price', e.target.value)} placeholder="如：99元" /></div>
              <div><Label>库存说明</Label><Input value={product.stock} onChange={e => updateProduct('stock', e.target.value)} placeholder="未核实则留空" /></div>
              <div><Label>已核实卖点</Label><Textarea rows={3} value={product.highlights} onChange={e => updateProduct('highlights', e.target.value)} /></div>
              <div className="md:col-span-2"><Label>常见问题与答案（逐行输入）</Label><Textarea rows={3} value={product.faq} onChange={e => updateProduct('faq', e.target.value)} placeholder="问：尺码？答：请按尺码表选择" /></div>
              <div className="md:col-span-2 flex flex-wrap gap-2">
                <Button variant="outline" onClick={syncPrompt}>同步知识到原自动回复提示词</Button>
                <Button variant="outline" onClick={() => enqueue(productIntro(product))}>播报当前商品介绍</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>测试弹幕 → AI 文字回复</CardTitle><CardDescription>直接复用原项目的 AI API Key 和模型；这里不向抖音发送文字。</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <Textarea rows={3} placeholder="例如：这件衣服有 XL 码吗？" value={question} onChange={e => setQuestion(e.target.value)} />
            <Button onClick={() => void generateAnswer()} disabled={!product || !question.trim() || busy}>{busy ? '生成中…' : '生成文字回复'}</Button>
            <Textarea rows={4} placeholder="AI 回复将在这里出现，可人工修改后播报" value={answer} onChange={e => setAnswer(e.target.value)} />
            <Button variant="outline" disabled={!answer.trim()} onClick={() => enqueue(answer)}>播报这条回复</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>语音调度</CardTitle><CardDescription>实时监听原项目已生成的 AI 回复；仅在开启后播报新回复。</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="auto-voice">自动播报新产生的 AI 回复</Label>
              <Switch id="auto-voice" checked={context.autoVoice}
                onCheckedChange={value => updateSettings(accountId, { autoVoice: value })} />
            </div>
            <div className="text-sm text-muted-foreground">
              评论监听：{isListening === 'listening' ? '正在监听' : '未启动'}；已播报：{spokenCount} 条。
            </div>
            <div>
              <Label htmlFor="speech-rate">语速：{context.voiceRate.toFixed(1)} 倍</Label>
              <input id="speech-rate" className="w-full" type="range" min="0.7" max="1.4" step="0.1"
                value={context.voiceRate} onChange={e => updateSettings(accountId, { voiceRate: Number(e.target.value) })} />
            </div>
            <Button variant="destructive" onClick={stopVoice}>立即停止所有语音</Button>
            <p className="text-xs text-muted-foreground">当前使用系统语音，没有声音克隆和指定声卡功能。请在 Windows 中设置默认输出或虚拟音频设备，再接直播伴侣。</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>已有录音 / 视频素材</CardTitle><CardDescription>仅本地预览；关闭本页需要重新选择文件，暂未接入 OBS 推流。</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>公司真人主播录音（MP3 / WAV）</Label>
            <Input type="file" accept="audio/*" onChange={e => selectMedia(e.target.files?.[0], 'audio')} />
            {audioUrl && <audio ref={audioRef} controls src={audioUrl} className="w-full" />}
          </div>
          <div className="space-y-2">
            <Label>商品展示视频（MP4 等）</Label>
            <Input type="file" accept="video/*" onChange={e => selectMedia(e.target.files?.[0], 'video')} />
            {videoUrl && <video controls src={videoUrl} className="max-h-60 w-full rounded-lg bg-black" />}
          </div>
        </CardContent>
      </Card>
      <p role="status" aria-live="polite" className="rounded-lg border bg-muted px-4 py-3 text-sm">{status}</p>
    </div>
  )
}
