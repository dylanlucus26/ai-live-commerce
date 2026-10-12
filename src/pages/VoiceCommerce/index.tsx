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
import { createProduct, parseProductJson, replySystemPrompt } from '@/features/voiceCommerce/model'
import { parseProductCsv, serializeProductCsv } from '@/features/voiceCommerce/csv'
import { makePitchPlaylist } from '@/features/voiceCommerce/voiceScript'
import { VoicePlaybackEngine } from '@/features/voiceCommerce/VoicePlaybackEngine'
import type { CommerceProduct } from '@/features/voiceCommerce/model'

type ProductField = 'name' | 'price' | 'stock' | 'highlights' | 'faq'

/** 系统语音播放使用 Windows 当前默认输出设备，不经第三方 TTS。 */
export default function VoiceCommerce() {
  const accountId = useAccounts(s => s.currentAccountId)
  const contexts = useVoiceCommerceStore(s => s.contexts)
  const context = { ...defaultCommerceContext(), ...contexts[accountId] }
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
  const [isPitching, setIsPitching] = useState(false)
  const [nowSpeaking, setNowSpeaking] = useState('')
  const [mimoKey, setMimoKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [obsPort, setObsPort] = useState(4455)
  const [obsPassword, setObsPassword] = useState('')
  const [obsScenes, setObsScenes] = useState<string[]>([])
  const [obsMedia, setObsMedia] = useState<string[]>([])
  const [obsScene, setObsScene] = useState('')
  const [obsInput, setObsInput] = useState('')
  const [obsBusy, setObsBusy] = useState(false)
  const seenReplies = useRef<Set<string>>(new Set())
  const settingsRef = useRef(context)
  settingsRef.current = context
  const engineRef = useRef<VoicePlaybackEngine | null>(null)

  useEffect(() => {
    const engine = new VoicePlaybackEngine(
      () => ({
        provider: settingsRef.current.voiceProvider,
        voiceRate: settingsRef.current.voiceRate,
        mimoVoice: settingsRef.current.mimoVoice,
        mimoStyle: settingsRef.current.mimoStyle,
        outputDeviceId: settingsRef.current.outputDeviceId,
        pitchGapMs: settingsRef.current.pitchGapMs,
      }),
      args => window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.synthesize, args),
      event => {
        if (event.type === 'playing') setNowSpeaking(
          (event.kind === 'reply' ? '正在回答弹幕：' : '正在讲解商品：') + event.text,
        )
        if (event.type === 'ended') {
          setSpokenCount(count => count + 1)
          setNowSpeaking('')
        }
        if (event.type === 'error') {
          setNowSpeaking('')
          setIsPitching(false)
          setStatus(event.detail)
        }
        if (event.type === 'stopped') setNowSpeaking('')
      },
    )
    engineRef.current = engine
    return () => { engine.dispose(); engineRef.current = null }
  }, [])

  const enqueue = useCallback((text: string) => {
    // 防止人工试听素材与 AI 同时播报
    audioRef.current?.pause()
    engineRef.current?.enqueueReply(text)
  }, [])

  const stopVoice = useCallback(() => {
    engineRef.current?.stopAll()
    setIsPitching(false)
    setStatus('已停止所有语音及自动讲品。')
  }, [])

  useEffect(() => {
    seenReplies.current = new Set(replies.map(r => r.id))
    engineRef.current?.stopAll()
    setIsPitching(false)
  }, [accountId])

  // AI 回复预览来自原项目，启用后才自动语音播报，不修改平台文字发言状态。
  useEffect(() => {
    const unseen = replies.filter(r => !seenReplies.current.has(r.id)).reverse()
    for (const item of unseen) {
      seenReplies.current.add(item.id)
      if (context.autoVoice) enqueue(item.replyContent)
    }
  }, [replies, context.autoVoice, enqueue])

  useEffect(() => {
    void window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.hasKey)
      .then(setHasKey)
      .catch(() => setHasKey(false))
  }, [])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setStatus('当前环境不支持枚举音频设备，可使用系统默认输出。')
      return
    }
    try {
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audiooutput')
      setDevices(outputs)
    } catch {
      setStatus('无法列出音频设备，请使用 Windows 默认输出并检查直播伴侣采集设置。')
    }
  }, [])
  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl) }, [audioUrl])
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])

  const saveMimoKey = async () => {
    if (!mimoKey.trim()) return
    setKeyBusy(true)
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.saveKey, mimoKey.trim())
      setHasKey(true)
      setMimoKey('')
      setStatus('MiMo 密钥已使用 Windows 系统加密保存，仅在主进程向官方接口发起请求。')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '无法保存 MiMo 密钥')
    } finally { setKeyBusy(false) }
  }
  const clearMimoKey = async () => {
    setKeyBusy(true)
    try {
      stopVoice()
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.clearKey)
      setHasKey(false)
      setMimoKey('')
      setStatus('已清除本机 MiMo 密钥。')
    } catch (err) {
      setStatus(err instanceof Error ? err.message : '无法清除密钥')
    } finally { setKeyBusy(false) }
  }
  const startPitch = () => {
    if (!product || !product.name.trim()) { setStatus('请先填写商品名称和真实的卖点资料。'); return }
    if (context.voiceProvider === 'mimo' && !hasKey) {
      setStatus('请先保存 MiMo API Key，或选择系统语音模式。')
      return
    }
    const playlist = makePitchPlaylist(product)
    if (!playlist.length) return
    audioRef.current?.pause()
    engineRef.current?.startPitch(playlist)
    setIsPitching(true)
    setStatus('已开始人工启动的自动商品讲解；收到新 AI 回复会优先插播，然后继续讲品。')
  }
  const stopPitch = () => {
    engineRef.current?.stopPitch()
    setIsPitching(false)
    setStatus('已停止自动讲品，等待中的 AI 弹幕回复仍可继续播报。')
  }

  const obsConnection = () => ({ port: obsPort, password: obsPassword })
  const refreshObs = async () => {
    setObsBusy(true)
    try {
      const info = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.obs.scenes, obsConnection())
      setObsScenes(info.scenes)
      setObsMedia(info.mediaInputs)
      setObsScene(info.currentScene || info.scenes[0] || '')
      setObsInput(info.mediaInputs[0] || '')
      setStatus('已连接本机 OBS，读取到 ' + info.scenes.length + ' 个场景和 ' + info.mediaInputs.length + ' 个可控媒体源。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '连接本机 OBS 失败')
    } finally { setObsBusy(false) }
  }
  const switchObs = async () => {
    if (!obsScene) return
    setObsBusy(true)
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.obs.switchScene, {
        ...obsConnection(), sceneName: obsScene,
      })
      setStatus('已将本机 OBS 切换到「' + obsScene + '」场景。')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'OBS 场景切换失败')
    } finally { setObsBusy(false) }
  }
  const mediaAction = async (action: 'play' | 'pause' | 'restart' | 'stop') => {
    if (!obsInput) return
    setObsBusy(true)
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.obs.mediaAction, {
        ...obsConnection(), inputName: obsInput, action,
      })
      setStatus('本机 OBS 媒体源操作完成：' + action)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'OBS 媒体源控制失败')
    } finally { setObsBusy(false) }
  }

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
      if (file.size > 1024 * 1024) throw new Error('商品文件不能超过 1 MB')
      const content = await file.text()
      const imported = file.name.toLowerCase().endsWith('.csv')
        ? parseProductCsv(content)
        : parseProductJson(content)
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
              导入 JSON / CSV
              <input type="file" accept=".json,.csv,application/json,text/csv" className="hidden"
                onChange={e => { void importProducts(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            <Button variant="outline" onClick={exportProducts} disabled={!context.products.length}>导出 JSON</Button>
            <Button variant="outline" onClick={() => {
              const blob = new Blob([serializeProductCsv(context.products)], { type: 'text/csv;charset=utf-8' })
              const href = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = href
              link.download = 'ai-live-commerce-products.csv'
              link.click()
              URL.revokeObjectURL(href)
            }} disabled={!context.products.length}>导出 CSV</Button>
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
                <Button variant="outline" onClick={() => enqueue(makePitchPlaylist(product).join(' '))}>播报当前商品介绍</Button>
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
            <Button variant="destructive" onClick={stopVoice}>紧急停止全部声音</Button>
            <p className="text-xs text-muted-foreground">系统语音使用 Windows 默认设备；选择 MiMo 云端语音后，可尝试指定 Chromium 音频输出设备（需实机验证）。</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>云端 TTS 与自动讲品</CardTitle>
          <CardDescription>不需要显卡。默认使用免费的 Windows 系统语音；MiMo 语音需要自己的 API Key。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="tts-provider">语音合成方式</Label>
              <select id="tts-provider" className="w-full rounded-md border p-2 text-sm"
                value={context.voiceProvider}
                onChange={e => { stopVoice(); updateSettings(accountId, { voiceProvider: e.target.value as 'system' | 'mimo' }) }}>
                <option value="system">Windows 系统语音（无 API 费用）</option>
                <option value="mimo">小米 MiMo V2.5 TTS 云端</option>
              </select>
            </div>
            <div>
              <Label htmlFor="voice-id">MiMo 预置音色</Label>
              <select id="voice-id" className="w-full rounded-md border p-2 text-sm"
                value={context.mimoVoice} disabled={context.voiceProvider !== 'mimo'}
                onChange={e => updateSettings(accountId, { mimoVoice: e.target.value })}>
                {['冰糖','茉莉','苏打','白桦','mimo_default','Mia','Chloe','Milo','Dean'].map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="mimo-key">MiMo API Key（只在本机加密保存，不提交 GitHub）</Label>
              <div className="flex gap-2">
                <Input id="mimo-key" type="password" autoComplete="off" value={mimoKey}
                  placeholder={hasKey ? '已保存密钥，可输入新密钥替换' : '输入自己的 MiMo API Key'}
                  onChange={e => setMimoKey(e.target.value)} />
                <Button onClick={() => void saveMimoKey()} disabled={!mimoKey.trim() || keyBusy}>保存</Button>
                <Button variant="outline" onClick={() => void clearMimoKey()} disabled={!hasKey || keyBusy}>清除</Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">密钥状态：{hasKey ? '已配置' : '未配置'}。只支持官方预置音色，声音克隆后续单独增加。</p>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="voice-style">播报语气提示词（仅 MiMo 生效）</Label>
              <Textarea id="voice-style" rows={2} maxLength={200} value={context.mimoStyle}
                onChange={e => updateSettings(accountId, { mimoStyle: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="audio-output">云端音频输出设备</Label>
              <select id="audio-output" className="w-full rounded-md border p-2 text-sm"
                disabled={context.voiceProvider !== 'mimo'} value={context.outputDeviceId}
                onChange={e => updateSettings(accountId, { outputDeviceId: e.target.value })}>
                <option value="default">Windows 默认音频设备</option>
                {devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>{device.label || '输出设备 ' + (index + 1)}</option>
                ))}
              </select>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => void refreshDevices()}>刷新设备列表</Button>
            </div>
            <div>
              <Label htmlFor="pitch-gap">讲品段落间隔：{context.pitchGapMs / 1000} 秒</Label>
              <input id="pitch-gap" type="range" min={1000} max={5000} step={500} className="w-full"
                value={context.pitchGapMs}
                onChange={e => updateSettings(accountId, { pitchGapMs: Number(e.target.value) })} />
              <p className="text-xs text-muted-foreground">弹幕优先，商品讲品会自动让路；直播期间请有人值守。</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={startPitch} disabled={!product || isPitching}>开始自动讲解当前商品</Button>
            <Button variant="outline" disabled={!isPitching} onClick={stopPitch}>停止讲品</Button>
            <Button variant="destructive" onClick={stopVoice}>一键停止全部语音</Button>
          </div>
          <div className="text-xs text-muted-foreground rounded-md border bg-muted p-3">
            {nowSpeaking || (isPitching ? '讲品模式已启用，等待下一段音频……' : '当前没有正在播报的声音。')}
          </div>
          <p className="text-xs text-muted-foreground">
            MiMo 通过官方 Chat Completions 音频接口生成 WAV。首版采用按段合成并顺序播放，
            并非流式低延迟；自动讲品会消耗 API 额度。此功能不是允许无人录播的凭证。
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>OBS 本机场景与媒体控制</CardTitle>
          <CardDescription>用于已获准的真人直播辅助或商品展示。需在 OBS「工具 → WebSocket 服务器设置」中自行启用服务；不自动开播。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><Label htmlFor="obs-port">OBS WebSocket 端口（仅允许本机 127.0.0.1）</Label>
              <Input id="obs-port" type="number" min="1024" max="65535" value={obsPort}
                onChange={e => setObsPort(Number(e.target.value))} />
            </div>
            <div><Label htmlFor="obs-password">OBS WebSocket 密码（本次会话使用，不保存）</Label>
              <Input id="obs-password" type="password" autoComplete="off" value={obsPassword}
                onChange={e => setObsPassword(e.target.value)} />
            </div>
          </div>
          <Button variant="outline" disabled={obsBusy} onClick={() => void refreshObs()}>{obsBusy ? '正在操作…' : '连接 / 刷新 OBS 场景'}</Button>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="obs-scene">OBS 场景</Label>
              <select id="obs-scene" className="w-full rounded-md border p-2 text-sm" value={obsScene}
                onChange={e => setObsScene(e.target.value)}>
                <option value="">请选择场景</option>
                {obsScenes.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              <Button disabled={obsBusy || !obsScene} onClick={() => void switchObs()}>手动切换到场景</Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="obs-media">OBS 媒体源（视频文件由 OBS 自行配置）</Label>
              <select id="obs-media" className="w-full rounded-md border p-2 text-sm" value={obsInput}
                onChange={e => setObsInput(e.target.value)}>
                <option value="">请选择媒体源</option>
                {obsMedia.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={obsBusy || !obsInput} onClick={() => void mediaAction('play')}>播放</Button>
                <Button size="sm" variant="outline" disabled={obsBusy || !obsInput} onClick={() => void mediaAction('pause')}>暂停</Button>
                <Button size="sm" variant="outline" disabled={obsBusy || !obsInput} onClick={() => void mediaAction('restart')}>从头播放</Button>
                <Button size="sm" variant="outline" disabled={obsBusy || !obsInput} onClick={() => void mediaAction('stop')}>停止</Button>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            控制范围仅限手动切换场景和媒体源播放，不会调用开播、推流、录像循环或自动挂机功能。
            请提前核实抖音对预录视频展示的适用规则。
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>已有录音 / 视频素材</CardTitle><CardDescription>仅本地预览；关闭本页需要重新选择文件，暂未接入 OBS 推流。</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>公司真人主播录音（MP3 / WAV）</Label>
            <Input type="file" accept="audio/*" onChange={e => selectMedia(e.target.files?.[0], 'audio')} />
            {audioUrl && <audio ref={audioRef} controls src={audioUrl} className="w-full" onPlay={() => stopVoice()} />}
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
