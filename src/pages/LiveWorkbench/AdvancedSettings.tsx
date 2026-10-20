import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AudioLines, BookOpenText, Boxes, ChartNoAxesCombined, ChevronRight,
  CircleCheck, Database, MonitorPlay, Package,
  Radio, Settings2, ShieldCheck, ShoppingBag, Volume2, X,
} from 'lucide-react'
import { abilities, listeningSources } from '@/abilities'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import type { EventMessageType } from '@/hooks/useAutoReply'
import OperationsSettings from './OperationsSettings'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'
import { useAIProvider } from '@/hooks/useAIProvider'
import { useAutoReplyConfig } from '@/hooks/useAutoReplyConfig'
import { useVoiceCommerceStore, defaultCommerceContext } from '@/hooks/useVoiceCommerce'
import { useVoiceRuntime, runtimePlayer, stopRuntimeAudio } from '@/features/voiceCommerce/runtime'
import { parseProductCsv, serializeProductCsv } from '@/features/voiceCommerce/csv'
import { parseProductJson, createProduct } from '@/features/voiceCommerce/model'
import { applyInventorySnapshot } from '@/features/voiceCommerce/inventory'
import { useCommerceMetrics, metricSummary } from '@/features/voiceCommerce/metrics'
import type { CommerceProduct } from '@/features/voiceCommerce/model'
import type { ScheduledRecording } from '@/hooks/useVoiceCommerce'
import './advancedSettings.css'

type Tab = 'products' | 'interaction' | 'voice' | 'video' | 'inventory' | 'analytics' | 'connection' | 'automation' | 'application'
type Asset = { id: string; name: string; kind: 'audio' | 'video' | 'image'; size: number; url: string }
type OBSInfo = { scenes: string[]; currentScene: string; mediaInputs: string[] }
const SECTIONS: Array<{ id: Tab; name: string; description: string; Icon: typeof Package }> = [
  { id: 'products', name: '商品与讲品', description: '知识库、文案与导入', Icon: ShoppingBag },
  { id: 'interaction', name: 'AI 互动', description: '话术、关键词与模型', Icon: BookOpenText },
  { id: 'voice', name: '主播声音', description: '声音克隆、录音与排期', Icon: AudioLines },
  { id: 'video', name: '画面与 OBS', description: '视频素材和场景', Icon: MonitorPlay },
  { id: 'inventory', name: '库存同步', description: 'CSV 与授权 API 桥接', Icon: Database },
  { id: 'analytics', name: '运营数据', description: '日志、效果与导出', Icon: ChartNoAxesCombined },
  { id: 'connection', name: '直播连接', description: '浏览器与登录管理', Icon: Radio },
  { id: 'automation', name: '直播任务', description: '发言、弹窗与快捷键', Icon: Boxes },
  { id: 'application', name: '软件设置', description: '更新、日志与账号', Icon: Settings2 },
]
const safeFileName = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 40)

const WIDTH_KEY = 'ai-live-commerce:settings-window-width'
const NAV_KEY = 'ai-live-commerce:settings-navigation-width'
const DEFAULT_DIALOG_WIDTH = 1520
const MIN_DIALOG_WIDTH = 700
const MAX_NAV_WIDTH = 350
const MIN_NAV_WIDTH = 165
function savedWidth(key: string, fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  } catch { return fallback }
}
function fitDialogWidth(width: number): number {
  const max = Math.max(320, window.innerWidth - 24)
  return Math.min(Math.max(width, Math.min(MIN_DIALOG_WIDTH, max)), max)
}
function fitNavWidth(width: number): number {
  return Math.max(MIN_NAV_WIDTH, Math.min(MAX_NAV_WIDTH, width))
}
type DragTarget = { pointerId: number; x: number; width: number; target: 'window'|'navigation'; edge?: 'left'|'right'; value: number }


