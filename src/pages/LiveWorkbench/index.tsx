import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, ChevronDown, Cog, Headphones, MessageCircle,
  Mic2, Package, Pause, Play, Plug, RefreshCw, Send, ShieldCheck, Sparkles, Square, Volume2, WandSparkles } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { providers } from 'shared/providers'
import LiveAccountControl from './LiveAccountControl'
import AdvancedSettings from './AdvancedSettings'
import './liveAccount.css'
import { useAccounts } from '@/hooks/useAccounts'
import { useAIProvider } from '@/hooks/useAIProvider'
import { useAutoReply } from '@/hooks/useAutoReply'
import { useAutoReplyConfig } from '@/hooks/useAutoReplyConfig'
import { useCurrentChromeConfig } from '@/hooks/useChromeConfig'
import { useCurrentLiveControl, useCurrentLiveControlActions } from '@/hooks/useLiveControl'
import { useVoiceCommerceStore, defaultCommerceContext } from '@/hooks/useVoiceCommerce'
import { useCommerceMetrics, metricSummary } from '@/features/voiceCommerce/metrics'
import type { CommerceMetric } from '@/features/voiceCommerce/metrics'
import { makePitchPlaylist, splitSpeechText } from '@/features/voiceCommerce/voiceScript'
import { queueVoiceReply, startRuntimePitch, stopRuntimeAudio, useVoiceRuntime } from '@/features/voiceCommerce/runtime'
import { createProduct, productIntro, replySystemPrompt } from '@/features/voiceCommerce/model'
import './liveWorkbench.css'

// Stable fallback avoids React/Zustand useSyncExternalStore render loops for new accounts.
const EMPTY_METRICS: CommerceMetric[] = []
type StreamFilter = 'all' | 'comments' | 'replies'

const platformOptions: Array<{ value: LiveControlPlatform; label: string }> = [
  { value: 'buyin', label: '巨量百应' },
  { value: 'douyin', label: '抖店中控台' },
  { value: 'eos', label: '抖音团购' },
  { value: 'wxchannel', label: '视频号' },
  { value: 'kuaishou', label: '快手小店' },
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'pgy', label: '小红书蒲公英' },
  { value: 'taobao', label: '淘宝' },
]
const clock = (time: string | number) => {
  const date = new Date(typeof time === 'number' ? time : Date.parse(time))
  return Number.isNaN(date.getTime()) ? '--:--' : date.toLocaleTimeString('zh-CN', {hour12:false})
}
const typeLabel = (type: string) => ({
  room_enter: '入场', room_like: '点赞', room_follow: '关注',
  live_order: '订单', subscribe_merchant_brand_vip: '会员',
  ecom_fansclub_participate: '粉丝团',
} as Record<string,string>)[type] ?? '弹幕'

