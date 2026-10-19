import { useState } from 'react'
import { AudioLines, CircleHelp, ClipboardList, RefreshCw, Radio, ShieldCheck, Trash2 } from 'lucide-react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'
import { useAutoMessageActions, useCurrentAutoMessage } from '@/hooks/useAutoMessage'
import { useAutoPopUpActions, useCurrentAutoPopUp } from '@/hooks/useAutoPopUp'
import type { ShortcutMapping } from '@/hooks/useAutoPopUp'
import { useCurrentChromeConfig, useCurrentChromeConfigActions } from '@/hooks/useChromeConfig'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'
import { useUpdateConfigStore, useUpdateStore } from '@/hooks/useUpdate'
import { useDevMode } from '@/hooks/useDevMode'
import { performFullCleanup } from '@/utils/storage'
import { version } from '../../../package.json'

export type OperationTab = 'connection' | 'automation' | 'application'

export default function OperationsSettings({
  mode, report,
}: { mode: OperationTab; report: (message: string) => void }) {
  const accountId = useAccounts(s => s.currentAccountId)
  const account = useAccounts(s => s.accounts.find(a => a.id === s.currentAccountId))
  const removeAccount = useAccounts(s => s.removeAccount)
  const isConnected = useCurrentLiveControl(s => s.isConnected)
  const platform = useCurrentLiveControl(s => s.platform)
  const connectedName = useCurrentLiveControl(s => s.accountName)
  const chromePath = useCurrentChromeConfig(s => s.path)
  const savedLogin = useCurrentChromeConfig(s => s.storageState)
  const headless = useCurrentChromeConfig(s => s.headless)
  const chrome = useCurrentChromeConfigActions()
  const autoMessage = useCurrentAutoMessage(c => c.config)
  const messageRunning = useCurrentAutoMessage(c => c.isRunning)
  const msg = useAutoMessageActions()
  const popupConfig = useCurrentAutoPopUp(c => c.config)
  const popupRunning = useCurrentAutoPopUp(c => c.isRunning)
  const shortcuts = useCurrentAutoPopUp(c => c.shortcuts)
  const globalShortcuts = useCurrentAutoPopUp(c => c.isGlobalShortcut)
  const pop = useAutoPopUpActions()
  const autoUpdate = useUpdateConfigStore(s => s.enableAutoCheckUpdate)
  const setAutoUpdate = useUpdateConfigStore(s => s.setEnableAutoCheckUpdate)
  const updaterStatus = useUpdateStore.use.status()
  const updaterCheck = useUpdateStore.use.checkUpdateManually()
  const devMode = useDevMode(s => s.enabled)
  const setDevMode = useDevMode(s => s.setEnabled)
  const [edgeFirst, setEdgeFirst] = useState(false)
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showShortcutForm, setShowShortcutForm] = useState(false)
  const [shortcutKey, setShortcutKey] = useState('')
  const [shortcutGoods, setShortcutGoods] = useState('')
  const [ctrl, setCtrl] = useState(true)
  const [alt, setAlt] = useState(false)
  const [shift, setShift] = useState(false)

  const run = async (job: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try { await job() }
    catch (e) { report(e instanceof Error ? e.message : '操作失败') }
    finally { setBusy(false) }
  }
  const selectBrowser = () => void run(async () => {
    const selected = await window.ipcRenderer.invoke(IPC_CHANNELS.chrome.selectPath)
    if (selected) { chrome.setPath(selected); report('浏览器路径已更新') }
  })
  const detectBrowser = () => void run(async () => {
    const detected = await window.ipcRenderer.invoke(IPC_CHANNELS.chrome.getPath, edgeFirst)
    if (!detected) throw Error('未找到浏览器，请尝试手动选择路径')
    chrome.setPath(detected)
    report('已识别浏览器：' + detected)
  })
  const resetLogin = () => {
    if (!window.confirm('这将清空本账号保存的中控台浏览器登录状态，下次需重新登录。继续吗？')) return
    chrome.setStorageState('')
    report('已清除本账号的浏览器登录缓存，重新连接时需要登录')
  }
  const setIntervalRange = (kind: 'message'|'popup', part: 0|1, sec: number) => {
    const from = kind === 'message' ? autoMessage.scheduler.interval : popupConfig.scheduler.interval
    if (!Number.isFinite(sec) || sec < 3 || sec > 86400) {report('间隔请设置在 3～86400 秒之间');return}
    const interval: [number,number] = [...from] as [number,number]
    interval[part] = Math.round(sec * 1000)
    if (interval[0] > interval[1]) {report('最短发送间隔不能超过最长间隔');return}
    if (kind === 'message') msg.setScheduler({ interval })
    else pop.setScheduler({ interval })
  }
  const toggleTask = (kind: 'message'|'popup') => void run(async () => {
    const running = kind === 'message' ? messageRunning : popupRunning
    const channel = kind === 'message' ? IPC_CHANNELS.tasks.autoMessage : IPC_CHANNELS.tasks.autoPopUp
    if (running) {
      await window.ipcRenderer.invoke(channel.stop, accountId)
      if (kind === 'message') msg.setIsRunning(false)
      else pop.setIsRunning(false)
      report(kind === 'message' ? '已停止定时发言任务' : '已停止商品弹窗任务')
      return
    }
    if (!permission) throw Error('启动直播互动任务前，请先确认账号获得所需平台许可')
    if (isConnected !== 'connected') throw Error('请先在直播主控台左侧连接直播中控台')
    if (kind === 'message' && !autoMessage.messages.some(m => m.content.trim()))
      throw Error('请先填写至少一条定时发言内容')
    if (kind === 'popup' && !(popupConfig.goodsItems?.length || popupConfig.goodsIds.length))
      throw Error('请先填写至少一个商品橱窗编号')
    const ok = kind === 'message'
      ? await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.autoMessage.start, accountId, autoMessage)
      : await window.ipcRenderer.invoke(IPC_CHANNELS.tasks.autoPopUp.start, accountId, popupConfig)
    if (!ok) throw Error('中控台未能启动任务，请检查连接和平台权限')
    if (kind === 'message') msg.setIsRunning(true)
    else pop.setIsRunning(true)
    report('已启动' + (kind === 'message' ? '定时发言' : '商品弹窗') + '任务；请有人值守')
  })
  const addMessage = () => msg.setMessages([
    ...autoMessage.messages,
    { id: crypto.randomUUID(), content: '', pinTop: false },
  ])
  const updateMessage = (id: string, patch: {content?:string;pinTop?:boolean}) => {
    msg.setMessages(autoMessage.messages.map(m => m.id === id ? { ...m, ...patch } : m))
  }
  const addGoods = () => {
    const old = popupConfig.goodsItems ??
      popupConfig.goodsIds.map(id => ({ id, repeatCount: 1 }))
    const used = new Set(old.map(o => o.id))
    const id = Array.from({ length: 10000 }, (_,i) => i + 1).find(n => !used.has(n))
    if (id === undefined) {report('已达到商品配置数量上限');return}
    const items = [...old, { id, repeatCount: 1 }]
    pop.setGoodsItems(items)
    pop.setGoodsIds(items.map(o => o.id))
  }
  const updateGoods = (at: number, patch: {id?:number;repeatCount?:number}) => {
    const old = popupConfig.goodsItems ?? popupConfig.goodsIds.map(id => ({ id, repeatCount: 1 }))
    const items = old.map((item,i) => i === at ? { ...item, ...patch } : item)
    pop.setGoodsItems(items)
    pop.setGoodsIds(items.map(i => i.id))
  }
  const removeGoods = (at: number) => {
    const old = popupConfig.goodsItems ?? popupConfig.goodsIds.map(id => ({id,repeatCount:1}))
    const items = old.filter((_,i) => i !== at)
    pop.setGoodsItems(items)
    pop.setGoodsIds(items.map(i=>i.id))
  }
  const addShortcut = () => {
    const parsed = shortcutGoods.split(/[,，\s]+/u).map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0)
    if (!shortcutKey.trim() || !parsed.length) {report('填写按键和对应的商品编号');return}
    const next: ShortcutMapping = {
      id: crypto.randomUUID(), key: shortcutKey.trim(), ctrl, alt, shift,
      goodsIds: [...new Set(parsed)],
    }
    pop.setShortcuts([...(shortcuts ?? []), next])
    setShortcutKey('');setShortcutGoods('');setShowShortcutForm(false)
    report('商品快捷键已保存')
  }
  const checkUpdates = () => void run(async () => {
    const result = await updaterCheck()
    report(result?.upToDate ? '当前已是最新版本' : '已完成更新检查，请查看更新提示')
  })
  const deleteAccount = () => void run(async () => {
    if (isConnected !== 'disconnected') throw Error('请先断开当前直播中控台')
    if (accountId === 'default') throw Error('默认账号不能删除')
    if (!confirmDelete) {setConfirmDelete(true); report('再次点击“确认删除账号”将移除本机账号配置');return}
    removeAccount(accountId)
    setConfirmDelete(false)
    report('已删除本机账号配置，不影响抖店或百应账号')
  })

  if (mode === 'connection') return (
    <div className="live-settings-grid">
      <article className="live-settings-card wide">
        <header><h3>当前直播中控台</h3><Radio size={18}/></header>
        <div className="live-settings-statusline">
          <span className={'live-settings-connection-dot ' + (isConnected === 'connected' ? 'connected' : '')}/>
          <strong>{isConnected === 'connected' ? '已连接' : isConnected === 'connecting' ? '连接中' : '尚未连接'}</strong>
          <span>平台：{platform} · 账号：{connectedName || account?.name || '默认账号'}</span>
        </div>
        <p className="live-settings-note">连接、断开和开始直播助手统一在首页完成。这里集中处理浏览器路径与登录状态；不会额外弹出旧管理页面。</p>
      </article>
      <article className="live-settings-card wide">
        <header><h3>浏览器与登录状态</h3><CircleHelp size={18}/></header>
        <label>Chrome / Edge 浏览器程序路径
          <input value={chromePath} onChange={e => chrome.setPath(e.target.value)}
            placeholder="自动检测浏览器路径，或手动选择"/>
        </label>
        <div className="live-settings-actions">
          <button disabled={busy} onClick={detectBrowser}><RefreshCw size={14}/> 自动检测</button>
          <button disabled={busy} onClick={selectBrowser}>手动选择程序</button>
          <label className="live-settings-checkbox"><input type="checkbox" checked={edgeFirst}
            onChange={e => setEdgeFirst(e.target.checked)}/> 优先 Edge</label>
          <label className="live-settings-checkbox"><input type="checkbox" checked={headless}
            onChange={e => chrome.setHeadless(e.target.checked)}/> 无界面浏览器（谨慎使用）</label>
        </div>
        <div className="live-settings-splitline"><div>
          <strong>浏览器登录状态</strong>
          <p className="live-settings-note">{savedLogin ? '本账号保存过浏览器登录数据，可在下次连接中控台时复用。' : '本账号没有保存的登录状态，连接时可能需要扫码。'}</p>
        </div><button disabled={!savedLogin} onClick={resetLogin}>清除登录状态</button></div>
        <p className="live-settings-note">不在本软件内填写抖音密码。首次连接请在打开的正规中控台页面完成登录。</p>
      </article>
    </div>
  )

  if (mode === 'automation') return (
    <div className="live-settings-grid">
      <article className="live-settings-card wide">
        <header><h3>定时直播发言</h3>
          <button className={messageRunning ? 'danger-outline' : 'primary'} disabled={busy}
            onClick={() => toggleTask('message')}>{messageRunning ? '停止发言任务' : '启动发言任务'}</button></header>
        <p className="live-settings-note">文字定时发送属于平台受限能力，默认不启动。需要账号具有相应权限并有人值守；这不是自动向观众发送消息的官方授权。</p>
        <div className="live-settings-rule-header">
          <span>话术内容（按现有消息表保存）</span><button onClick={addMessage}>＋ 新增话术</button>
        </div>
        {autoMessage.messages.map(m => <div className="live-settings-rule" key={m.id}>
          <input aria-label="定时发言文案" value={m.content} placeholder="经商家确认的直播互动话术"
            onChange={e => updateMessage(m.id,{content:e.target.value})}/>
          <label className="live-settings-checkbox"><input type="checkbox" checked={m.pinTop}
            onChange={e => updateMessage(m.id,{pinTop:e.target.checked})}/> 置顶</label>
          <button className="danger-outline" onClick={() => msg.setMessages(autoMessage.messages.filter(x => x.id !== m.id))}>删除</button>
        </div>)}
        {!autoMessage.messages.length && <div className="live-settings-empty">目前没有定时发言内容</div>}
        <div className="live-settings-fields cols-2">
          <label>最短发言间隔（秒）
            <input type="number" min={3} max={86400} value={autoMessage.scheduler.interval[0]/1000}
              onChange={e => setIntervalRange('message',0,Number(e.target.value))}/></label>
          <label>最长发言间隔（秒）
            <input type="number" min={3} max={86400} value={autoMessage.scheduler.interval[1]/1000}
              onChange={e => setIntervalRange('message',1,Number(e.target.value))}/></label>
        </div>
        <div className="live-settings-switchrow">
          <label><input type="checkbox" checked={autoMessage.random}
            onChange={e => msg.setRandom(e.target.checked)}/> 随机话术</label>
          <label><input type="checkbox" checked={autoMessage.extraSpaces}
            onChange={e => msg.setExtraSpaces(e.target.checked)}/> 文本增加空格</label>
          <label><input type="checkbox" checked={autoMessage.unlimitedLength}
            onChange={e => msg.setUnlimitedLength(e.target.checked)}/> 不裁剪长文案</label>
        </div>
      </article>
      <article className="live-settings-card wide">
        <header><h3>商品橱窗弹窗</h3>
          <button className={popupRunning ? 'danger-outline' : 'primary'} disabled={busy}
            onClick={() => toggleTask('popup')}>{popupRunning ? '停止弹窗任务' : '启动弹窗任务'}</button></header>
        <p className="live-settings-note">商品编号指当前中控台支持的橱窗商品 ID，而不是商品 SKU。部分平台不支持自动弹窗或需要额外权限。</p>
        <div className="live-settings-rule-header">
          <span>当前商品弹窗顺序</span><button onClick={addGoods}>＋ 添加商品编号</button>
        </div>
        {(popupConfig.goodsItems ?? popupConfig.goodsIds.map(id=>({id,repeatCount:1}))).map((item,i) => (
          <div className="live-settings-rule" key={i}>
            <label>商品编号<input type="number" min={1} value={item.id}
              onChange={e=>updateGoods(i,{id:Number(e.target.value)})}/></label>
            <label>连续次数<input type="number" min={1} max={100} value={item.repeatCount ?? 1}
              onChange={e=>updateGoods(i,{repeatCount:Number(e.target.value)})}/></label>
            <button className="danger-outline" onClick={() => removeGoods(i)}>删除</button>
          </div>
        ))}
        {!(popupConfig.goodsItems?.length || popupConfig.goodsIds.length) && <div className="live-settings-empty">尚未配置商品橱窗编号</div>}
        <div className="live-settings-fields cols-2">
          <label>最短弹窗间隔（秒）<input type="number" min={3} max={86400}
            value={popupConfig.scheduler.interval[0]/1000}
            onChange={e=>setIntervalRange('popup',0,Number(e.target.value))}/></label>
          <label>最长弹窗间隔（秒）<input type="number" min={3} max={86400}
            value={popupConfig.scheduler.interval[1]/1000}
            onChange={e=>setIntervalRange('popup',1,Number(e.target.value))}/></label>
        </div>
        <label className="live-settings-checkbox"><input type="checkbox" checked={popupConfig.random}
          onChange={e=>pop.setRandom(e.target.checked)}/> 随机商品弹窗顺序</label>
      </article>
      <article className="live-settings-card wide">
        <header><h3>商品快捷键</h3><button onClick={() => setShowShortcutForm(!showShortcutForm)}>＋ 配置快捷键</button></header>
        <label className="live-settings-checkbox"><input type="checkbox" checked={!!globalShortcuts}
          onChange={e=>pop.setGlobalShortcut(e.target.checked)}/> 启用系统全局快捷键（仅任务运行时生效）</label>
        <p className="live-settings-note">可以把 Ctrl/Command、Alt、Shift 与按键组合映射到一组商品编号。请避免与系统快捷键冲突。</p>
        {(shortcuts ?? []).map(sc => <div className="live-settings-rule" key={sc.id}>
          <span>{[sc.ctrl?'Ctrl/⌘':'',sc.alt?'Alt':'',sc.shift?'Shift':'',sc.key].filter(Boolean).join(' + ')}</span>
          <span>商品 {sc.goodsIds.join(', ')}</span>
          <button className="danger-outline" onClick={()=>pop.removeShortcut(sc.id)}>删除</button>
        </div>)}
        {showShortcutForm && <div className="live-settings-rule">
          <input aria-label="按键名称" placeholder="按键，例如 F6" value={shortcutKey}
            onChange={e=>setShortcutKey(e.target.value)}/>
          <input aria-label="快捷键对应商品编号" placeholder="商品编号，例如 101,102" value={shortcutGoods}
            onChange={e=>setShortcutGoods(e.target.value)}/>
          <label className="live-settings-checkbox"><input type="checkbox" checked={ctrl} onChange={e=>setCtrl(e.target.checked)}/> Ctrl/⌘</label>
          <label className="live-settings-checkbox"><input type="checkbox" checked={alt} onChange={e=>setAlt(e.target.checked)}/> Alt</label>
          <label className="live-settings-checkbox"><input type="checkbox" checked={shift} onChange={e=>setShift(e.target.checked)}/> Shift</label>
          <button onClick={addShortcut}>保存快捷键</button>
        </div>}
      </article>
      <article className="live-settings-card wide">
        <header><h3>运行许可确认</h3><ShieldCheck size={17}/></header>
        <label className="live-settings-checkbox">
          <input type="checkbox" checked={permission} onChange={e=>setPermission(e.target.checked)}/>
          我确认该账号具备对应中控台自动发言/商品弹窗的适当许可，并会在运营时安排人工值守。
        </label>
        <p className="live-settings-note">此确认只在打开设置期间有效，不能代替官方授权。关闭软件不会自动重新启用。</p>
      </article>
    </div>
  )

  return (
    <div className="live-settings-grid">
      <article className="live-settings-card wide">
        <header><h3>软件信息与更新</h3><RefreshCw size={18}/></header>
        <div className="live-settings-splitline"><div><strong>当前版本：{version}</strong>
          <p className="live-settings-note">保留原项目的更新管理能力，检查更新将通过当前配置的更新源。</p></div>
          <button disabled={busy || updaterStatus === 'checking'} onClick={checkUpdates}>
            {updaterStatus === 'checking' ? '检查中…' : '检查更新'}</button></div>
        <label className="live-settings-checkbox"><input type="checkbox" checked={autoUpdate}
          onChange={e => setAutoUpdate(e.target.checked)}/> 有新版时弹出更新提示</label>
      </article>
      <article className="live-settings-card wide">
        <header><h3>日志与诊断</h3><ClipboardList size={18}/></header>
        <div className="live-settings-actions">
          <button onClick={() => void run(async()=>{
            await window.ipcRenderer.invoke(IPC_CHANNELS.app.openLogFolder)
          })}>打开程序日志文件夹</button>
          <button onClick={()=>{
            const count = performFullCleanup()
            report('已清理 ' + count + ' 条过期或无效的本地存储数据')
          }}>清理无效数据</button>
          <button onClick={() => void run(async()=>{
            await window.ipcRenderer.invoke(IPC_CHANNELS.app.openExternal,
              'https://github.com/dylanlucus26/ai-live-commerce/issues')
          })}>提交问题反馈</button>
        </div>
        <label className="live-settings-checkbox"><input type="checkbox" checked={devMode}
          onChange={e=>setDevMode(e.target.checked)}/> 开发者模式（启用右键调试菜单）</label>
      </article>
      <article className="live-settings-card wide">
        <header><h3>本机账号管理</h3><Trash2 size={18}/></header>
        <div className="live-settings-splitline">
          <div><strong>当前账号：{account?.name || accountId}</strong>
            <p className="live-settings-note">删除仅移除本机账号配置，不会注销抖音或抖店账户。</p></div>
          <button className="danger-outline" disabled={accountId === 'default' || isConnected !== 'disconnected'}
            onClick={deleteAccount}>{confirmDelete ? '确认删除账号' : '删除本机账号'}</button>
        </div>
      </article>
    </div>
  )
}