export default function AdvancedSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accountId = useAccounts(s => s.currentAccountId)
  const contexts = useVoiceCommerceStore(s => s.contexts)
  const ctx = { ...defaultCommerceContext(), ...contexts[accountId] }
  const setProducts = useVoiceCommerceStore(s => s.setProducts)
  const selectProduct = useVoiceCommerceStore(s => s.selectProduct)
  const updateVoice = useVoiceCommerceStore(s => s.updateSettings)
  const setSchedules = useVoiceCommerceStore(s => s.setSchedules)
  const setVideoQueue = useVoiceCommerceStore(s => s.setVideoQueue)
  const ai = useAIProvider('autoReply')
  const { config, updateAIReplySettings, updateKeywordRules, updateKeywordReplyEnabled,
    updateBlockList, updateGeneralSettings, updateWSConfig,
    updateEventReplyContents, updateEventReplyEnabled, updateEventReplyOptions } = useAutoReplyConfig()
  const platform = useCurrentLiveControl(x => x.platform)
  const allowedSources = abilities[platform]?.autoReply?.source ?? []
  const live = useVoiceRuntime()
  const eventsByAccount = useCommerceMetrics(s => s.accounts)
  const statsEvents = eventsByAccount[accountId] ?? []
  const stats = metricSummary(statsEvents)
  const clearStats = useCommerceMetrics(s => s.clear)
  const [tab, setTab] = useState<Tab>('products')
  const [notice, setNotice] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [voiceReference, setVoiceReference] = useState(false)
  const [consent, setConsent] = useState(false)
  const [stockFile, setStockFile] = useState<string | null>(null)
  const [obsPort, setObsPort] = useState(4455)
  const [obsPassword, setObsPassword] = useState('')
  const [obsScenes, setObsScenes] = useState<OBSInfo>({ scenes: [], currentScene: '', mediaInputs: [] })
  const [obsScene, setObsScene] = useState('')
  const [obsMedia, setObsMedia] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const [dialogWidth, setDialogWidth] = useState(() => savedWidth(WIDTH_KEY, DEFAULT_DIALOG_WIDTH))
  const [navigationWidth, setNavigationWidth] = useState(() => fitNavWidth(savedWidth(NAV_KEY, 235)))
  const [resizing, setResizing] = useState(false)
  const drag = useRef<DragTarget | null>(null)
  const [previewVideoId, setPreviewVideoId] = useState('')

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, target: 'window'|'navigation', edge?: 'left'|'right') => {
    if (event.button !== 0) return
    event.preventDefault()
    const original = target === 'window' ? fitDialogWidth(dialogWidth) : navigationWidth
    drag.current = { pointerId: event.pointerId, x: event.clientX, width: original, target, edge, value: original }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
  }
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || event.pointerId !== active.pointerId) return
    const delta = event.clientX - active.x
    const width = active.target === 'navigation'
      ? fitNavWidth(active.width + delta)
      : fitDialogWidth(active.width + delta * (active.edge === 'left' ? -2 : 2))
    active.value = width
    if (active.target === 'navigation') setNavigationWidth(width)
    else setDialogWidth(width)
  }
  const stopResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current
    if (!active || event.pointerId !== active.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    try {
      window.localStorage.setItem(active.target === 'window' ? WIDTH_KEY : NAV_KEY, String(active.value))
    } catch { /* the window remains resizable even if browser storage is unavailable */ }
    drag.current = null
    setResizing(false)
  }
  const resizeByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, target: 'window'|'navigation', edge?: 'left'|'right') => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 32 : -32
    const next = target === 'navigation'
      ? fitNavWidth(navigationWidth + delta)
      : fitDialogWidth(dialogWidth + delta * (edge === 'left' ? -2 : 2))
    if (target === 'navigation') setNavigationWidth(next)
    else setDialogWidth(next)
    try { window.localStorage.setItem(target === 'window' ? WIDTH_KEY : NAV_KEY, String(next)) } catch { /* no-op */ }
  }

  const product = ctx.products.find(p => p.id === ctx.selectedId) ?? ctx.products[0]
  const libraryVisuals = assets.filter(a => a.kind === 'video' || a.kind === 'image')
  const libraryAudio = assets.filter(a => a.kind === 'audio')

  const loadLocal = async () => {
    try {
      const [items, hasReference, source] = await Promise.all([
        window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.media.list, accountId),
        window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.clone.has, accountId),
        window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.name, accountId),
      ])
      setAssets(items)
      setVoiceReference(hasReference)
      setStockFile(source)
    } catch (e) { setNotice(e instanceof Error ? e.message : '无法读取本地设置，请检查主进程 IPC') }
  }

  useEffect(() => {
    if (!open) return
    setNotice('')
    setConsent(false)
    void loadLocal()
  }, [open, accountId])

  useEffect(() => {
    if (!open) return
    const onEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [open, onClose])

  const editProduct = (key: keyof CommerceProduct, value: string) => {
    if (!product) return
    setProducts(accountId, ctx.products.map(p => p.id === product.id ? { ...p, [key]: value } : p))
  }
  const addProduct = () => {
    const next = createProduct()
    setProducts(accountId, [...ctx.products, next])
    selectProduct(accountId, next.id)
  }
  const importProductFile = async (file?: File) => {
    if (!file) return
    try {
      if (file.size > 1024 * 1024) throw Error('商品文件最大 1MB')
      const loaded = file.name.toLowerCase().endsWith('.csv')
        ? parseProductCsv(await file.text()) : parseProductJson(await file.text())
      setProducts(accountId, loaded)
      selectProduct(accountId, loaded[0]?.id ?? '')
      setNotice('已导入 ' + loaded.length + ' 件商品，请核对价格及库存。')
    } catch (e) { setNotice(e instanceof Error ? e.message : '商品导入失败') }
  }
  const download = (name: string, content: string, mime: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 800)
  }
  const chooseMedia = async (kind: 'audio' | 'video' | 'image') => {
    try {
      const added = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.media.import, accountId, kind)
      if (added) { await loadLocal(); setNotice('已导入本地素材：' + added.name) }
    } catch (e) { setNotice(e instanceof Error ? e.message : '素材导入失败') }
  }
  const removeMedia = async (asset: Asset) => {
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.media.remove, accountId, asset.id)
      setSchedules(accountId, (ctx.schedules ?? []).filter(v => v.mediaId !== asset.id))
      setVideoQueue(accountId, (ctx.videoQueue ?? []).filter(v => v !== asset.id))
      await loadLocal()
      setNotice('已删除素材：' + asset.name)
    } catch (e) { setNotice(e instanceof Error ? e.message : '素材删除失败') }
  }
  const addSchedule = () => {
    const a = libraryAudio[0]
    if (!a) { setNotice('请先导入一段主播录音'); return }
    const newJob: ScheduledRecording = { id: crypto.randomUUID(), mediaId: a.id, at: '12:00', enabled: true }
    setSchedules(accountId, [...(ctx.schedules ?? []), newJob])
  }
  const updateSchedule = (id: string, patch: Partial<ScheduledRecording>) => {
    setSchedules(accountId, (ctx.schedules ?? []).map(s => s.id === id ? { ...s, ...patch } : s))
  }
  const chooseReference = async () => {
    if (!consent) { setNotice('请先确认已获得声音样本使用授权'); return }
    try {
      const ok = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.clone.select, accountId, true)
      if (ok) { setVoiceReference(true); setNotice('授权人声已加密保存至本机') }
    } catch (e) { setNotice(e instanceof Error ? e.message : '主播声音导入失败') }
  }
  const deleteReference = async () => {
    stopRuntimeAudio()
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.clone.remove, accountId)
      updateVoice(accountId, { useClonedVoice: false })
      setVoiceReference(false)
      setNotice('已删除本账号加密声音样本')
    } catch (e) { setNotice(e instanceof Error ? e.message : '删除声音样本失败') }
  }
  const fetchOBS = async () => {
    setActionBusy(true)
    try {
      const data = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.obs.scenes, { port: obsPort, password: obsPassword })
      setObsScenes(data)
      setObsScene(data.currentScene || data.scenes[0] || '')
      setObsMedia(data.mediaInputs[0] || '')
      setNotice('已连接本机 OBS，找到 ' + data.scenes.length + ' 个场景。')
    } catch (e) { setNotice(e instanceof Error ? e.message : 'OBS 连接失败') }
    finally { setActionBusy(false) }
  }
  const preflightOBS = async () => {
    setActionBusy(true)
    try {
      const result = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.stream.preflight,
        { port: obsPort, password: obsPassword })
      setNotice(result.ready
        ? 'OBS 流服务已就绪。v0.3.0 正在开发真实画面和声音输出；目前不会自动推流。'
        : result.reason ?? 'OBS 推流预检失败')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '无法检查 OBS 推流配置')
    } finally {
      setActionBusy(false)
    }
  }
  const switchOBS = async () => {
    if (!obsScene) return
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.obs.switchScene,
        { port: obsPort, password: obsPassword, sceneName: obsScene })
      setNotice('OBS 当前场景已切换到：' + obsScene)
    } catch (e) { setNotice(e instanceof Error ? e.message : '切换场景失败') }
  }
  const obsAction = async (action: 'play' | 'pause' | 'stop' | 'restart') => {
    if (!obsMedia) return
    try {
      await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.obs.mediaAction,
        { port: obsPort, password: obsPassword, inputName: obsMedia, action })
      setNotice('OBS 已处理媒体控制请求：' + action)
    } catch (e) { setNotice(e instanceof Error ? e.message : '媒体源操作失败') }
  }
  const refreshStock = async () => {
    setActionBusy(true)
    try {
      const rows = live.inventoryMode === 'bridge'
        ? (await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.bridge, live.bridgePort))
          .map(item => ({ id: item.sku, sku: item.sku, name: item.name ?? '',
            price: item.price ?? '', stock: item.stock ?? '', highlights: '', faq: '' }))
        : await (async () => {
          const source = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.read, accountId)
          return source.extension === '.csv'
            ? parseProductCsv(source.content) : parseProductJson(source.content)
        })()
      const snapshot = applyInventorySnapshot(ctx.products, rows)
      if (snapshot.changed) setProducts(accountId, snapshot.products)
      setNotice('更新 ' + snapshot.changed + ' 件商品，未匹配 ' + snapshot.unmatched + ' 件。')
    } catch (e) { setNotice(e instanceof Error ? e.message : '库存同步失败') }
    finally { setActionBusy(false) }
  }

  if (!open) return null
  return createPortal(
    <div className="live-settings-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section className={'live-settings-window ' + (resizing ? 'resizing' : '')} role="dialog" aria-modal="true" aria-label="直播设置中心" style={{ width: `min(${dialogWidth}px, calc(100vw - 24px))` }}>
        {(['left','right'] as const).map(edge => (
          <div key={edge} role="separator" aria-orientation="vertical" tabIndex={0}
            data-testid={'settings-resize-' + edge}
            aria-label={edge === 'left' ? '拖动左侧边缘调整设置窗口宽度' : '拖动右侧边缘调整设置窗口宽度'}
            className={'live-settings-window-resizer ' + edge}
            onPointerDown={event => beginResize(event, 'window', edge)}
            onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize}
            onKeyDown={event => resizeByKeyboard(event, 'window', edge)}>
            <span aria-hidden="true"/>
          </div>
        ))}
        <header className="live-settings-header">
          <div className="live-settings-header-mark"><Settings2 size={22}/></div>
          <div className="live-settings-heading">
            <strong>直播设置中心</strong><span>统一管理商品、主播、AI 和直播运营配置</span>
          </div>
          <div className="live-settings-save"><CircleCheck size={14}/> 配置自动保存</div>
          <button className="live-settings-close" aria-label="关闭设置" onClick={onClose}><X size={19}/></button>
        </header>
        <div className="live-settings-content" style={{'--settings-sidebar-width': navigationWidth + 'px'} as CSSProperties}>
          <nav className="live-settings-nav" aria-label="设置分类">
            <div className="live-settings-nav-label">直播管理</div>
            {SECTIONS.map(s => (
              <button key={s.id} onClick={() => { setTab(s.id); setNotice('') }}
                className={'live-settings-nav-item ' + (tab === s.id ? 'selected' : '')}
                aria-current={tab === s.id ? 'page' : undefined}>
                <span className="live-settings-nav-icon"><s.Icon size={17}/></span>
                <span className="live-settings-nav-copy"><strong>{s.name}</strong><small>{s.description}</small></span>
                {tab === s.id && <ChevronRight size={15}/>}
              </button>
            ))}
            <div className="live-settings-nav-bottom"><ShieldCheck size={15}/> 数据保存在本机及原有配置中</div>
          </nav>
          <div className="live-settings-nav-resizer" data-testid="settings-sidebar-resizer"
            role="separator" aria-label="拖动调整设置分类栏宽度" aria-orientation="vertical" tabIndex={0}
            onPointerDown={event => beginResize(event, 'navigation')}
            onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize}
            onKeyDown={event => resizeByKeyboard(event, 'navigation')}/>
          <div className="live-settings-main" key={tab}>
            <div className="live-settings-page-head">
              <span>设置中心 / {SECTIONS.find(s => s.id === tab)?.name}</span>
              <h2>{SECTIONS.find(s => s.id === tab)?.name}</h2>
              <p>{SECTIONS.find(s => s.id === tab)?.description} · 保留你已录入的数据和配置</p>
            </div>

            {tab === 'products' && <div className="live-settings-grid">
              <article className="live-settings-card wide">
                <header><h3>商品知识库</h3><span>{ctx.products.length} 件商品</span></header>
                <div className="live-settings-actions">
                  <select value={product?.id ?? ''} onChange={e => selectProduct(accountId, e.target.value)}>
                    {!ctx.products.length && <option value="">暂无商品</option>}
                    {ctx.products.map(p => <option value={p.id} key={p.id}>{p.name || '未命名商品'}</option>)}
                  </select>
                  <button className="primary" onClick={addProduct}>＋ 新增商品</button>
                  <label className="live-settings-import">导入 CSV/JSON
                    <input type="file" accept=".csv,.json" onChange={e => { void importProductFile(e.target.files?.[0]); e.target.value = '' }}/></label>
                  <button onClick={() => download('live-products-' + safeFileName(accountId) + '.csv',
                    serializeProductCsv(ctx.products), 'text/csv;charset=utf-8')} disabled={!ctx.products.length}>导出 CSV</button>
                </div>
                {product ? <>
                  <div className="live-settings-fields cols-2">
                    <label>商品名称<input value={product.name} onChange={e => editProduct('name', e.target.value)}/></label>
                    <label>商家 SKU<input value={product.sku ?? ''} onChange={e => editProduct('sku', e.target.value)} placeholder="用于匹配库存"/></label>
                    <label>售价<input value={product.price} onChange={e => editProduct('price', e.target.value)} placeholder="未核实请留空"/></label>
                    <label>库存说明<input value={product.stock} onChange={e => editProduct('stock', e.target.value)} placeholder="实际库存或详情页说明"/></label>
                  </div>
                  <label>已核实的商品卖点<textarea rows={3} value={product.highlights} onChange={e => editProduct('highlights', e.target.value)}/></label>
                  <label>常见问题与答案<textarea rows={3} value={product.faq} onChange={e => editProduct('faq', e.target.value)}/></label>
                  <label>直播商品讲解文案<textarea rows={4} value={product.script ?? ''} onChange={e => editProduct('script', e.target.value)}/></label>
                  <div className="live-settings-actions end"><button className="danger-outline" onClick={() => {
                    const remaining = ctx.products.filter(p => p.id !== product.id)
                    setProducts(accountId, remaining); selectProduct(accountId, remaining[0]?.id ?? '')
                  }}>删除当前商品</button></div>
                </> : <div className="live-settings-empty">点击「新增商品」开始维护知识库，数据会按账号保存。</div>}
              </article>
            </div>}

            {tab === 'interaction' && <div className="live-settings-grid">
              <article className="live-settings-card wide">
                <header><h3>AI 回复策略</h3><span>只有启用的规则会生效</span></header>
                <div className="live-settings-fields cols-2">
                  <label>模型服务商
                    <select value={ai.config.provider} onChange={e => ai.setConfig({ provider: e.target.value })}>
                      <option value="deepseek">DeepSeek</option><option value="custom">自定义</option>
                      <option value="siliconflow">硅基流动</option><option value="openrouter">OpenRouter</option>
                    </select>
                  </label>
                  <label>模型名称<input value={ai.config.model} onChange={e => ai.setConfig({ model: e.target.value })}/></label>
                </div>
                <label>AI 回复要求<textarea rows={4} value={config.comment.aiReply.prompt}
                  onChange={e => updateAIReplySettings({ prompt: e.target.value })}/></label>
                <div className="live-settings-switchrow">
                  <label><input type="checkbox" checked={config.comment.aiReply.enable}
                    onChange={e => updateAIReplySettings({ enable: e.target.checked })}/> 启用 AI 回复</label>
                  <label><input type="checkbox" checked={config.comment.keywordReply.enable}
                    onChange={e => updateKeywordReplyEnabled(e.target.checked)}/> 开启关键词优先</label>
                </div>
                <p className="live-settings-note">文字自动发送仍需在直播主控台中确认许可，不会从设置中心自动开启。</p>
              </article>
              <article className="live-settings-card wide">
                <header><h3>关键词快捷回复</h3><span>{config.comment.keywordReply.rules.length} 条规则</span></header>
                {config.comment.keywordReply.rules.map((rule, i) => (
                  <div className="live-settings-rule" key={i}>
                    <input aria-label={'关键词 ' + (i + 1)} placeholder="关键词，多个用逗号隔开" value={rule.keywords.join(',')}
                      onChange={e => updateKeywordRules(config.comment.keywordReply.rules.map((r,j) =>
                        i === j ? { ...r, keywords: e.target.value.split(/[,，]/).map(t => t.trim()).filter(Boolean) } : r))}/>
                    <input aria-label={'回复内容 ' + (i + 1)} placeholder="命中后回复的内容" value={rule.contents.join(' | ')}
                      onChange={e => updateKeywordRules(config.comment.keywordReply.rules.map((r,j) =>
                        i === j ? { ...r, contents: [e.target.value] } : r))}/>
                    <button className="danger-outline" aria-label={'删除关键词 ' + (i + 1)}
                      onClick={() => updateKeywordRules(config.comment.keywordReply.rules.filter((_,j) => i !== j))}>删除</button>
                  </div>
                ))}
                <button onClick={() => updateKeywordRules([...config.comment.keywordReply.rules,
                  { keywords: [], contents: [''] }])}>＋ 新增关键词规则</button>
                <label>屏蔽词（每行一条）<textarea rows={3} value={config.blockList.join('\n')}
                  onChange={e => updateBlockList(e.target.value.split('\n').map(t => t.trim()).filter(Boolean))}/></label>
              </article>

              <article className="live-settings-card wide">
                <header><h3>弹幕监听与互动事件</h3><span>替代旧版完整自动回复设置</span></header>
                <div className="live-settings-fields cols-2">
                  <label>评论监听来源
                    <select value={config.entry}
                      onChange={e => updateGeneralSettings({ entry: e.target.value as typeof config.entry })}>
                      {allowedSources.map(source => (
                        <option key={source} value={source}>{listeningSources[source]?.name || source}</option>
                      ))}
                    </select>
                  </label>
                  <label className="live-settings-checkbox"><input type="checkbox"
                    checked={config.hideUsername}
                    onChange={e => updateGeneralSettings({hideUsername:e.target.checked})}/>
                    在互动显示中隐藏观众昵称
                  </label>
                </div>
                <div className="live-settings-switchrow">
                  <label><input type="checkbox" checked={!!config.ws?.enable}
                    onChange={e=> updateWSConfig({enable:e.target.checked})}/>
                    启用本地弹幕 WebSocket 输出（供获授权的本机系统使用）</label>
                  <label>WebSocket 端口
                    <input type="number" min={2000} max={65535} disabled={!config.ws?.enable}
                      value={config.ws?.port ?? 12354}
                      onChange={e => {
                        const value = Number(e.target.value)
                        if(Number.isInteger(value) && value >= 2000 && value <= 65535)
                          updateWSConfig({ port: value })
                      }}/>
                  </label>
                </div>
                <p className="live-settings-note">监听来源和 WebSocket 生效依赖当前平台支持的能力；不通过修改监听模式绕过中控台的授权。</p>
              </article>
              <article className="live-settings-card wide">
                <header><h3>直播间互动事件话术</h3><span>观众入场、点赞、关注、订单及会员事件</span></header>
                {([
                  ['room_enter','观众入场'], ['room_like','点赞互动'],['room_follow','关注互动'],
                  ['live_order','订单互动'], ['subscribe_merchant_brand_vip','品牌会员'],
                  ['ecom_fansclub_participate','粉丝团互动'],
                ] as const satisfies ReadonlyArray<readonly [EventMessageType,string]>).map(([type,label]) => {
                  const item = config[type]
                  const first = item.messages[0]
                  const text = typeof first === 'string' ? first : first?.content ?? ''
                  return <div className="live-settings-event-rule" key={type}>
                    <label className="live-settings-checkbox"><input type="checkbox" checked={item.enable}
                      onChange={e => updateEventReplyEnabled(type,e.target.checked)}/>{label}</label>
                    <input disabled={!item.enable} placeholder="事件触发时使用的回复话术（需平台允许）"
                      aria-label={label + '回复文案'} value={text} onChange={e => {
                        const messages = [...item.messages]
                        if (messages.length) messages[0] = e.target.value
                        else messages.push(e.target.value)
                        updateEventReplyContents(type,messages)
                      }}/>
                    {type === 'live_order' && <label className="live-settings-checkbox">
                      <input type="checkbox" checked={config.live_order.options?.onlyReplyPaid ?? false}
                        onChange={e => updateEventReplyOptions('live_order',{onlyReplyPaid:e.target.checked})}/>仅已支付订单
                    </label>}
                  </div>
                })}
                <p className="live-settings-note">只编辑已授权互动场景的回复话术。所有事件任务默认关闭，需要人工开启并核实直播平台权限。</p>
              </article>
            </div>}

            {tab === 'voice' && <div className="live-settings-grid">
              <article className="live-settings-card">
                <header><h3>声音引擎</h3><Volume2 size={18}/></header>
                <label>语音合成服务<select value={ctx.voiceProvider}
                  onChange={e => {stopRuntimeAudio();updateVoice(accountId,{ voiceProvider: e.target.value as 'mimo'|'system' })}}>
                  <option value="system">Windows / 系统语音</option><option value="mimo">MiMo 云端语音</option></select></label>
                <label>MiMo 音色<select value={ctx.mimoVoice} onChange={e => updateVoice(accountId,{mimoVoice:e.target.value})}>
                  {['冰糖','茉莉','苏打','白桦','mimo_default','Mia','Chloe','Milo','Dean'].map(v => <option key={v} value={v}>{v}</option>)}
                </select></label>
                <label>MiMo 风格说明<textarea rows={3} value={ctx.mimoStyle}
                  onChange={e => updateVoice(accountId,{mimoStyle:e.target.value})}/></label>
              </article>
              <article className="live-settings-card">
                <header><h3>授权主播声音克隆</h3><ShieldCheck size={17}/></header>
                <p className="live-settings-note">仅使用本人或已获得明确授权的主播录音。授权样本会加密保存在此电脑。</p>
                <label className="live-settings-checkbox"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/> 我已取得该主播的声音克隆授权</label>
                <div className="live-settings-actions">
                  <button className="primary" disabled={!consent} onClick={() => void chooseReference()}>导入授权音频</button>
                  <button disabled={!voiceReference} onClick={() => void deleteReference()}>删除样本</button>
                </div>
                <label className="live-settings-checkbox"><input type="checkbox" disabled={!voiceReference || ctx.voiceProvider !== 'mimo'}
                  checked={ctx.useClonedVoice && voiceReference}
                  onChange={e => {stopRuntimeAudio();updateVoice(accountId,{useClonedVoice:e.target.checked})}}/>
                  使用已授权主播声音（{voiceReference ? '已导入' : '尚未导入'}）</label>
              </article>
              <article className="live-settings-card wide">
                <header><h3>主播录音素材与定时插播</h3><button onClick={() => void chooseMedia('audio')}>＋ 导入录音</button></header>
                <div className="live-settings-media-list">
                  {libraryAudio.map(a => <div key={a.id} className="live-settings-media-item">
                    <AudioLines size={16}/><span>{a.name}</span>
                    <button onClick={() => runtimePlayer().enqueueRecording(a.url)}>插播</button>
                    <button className="danger-outline" onClick={() => void removeMedia(a)}>删除</button>
                  </div>)}
                  {!libraryAudio.length && <p className="live-settings-note">还没有录音，点击右上角导入 MP3/WAV/M4A。</p>}
                </div>
                <div className="live-settings-switchrow">
                  <label><input type="checkbox" checked={live.armedSchedules}
                    onChange={e => live.setRuntime({armedSchedules:e.target.checked})}/> 启用录音排期（应用运行期间）</label>
                  <button onClick={addSchedule} disabled={!libraryAudio.length}>＋ 添加播放排期</button>
                </div>
                {(ctx.schedules ?? []).map(item => <div className="live-settings-rule" key={item.id}>
                  <input type="time" value={item.at} onChange={e => updateSchedule(item.id,{at:e.target.value})}/>
                  <select value={item.mediaId} onChange={e => updateSchedule(item.id,{mediaId:e.target.value})}>
                    {libraryAudio.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <label className="live-settings-checkbox"><input type="checkbox" checked={item.enabled} onChange={e => updateSchedule(item.id,{enabled:e.target.checked})}/>启用</label>
                  <button className="danger-outline" onClick={() => setSchedules(accountId,(ctx.schedules ?? []).filter(v => v.id !== item.id))}>删除</button>
                </div>)}
              </article>
            </div>}

            {tab === 'video' && <div className="live-settings-video-grid" data-testid="video-obs-workspace">
              <article className="live-settings-card">
                <header><h3>商品图片、视频与播放列表</h3>
                  <button onClick={() => void chooseMedia('image')}>＋ 导入图片</button>
                  <button className="primary" onClick={() => void chooseMedia('video')}>＋ 导入视频</button></header>
                <div className="live-settings-video-preview" data-testid="video-preview">
                  {libraryVisuals.length ? (
                    (libraryVisuals.find(v => v.id === previewVideoId) ??
                      libraryVisuals.find(v => v.id === ctx.videoQueue?.[0]) ?? libraryVisuals[0]).kind === 'image' ? (
                      <img key={previewVideoId || ctx.videoQueue?.[0] || libraryVisuals[0].id}
                        src={(libraryVisuals.find(v => v.id === previewVideoId) ??
                          libraryVisuals.find(v => v.id === ctx.videoQueue?.[0]) ?? libraryVisuals[0]).url}
                        alt="商品图片预览" style={{ width: '100%', height: '100%', objectFit: 'contain' }}/>
                    ) : (
                    <video key={previewVideoId || ctx.videoQueue?.[0] || libraryVisuals[0].id}
                      src={(libraryVisuals.find(v => v.id === previewVideoId) ??
                        libraryVisuals.find(v => v.id === ctx.videoQueue?.[0]) ?? libraryVisuals[0]).url}
                      controls preload="metadata"
                      aria-label="商品视频预览"
                      onEnded={() => {
                        if (!ctx.autoAdvanceVideo) return
                        const all = (ctx.videoQueue ?? []).filter(id => libraryVisuals.some(v => v.id === id))
                        const current = all.indexOf(previewVideoId || all[0])
                        const nextId = all[current + 1]
                        if (nextId) setPreviewVideoId(nextId)
                      }}/>
                    )
                  ) : (
                    <div className="live-settings-video-preview-empty">
                      <MonitorPlay size={34} strokeWidth={1.25}/>
                      <strong>还没有商品视频</strong>
                      <span>点击「导入图片」或「导入视频」加入本地素材库后，即可预览及排序</span>
                    </div>
                  )}
                </div>
                <div className="live-settings-video-toolbar">
                  <h4>已导入素材 <span>（{libraryVisuals.length}）</span></h4>
                  <span className="live-settings-video-help">本地预览，不会自动向抖音推流</span>
                </div>
                <div className="live-settings-media-list">
                  {libraryVisuals.map(v => <div key={v.id} className="live-settings-media-item">
                    <MonitorPlay size={16}/><span title={v.name}>{v.name}</span>
                    <button onClick={() => setPreviewVideoId(v.id)}>预览</button>
                    <button disabled={(ctx.videoQueue ?? []).includes(v.id)}
                      onClick={() => setVideoQueue(accountId, [...(ctx.videoQueue ?? []), v.id])}>
                      {(ctx.videoQueue ?? []).includes(v.id) ? '已加入' : '加入列表'}</button>
                    <button className="danger-outline" onClick={() => void removeMedia(v)}>删除</button>
                  </div>)}
                </div>
                <div className="live-settings-video-toolbar">
                  <h4>播放列表</h4>
                  <span className="live-settings-video-help">拖动窗口边缘可以显示更宽的控制区</span>
                </div>
                {(ctx.videoQueue ?? []).map((id,i) => {
                  const asset = libraryVisuals.find(v => v.id === id)
                  if (!asset) return null
                  return <div key={id} className="live-settings-media-item">
                    <span>{i+1}. {asset.name}</span>
                    <button onClick={() => {
                      const all = [...(ctx.videoQueue ?? [])], previous = all[i-1]
                      if (i > 0 && previous) {all[i-1] = id; all[i] = previous; setVideoQueue(accountId,all)}
                    }}>上移</button>
                    <button onClick={() => setPreviewVideoId(asset.id)}>播放</button>
                    <button onClick={() => setVideoQueue(accountId,
                      (ctx.videoQueue ?? []).filter(v => v !== id))}>移除</button>
                  </div>
                })}
                <label className="live-settings-checkbox">
                  <input type="checkbox" checked={ctx.autoAdvanceVideo}
                    onChange={e => updateVoice(accountId,{autoAdvanceVideo:e.target.checked})}/>
                  预览视频结束时自动播放列表下一条
                </label>
              </article>
              <article className="live-settings-card">
                <header><h3>OBS 本机联动</h3><Radio size={18}/></header>
                <p className="live-settings-note">连接本机 OBS WebSocket（默认端口 4455），
                  手动控制场景及媒体播放。不会自动开播或进行平台推流。</p>
                <div className="live-settings-statusline">
                  <span className={'live-settings-connection-dot ' + (obsScenes.scenes.length ? 'connected' : '')}/>
                  <strong>{obsScenes.scenes.length ? '已读取 OBS 场景' : '尚未连接 OBS'}</strong>
                  <span>连接地址：127.0.0.1:{obsPort}</span>
                </div>
                <div className="live-settings-fields cols-2">
                  <label>WebSocket 端口
                    <input type="number" min={1024} max={65535}
                      value={obsPort} onChange={e => setObsPort(Number(e.target.value))}/></label>
                  <label>WebSocket 密码
                    <input type="password" autoComplete="off" value={obsPassword}
                      onChange={e => setObsPassword(e.target.value)} placeholder="如未设密码可留空"/></label>
                </div>
                <button className="primary live-settings-obs-connect"
                  disabled={actionBusy} onClick={() => void fetchOBS()}>
                  {actionBusy ? '正在连接…' : '连接 / 刷新本机 OBS'}
                </button>
                <button disabled={actionBusy} onClick={() => void preflightOBS()}>
                  检查 OBS 推流配置（v0.3.0）
                </button>
                <label>直播场景
                  <select value={obsScene} onChange={e => setObsScene(e.target.value)}>
                    <option value="">请选择场景</option>
                    {obsScenes.scenes.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <button disabled={!obsScene || actionBusy} onClick={() => void switchOBS()}>切换到所选场景</button>
                <label>视频媒体源
                  <select value={obsMedia} onChange={e => setObsMedia(e.target.value)}>
                    <option value="">请选择媒体源</option>
                    {obsScenes.mediaInputs.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <div className="live-settings-obs-actions" aria-label="OBS 媒体控制">
                  {([['play','播放'],['pause','暂停'],['restart','从头播放'],['stop','停止']] as const)
                    .map(([action,label]) =>
                    <button disabled={!obsMedia || actionBusy} key={action}
                      onClick={() => void obsAction(action)}>{label}</button>)}
                </div>
                <p className="live-settings-video-help">只有在 OBS 已连接且选中媒体源后才能控制播放。
                  预录视频的直播使用方式须符合平台规则。</p>
              </article>
            </div>}

            {tab === 'inventory' && <div className="live-settings-grid">
              <article className="live-settings-card wide">
                <header><h3>库存数据同步</h3><Boxes size={17}/></header>
                <p className="live-settings-note">可使用商家导出的本地 CSV/JSON，或连接经过授权的本机 ERP 桥接接口。不会自行获取商家 Cookie。</p>
                <div className="live-settings-fields cols-2">
                  <label>数据来源<select value={live.inventoryMode} onChange={e => live.setRuntime({
                    inventoryMode:e.target.value as 'file'|'bridge', inventoryPolling:false
                  })}>
                    <option value="file">本地 CSV/JSON 文件</option><option value="bridge">本机授权 ERP 服务</option></select></label>
                  {live.inventoryMode === 'bridge'
                    ? <label>桥接服务端口<input type="number" value={live.bridgePort} onChange={e => live.setRuntime({bridgePort:Number(e.target.value)})}/></label>
                    : <label>已选择的文件<input disabled value={stockFile ?? '尚未选择'}/></label>}
                </div>
                <div className="live-settings-actions">
                  <button disabled={live.inventoryMode !== 'file'} onClick={async () => {
                    try {
                      const name = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.choose,accountId)
                      if (name) {setStockFile(name);setNotice('已选择库存文件：'+name)}
                    } catch(e) {setNotice(e instanceof Error ? e.message : '无法选择文件')}
                  }}>选择库存文件</button>
                  <button className="primary" disabled={actionBusy || (live.inventoryMode === 'file' && !stockFile)}
                    onClick={() => void refreshStock()}>立即同步</button>
                  <button disabled={!stockFile} onClick={async () => {
                    await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.clear,accountId)
                    setStockFile(null);live.setRuntime({inventoryPolling:false})
                  }}>移除数据源</button>
                </div>
                <div className="live-settings-switchrow">
                  <label><input type="checkbox" checked={live.inventoryPolling} disabled={live.inventoryMode==='file'&&!stockFile}
                    onChange={e=>live.setRuntime({inventoryPolling:e.target.checked,lastInventoryAt:0})}/> 启用后台库存刷新</label>
                  <select value={live.inventoryInterval} onChange={e=>live.setRuntime({inventoryInterval:Number(e.target.value)})}>
                    <option value="30">30 秒</option><option value="60">1 分钟</option><option value="300">5 分钟</option>
                  </select>
                </div>
              </article>
            </div>}

            {tab === 'analytics' && <div className="live-settings-grid">
              <article className="live-settings-card wide">
                <header><h3>最近 7 天的本机运营事件</h3><span>{statsEvents.length} 条</span></header>
                <div className="live-settings-stat-grid">
                  {([['接收互动',stats.received],['回复生成',stats.generated],['文字接受',stats.textAccepted],
                    ['文字失败',stats.textFailed],['语音完成',stats.voicePlayed],
                    ['语音失败',stats.voiceFailed],['语音入队',stats.voiceQueued],
                    ['AI平均时延',stats.avgReplyMs===null ? '暂无' : stats.avgReplyMs + 'ms']] as const).map(([name,v]) =>
                    <div key={name}><small>{name}</small><strong>{v}</strong></div>)}
                </div>
                <p className="live-settings-note">统计来自本机操作记录，不等于平台发送成功、GMV 或最终成交。</p>
                <div className="live-settings-actions">
                  <button onClick={() => download('commerce-analytics.csv',
                    ['time,type,source,durationMs',...statsEvents.map(e => [
                      new Date(e.at).toISOString(),e.type,e.source??'',e.durationMs??''].join(','))].join('\r\n'),
                    'text/csv;charset=utf-8')}>导出记录 CSV</button>
                  <button className="danger-outline" onClick={() => clearStats(accountId)}>清空本账号记录</button>
                </div>
              </article>
            </div>}

            {(tab === 'connection' || tab === 'automation' || tab === 'application') && (
              <OperationsSettings mode={tab} report={setNotice} />
            )}
          </div>
        </div>
        <footer className="live-settings-footer">
          <div><span className="live-settings-dot"/> 所有本地配置与当前账号关联。平台直播仍由抖音/直播伴侣负责开启。</div>
          <span role="status" aria-live="polite">{notice || '拖动左右边缘可调整设置窗口大小'}</span>
          <button className="primary" onClick={onClose}>完成设置</button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