export default function LiveWorkbench() {
  const accountId = useAccounts(s => s.currentAccountId)
  const account = useAccounts(s => s.accounts.find(a => a.id === s.currentAccountId))
  const platform = useCurrentLiveControl(s => s.platform)
  const connection = useCurrentLiveControl(s => s.isConnected)
  const anchorAccount = useCurrentLiveControl(s => s.accountName)
  const { setIsConnected, setPlatform } = useCurrentLiveControlActions()
  const chromePath = useCurrentChromeConfig(s => s.path)
  const storageState = useCurrentChromeConfig(s => s.storageState)
  const headless = useCurrentChromeConfig(s => s.headless)
  const { comments, replies, isListening, isRunning, setIsListening, setIsRunning } = useAutoReply()
  const { config, updateAIReplySettings, updateKeywordReplyEnabled } = useAutoReplyConfig()
  const ai = useAIProvider('autoReply')
  const contexts = useVoiceCommerceStore(s => s.contexts)
  const productState = { ...defaultCommerceContext(), ...contexts[accountId] }
  const setProducts = useVoiceCommerceStore(s => s.setProducts)
  const selectProduct = useVoiceCommerceStore(s => s.selectProduct)
  const updateVoice = useVoiceCommerceStore(s => s.updateSettings)
  const product = productState.products.find(p => p.id === productState.selectedId) ?? productState.products[0]
  const pitching = useVoiceRuntime(s => s.pitching)
  const speaking = useVoiceRuntime(s => s.nowSpeaking)
  const runtimeError = useVoiceRuntime(s => s.error)
  const metricAccounts = useCommerceMetrics(s => s.accounts)
  const metrics = metricAccounts[accountId] ?? EMPTY_METRICS
  const stats = useMemo(() => metricSummary(metrics), [metrics])

  const [filter, setFilter] = useState<StreamFilter>('all')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [secretOpen, setSecretOpen] = useState(false)
  const [newModelKey, setNewModelKey] = useState('')
  const [newMimoKey, setNewMimoKey] = useState('')
  const [mimoConfigured, setMimoConfigured] = useState(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const [statusText, setStatusText] = useState('请先在抖音/直播伴侣开播，再连接直播中控台')
  const [draftQuestion, setDraftQuestion] = useState('')
  const [draftAnswer, setDraftAnswer] = useState('')
  const [answerBusy, setAnswerBusy] = useState(false)
  const [hasPermission, setHasPermission] = useState(false)
  const [audioMedia, setAudioMedia] = useState<Array<{ id: string; name: string; url: string }>>([])
  const [activeMedia, setActiveMedia] = useState('')
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setDraftAnswer('')
    setAudioMedia([])
    setActiveMedia('')
    void window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.hasKey)
      .then(setMimoConfigured).catch(() => setMimoConfigured(false))
    void window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.media.list, accountId)
      .then(assets => setAudioMedia(assets.filter(asset => asset.kind === 'audio')
        .map(asset => ({ id: asset.id, name: asset.name, url: asset.url }))))
      .catch(() => setAudioMedia([]))
  }, [accountId, advancedOpen])

  useEffect(() => { setHasPermission(false) }, [accountId])

  const stream = useMemo(() => [
    ...comments.map(message => ({
      id: 'comment-' + message.msg_id, time: message.time, kind: 'comment' as const,
      name: message.nick_name, text: message.msg_type === 'live_order'
        ? message.product_title
        : 'content' in message ? String(message.content ?? '') : typeLabel(message.msg_type),
      type: typeLabel(message.msg_type),
      commentId: message.msg_id,
    })),
    ...replies.map(reply => ({
      id: 'reply-' + reply.id, time: reply.time, kind: 'reply' as const,
      name: reply.replyFor, text: reply.replyContent, type: 'AI / 关键词',
      commentId: reply.commentId,
    })),
  ].filter(row => filter === 'all' || (filter === 'comments' ? row.kind === 'comment' : row.kind === 'reply'))
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 250),
  [comments, replies, filter])

  const changeProduct = (field: 'name'|'sku'|'price'|'stock'|'highlights'|'faq'|'script', value: string) => {
    if (!product) return
    setProducts(accountId, productState.products.map(p => p.id === product.id ? { ...p, [field]: value } : p))
  }
  const createNewProduct = () => {
    const p = createProduct()
    setProducts(accountId, [...productState.products, p])
    selectProduct(accountId, p.id)
    setStatusText('已创建商品，请输入真实名称、价格和卖点。')
  }

  const connect = async () => {
    if (!account || setupBusy) return
    if (connection === 'connected') {
      setStatusText('正在断开连接…')
      setSetupBusy(true)
      try {
        setIsRunning(false)
        updateVoice(accountId, { autoVoice: false })
        stopRuntimeAudio()
        if (isListening === 'listening') {
          await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.autoReply.stopCommentListener, accountId)
          setIsListening('stopped')
        }
        await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.liveControl.disconnect, accountId)
        setIsConnected('disconnected')
        setStatusText('已断开中控台连接')
      } catch (error) {
        setStatusText(error instanceof Error ? error.message : '断开连接失败')
      } finally { setSetupBusy(false) }
      return
    }
    setSetupBusy(true)
    setIsConnected('connecting')
    setStatusText('正在连接中控台，请在浏览器完成登录…')
    try {
      const ok = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.liveControl.connect, {
        account, platform, chromePath, storageState,
        headless: platform === 'taobao' ? false : headless,
      })
      if (!ok) throw new Error('无法连接中控台，请检查浏览器或登录状态')
      setIsConnected('connected')
      setStatusText('中控台已连接，点击“开始直播”启动评论监听与辅助回复')
    } catch (error) {
      setIsConnected('disconnected')
      setStatusText(error instanceof Error ? error.message : '连接失败')
    } finally { setSetupBusy(false) }
  }

  const startListening = async () => {
    if (connection !== 'connected') throw new Error('请先点击上方“连接中控台”')
    if (isListening !== 'listening') {
      setIsListening('waiting')
      try {
        const ready = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.autoReply.startCommentListener,
          accountId, { source: config.entry, ws: config.ws?.enable ? { port: config.ws.port } : undefined })
        if (!ready) throw new Error('中控台评论监听未就绪')
        setIsListening('listening')
      } catch (error) {
        setIsListening('error')
        throw error
      }
    }
  }

  const start = async () => {
    if (setupBusy || isRunning) return
    setSetupBusy(true)
    try {
      if (!ai.apiKeys[ai.config.provider]?.trim()) throw new Error('请先在右下角设置 LLM API Key')
      if (productState.voiceProvider === 'mimo' && !mimoConfigured)
        throw new Error('使用 MiMo 前请先设置 MiMo API Key，或切换成 Windows 语音')
      await startListening()
      updateAIReplySettings({ enable: true })
      updateVoice(accountId, { autoVoice: true })
      setIsRunning(true)
      if (product?.name.trim()) {
        const script = product.script?.trim()
        startRuntimePitch(script ? splitSpeechText(script) : makePitchPlaylist(product))
      }
      setStatusText('AI 直播助手已启动，正在监听互动与播报（不负责平台推流）')
    } catch (error) {
      setIsRunning(false)
      updateVoice(accountId, { autoVoice: false })
      stopRuntimeAudio()
      setStatusText(error instanceof Error ? error.message : '启动失败')
    } finally { setSetupBusy(false) }
  }
  const stop = async () => {
    if (setupBusy) return
    setSetupBusy(true)
    setIsRunning(false)
    updateVoice(accountId, { autoVoice: false })
    stopRuntimeAudio()
    try {
      if (isListening === 'listening' || isListening === 'waiting') {
        await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.autoReply.stopCommentListener, accountId)
        setIsListening('stopped')
      }
      setStatusText('直播辅助已停止，中控台连接保持不变')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : '停止监听失败，请手动断开中控台')
    } finally { setSetupBusy(false) }
  }

  const previewAI = async () => {
    if (!draftQuestion.trim() || answerBusy) return
    if (!ai.apiKeys[ai.config.provider]?.trim()) {
      setStatusText('先填写 LLM API Key，才能生成测试回复')
      setSecretOpen(true)
      return
    }
    setAnswerBusy(true)
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.aiChat.normalChat, {
        provider: ai.config.provider, model: ai.config.model,
        apiKey: ai.apiKeys[ai.config.provider], customBaseURL: ai.customBaseURL,
        messages: [
          { role: 'system', content: product ? replySystemPrompt(product) + '\n' + config.comment.aiReply.prompt : config.comment.aiReply.prompt },
          { role: 'user', content: draftQuestion.trim().slice(0, 300) },
        ],
      })
      if (!result) throw new Error('模型没有返回结果，请检查配置')
      setDraftAnswer(result)
      setStatusText('模拟问答已生成；不会发送到真实直播间')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : '生成测试回复失败')
    } finally { setAnswerBusy(false) }
  }

  const submitModelKey = () => {
    if (!newModelKey.trim()) return
    ai.setApiKey(ai.config.provider, newModelKey.trim())
    setNewModelKey('')
    setStatusText('LLM Key 已保存在现有模型配置中')
  }
  const submitMimoKey = async () => {
    if (!newMimoKey.trim()) return
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.saveKey, newMimoKey.trim())
      setMimoConfigured(true)
      setNewMimoKey('')
      setStatusText('MiMo Key 已在本机使用系统安全存储保存')
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : 'MiMo Key 保存失败')
    }
  }

  const sendManually = async (value: string) => {
    if (connection !== 'connected') { setStatusText('中控台未连接，无法发送文字'); return }
    try {
      const accepted = await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.autoReply.sendReply, accountId, value)
      setStatusText(accepted ? '发送请求已提交到中控台任务，不代表平台最终投递成功' : '中控台未接受发送请求')
    } catch (error) { setStatusText(error instanceof Error ? error.message : '文字发送失败') }
  }

  return (
    <section className="live-workbench" aria-label="直播主控台">
      <div className="live-desk-topbar">
        <div className="live-brand"><span className="live-brand-icon"><Mic2 size={17}/></span>
          <div><strong>AI 直播主控台</strong><small>互动 · 讲品 · 语音 · 商品</small></div></div>
        <div className="live-topbar-right">
          <span className={'live-top-pill ' + (connection === 'connected' ? 'connected' : '')}>
            <i/>{connection === 'connected' ? '中控台已连接' : connection === 'connecting' ? '连接中' : '未连接'}
          </span>
          <div className="live-account"><LiveAccountControl /></div>
          <button className="live-icon-button" title="高级设置" onClick={() => setAdvancedOpen(true)}><Cog size={17}/></button>
        </div>
      </div>

      <div className="live-desk-body">
        <aside className="live-left">
          <div className="live-panel-top"><div><b><MessageCircle size={15}/> 直播间互动</b><small>实时弹幕和回复集中查看</small></div>
            <span className="live-count">{comments.length} 条弹幕</span></div>
          <div className="live-connection-row">
            <select aria-label="直播平台" value={platform} disabled={connection !== 'disconnected'}
              onChange={e => setPlatform(e.target.value as LiveControlPlatform)}>
              {platformOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <span className="live-account-name" title={anchorAccount ?? account?.name ?? '当前账号'}>
              {anchorAccount ?? account?.name ?? '默认账号'}</span>
            <button className={'live-connect-button ' + (connection === 'connected' ? 'connected' : '')}
              onClick={() => void connect()} disabled={setupBusy || connection === 'connecting'}>
              {connection === 'connected' ? <Plug size={14}/> : <RefreshCw size={14}/>}
              {connection === 'connected' ? '断开' : '连接'}
            </button>
          </div>
          <div className="live-filter-row">
            {([['all','全部消息'],['comments','观众弹幕'],['replies','AI回复']] as const).map(([key,label]) => (
              <button key={key} className={filter === key ? 'selected' : ''} onClick={() => setFilter(key)}>{label}</button>
            ))}
            <span className="live-listening-state">{isListening === 'listening' ? '● 正在监听' : '○ 未监听'}</span>
          </div>
          <div className="live-message-stream" role="log" aria-label="直播互动消息">
            {stream.length === 0 && (
              <div className="live-empty-stream"><MessageCircle size={32} strokeWidth={1.5}/>
                <strong>等待直播间互动</strong><span>连接中控台并开始直播后，弹幕会自动出现在这里</span></div>
            )}
            {stream.map(item => (
              <div className={'live-feed-item ' + (item.kind === 'reply' ? 'reply' : '')} key={item.id}>
                <div className="live-feed-head">
                  <span className={'live-feed-label ' + (item.kind === 'reply' ? 'ai' : '')}>{item.type}</span>
                  <b>{item.name || '观众'}</b><time>{clock(item.time)}</time>
                </div>
                <p>{item.text || '互动事件'}</p>
                {item.kind === 'reply' && (
                  <div className="live-feed-actions">
                    <button onClick={() => queueVoiceReply(item.text)} title="语音播报"><Volume2 size={13}/> 播报</button>
                    <button onClick={() => void sendManually(item.text)} title="手动发文字"><Send size={13}/> 手动发文字</button>
                  </div>
                )}
              </div>
            ))}
            <div ref={logEnd}/>
          </div>
          <div className="live-left-footer">
            <span><i className={'live-mini-dot ' + (isRunning ? 'on' : '')}/> {isRunning ? '助手运行中' : '助手待命'}</span>
            <span>已生成 {replies.length} 条回复</span>
            <button onClick={() => setAdvancedOpen(true)}>详细数据 <ArrowDown size={12}/></button>
          </div>
        </aside>

        <main className="live-right">
          <section className="live-work-section live-script">
            <div className="live-section-title"><div><Package size={15}/> <strong>当前商品与直播文案</strong></div>
              <div className="live-section-actions">
                <select value={product?.id ?? ''} onChange={e => selectProduct(accountId, e.target.value)}>
                  {productState.products.length === 0 && <option value="">尚未添加商品</option>}
                  {productState.products.map(p => <option key={p.id} value={p.id}>{p.name || '未命名商品'}</option>)}
                </select>
                <button onClick={createNewProduct}><Package size={13}/> 新增商品</button>
              </div></div>
            {product ? (
              <>
                <div className="live-product-fields">
                  <label>商品名称<input value={product.name} placeholder="如：2026陕西苹果礼盒"
                    onChange={e => changeProduct('name', e.target.value)}/></label>
                  <label>售价<input value={product.price} placeholder="以详情页为准"
                    onChange={e => changeProduct('price', e.target.value)}/></label>
                  <label>库存<input value={product.stock} placeholder="未核实请留空"
                    onChange={e => changeProduct('stock', e.target.value)}/></label>
                </div>
                <textarea className="live-textarea live-copy" aria-label="商品讲解文案"
                  value={product.script ?? productIntro(product)}
                  onChange={e => changeProduct('script', e.target.value)}
                  placeholder="填写主播讲解文案、商品卖点和注意事项…" />
                <div className="live-inline-footer">
                  <span><Check size={13}/> 文案自动保存到当前账号</span>
                  <button onClick={() => changeProduct('script', productIntro(product))}><WandSparkles size={13}/> 按商品资料生成初稿</button>
                </div>
              </>
            ) : <div className="live-inline-empty">
              <Package size={23}/> <span>先新增商品，讲品文案将显示在这里</span>
              <button onClick={createNewProduct}>添加第一件商品</button></div>}
          </section>

          <section className="live-work-section live-persona">
            <div className="live-section-title"><div><ShieldCheck size={15}/> <strong>主播人设与 AI 回复规则</strong></div>
              <small>输入后自动保存 · 仅修改回复规则，不直接发送</small></div>
            <textarea className="live-textarea live-prompt" aria-label="主播回复规则"
              value={config.comment.aiReply.prompt}
              onChange={e => updateAIReplySettings({ prompt: e.target.value })}
              placeholder="例如：你是直播间的商品讲解员，只回答当前商品问题。不要承诺未核实的价格、库存或发货时间。" />
            <div className="live-inline-footer"><span>建议：简短、准确、不夸大商品效果</span>
              <button onClick={() => {updateAIReplySettings({prompt:'你是直播间的商品讲解助手。只回答已核实的商品问题，语言自然简短，每条不超过50字。不能虚构价格、库存、功效、优惠或物流承诺。缺信息时请用户查看商品详情或等待人工确认。'});setStatusText('已应用安全回复规则')}}>恢复推荐规则</button></div>
          </section>

          <section className="live-action-strip">
            <div className="live-action-buttons">
              <button className="live-start" title="启动 AI 直播助手。请先在抖音/直播伴侣开播，本按钮不会创建直播间或推流" disabled={setupBusy || isRunning} onClick={() => void start()}>
                <Play size={17} fill="currentColor"/> 开始直播</button>
              <button className="live-stop" disabled={setupBusy || (!isRunning && !pitching)} onClick={() => void stop()}>
                <Square size={15} fill="currentColor"/> 停止</button>
              <button className="live-emergency" onClick={() => { stopRuntimeAudio();setStatusText('已立即停止所有语音，评论监听状态未改变') }}>
                <Pause size={15}/> 紧急静音</button>
            </div>
            <div className="live-action-status"><span className={'live-operation-dot ' + (isRunning ? 'active' : '')}/>
              <strong>{isRunning ? '助手运行中' : '就绪'}</strong>
              <span>{speaking ? '播报：' + speaking.slice(0, 26) : pitching ? '正在讲解商品' : '等待启动'}</span></div>
            <div className="live-stream-disclaimer">先在抖音或直播伴侣开播；此处“开始直播”只启动 AI 互动与播报，不负责平台推流。</div>
          </section>

          <section className="live-work-section live-main-settings">
            <div className="live-section-title"><div><Cog size={15}/> <strong>常用设置</strong></div>
              <button onClick={() => setSecretOpen(v => !v)}>密钥与模型 <ChevronDown size={14}/></button></div>
            <div className="live-quick-settings-grid">
              <label>LLM 引擎
                <select value={ai.config.provider} onChange={e => ai.setConfig({ provider: e.target.value })}>
                  {Object.entries(providers).map(([key,value]) => <option key={key} value={key}>{value.name}</option>)}
                </select>
              </label>
              <label>模型
                <input aria-label="LLM 模型名称" value={ai.config.model} placeholder="deepseek-v4-flash"
                  onChange={e => ai.setConfig({ model: e.target.value })}/>
              </label>
              <label>TTS 引擎
                <select value={productState.voiceProvider}
                  onChange={e => { stopRuntimeAudio();updateVoice(accountId,{ voiceProvider:e.target.value as 'mimo'|'system' }) }}>
                  <option value="system">Windows 系统语音</option><option value="mimo">MiMo 云端语音</option>
                </select>
              </label>
              <label>主播音色
                <select value={productState.mimoVoice} disabled={productState.voiceProvider !== 'mimo'}
                  onChange={e => updateVoice(accountId, { mimoVoice: e.target.value })}>
                  {['冰糖','茉莉','苏打','白桦','mimo_default','Mia','Chloe','Milo','Dean'].map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            </div>
            {secretOpen && <div className="live-key-grid">
              <label>LLM API Key <span>{ai.apiKeys[ai.config.provider] ? '已配置' : '未配置'}</span>
                <div className="live-key-row"><input type="password" autoComplete="new-password" value={newModelKey}
                    placeholder={ai.apiKeys[ai.config.provider] ? '输入新 Key 以替换' : '输入 API Key'}
                    onChange={e => setNewModelKey(e.target.value)}/>
                  <button onClick={submitModelKey} disabled={!newModelKey.trim()}>保存</button></div>
              </label>
              <label>MiMo API Key <span>{mimoConfigured ? '已配置' : '未配置'}</span>
                <div className="live-key-row"><input type="password" autoComplete="new-password" value={newMimoKey}
                    placeholder={mimoConfigured ? '输入新 Key 以替换' : '输入 MiMo Key'}
                    onChange={e => setNewMimoKey(e.target.value)}/>
                  <button onClick={() => void submitMimoKey()} disabled={!newMimoKey.trim()}>保存</button></div>
              </label>
              <p>密钥不会展示明文。LLM 使用原项目本地配置；MiMo Key 在本机系统安全存储。不要把密钥贴进直播文案。</p>
            </div>}
            <div className="live-switches">
              <label><input type="checkbox" checked={config.comment.aiReply.enable}
                onChange={e => updateAIReplySettings({ enable:e.target.checked })}/> AI 自动生成回复</label>
              <label><input type="checkbox" checked={productState.autoVoice}
                onChange={e => updateVoice(accountId, {autoVoice:e.target.checked})}/> 自动语音播报</label>
              <label><input type="checkbox" checked={config.comment.keywordReply.enable}
                onChange={e => updateKeywordReplyEnabled(e.target.checked)}/> 关键词优先</label>
              <label><input type="checkbox" checked={config.comment.aiReply.autoSend}
                onChange={e => {
                  if (!e.target.checked) {updateAIReplySettings({autoSend:false});return}
                  if (!hasPermission) {setStatusText('先勾选“已确认平台授权”才能打开自动文字发送');return}
                  updateAIReplySettings({autoSend:true})
                }}/> 自动发文字</label>
            </div>
            <div className="live-authorization">
              <label><input type="checkbox" checked={hasPermission}
                onChange={e => {setHasPermission(e.target.checked);if(!e.target.checked)updateAIReplySettings({autoSend:false})}}/>
                我已确认直播账号具备此类自动文字发送的适当平台许可</label>
              <small>关闭为默认建议。中控台任务接受不等于平台投递成功。</small>
            </div>
          </section>

          <section className="live-work-section live-bottom-tools">
            <div className="live-bottom-field"><div className="live-mini-heading"><Headphones size={14}/> 主播录音</div>
              <div className="live-record-row">
                <select value={activeMedia} onChange={e => setActiveMedia(e.target.value)}>
                  <option value="">选择已入库录音</option>
                  {audioMedia.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <button onClick={() => {
                  const found = audioMedia.find(m => m.id === activeMedia)
                  if (found) {import('@/features/voiceCommerce/runtime').then(({runtimePlayer}) => runtimePlayer().enqueueRecording(found.url))}
                  else setAdvancedOpen(true)
                }}><Play size={14}/> 插播</button>
              </div>
              <button className="live-plain-link" onClick={() => setAdvancedOpen(true)}>导入/管理主播录音、排期和克隆声音</button>
            </div>
            <div className="live-bottom-field"><div className="live-mini-heading"><Sparkles size={14}/> 模拟弹幕问答 <small>不会发到直播间</small></div>
              <div className="live-record-row">
                <input value={draftQuestion} onChange={e => setDraftQuestion(e.target.value)}
                  onKeyDown={e => {if(e.key==='Enter')void previewAI()}}
                  placeholder="测试：这款商品有现货吗？" aria-label="模拟观众提问"/>
                <button disabled={answerBusy || !draftQuestion.trim()} onClick={() => void previewAI()}>
                  {answerBusy ? <RefreshCw size={14}/> : <Sparkles size={14}/>} AI 生成</button>
              </div>
              {draftAnswer && <div className="live-preview-answer">
                <span>{draftAnswer}</span><button onClick={() => queueVoiceReply(draftAnswer)} title="只播放语音"><Volume2 size={14}/></button>
              </div>}
            </div>
          </section>
          <div className="live-work-footer">
            <span><span className="live-mini-dot on"/> {runtimeError || statusText}</span>
            <button onClick={() => setAdvancedOpen(true)}><Cog size={14}/> OBS / 库存 / 素材 / 统计 / 高级配置</button>
          </div>
        </main>
      </div>
      <AdvancedSettings open={advancedOpen} onClose={() => setAdvancedOpen(false)} />
    </section>
  )
}
