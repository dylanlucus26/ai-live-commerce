import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Plus, UsersRound, X } from 'lucide-react'
import { useAccounts } from '@/hooks/useAccounts'
import { useCurrentLiveControl } from '@/hooks/useLiveControl'

type AccountMode = 'add' | 'rename' | null

/** High-contrast account controls, without the old shadcn light-theme Select. */
export default function LiveAccountControl() {
  const accounts = useAccounts(s => s.accounts)
  const accountId = useAccounts(s => s.currentAccountId)
  const switchAccount = useAccounts(s => s.switchAccount)
  const addAccount = useAccounts(s => s.addAccount)
  const updateAccountName = useAccounts(s => s.updateAccountName)
  const connection = useCurrentLiveControl(s => s.isConnected)
  const [mode, setMode] = useState<AccountMode>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const current = accounts.find(a => a.id === accountId)
  const open = (next: Exclude<AccountMode, null>) => {
    setMode(next)
    setName(next === 'rename' ? (current?.name ?? '') : '')
    setError('')
  }
  const save = () => {
    const trimmed = name.trim()
    if (!trimmed) { setError('请输入账号名称'); return }
    if (trimmed.length > 30) { setError('名称不能超过 30 个字符'); return }
    if (accounts.some(a => a.name === trimmed && (mode === 'add' || a.id !== accountId))) {
      setError('账号名称已经存在')
      return
    }
    if (mode === 'rename') updateAccountName(accountId, trimmed)
    if (mode === 'add') {
      addAccount(trimmed)
      const created = useAccounts.getState().accounts.find(a => a.name === trimmed)
      if (created) switchAccount(created.id)
    }
    setMode(null)
  }

  useEffect(() => {
    if (!mode) return
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMode(null)
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [mode])

  return (
    <>
      <div className="live-account-control">
        <UsersRound size={15} aria-hidden="true"/>
        <label className="live-account-select-wrap">
          <span>当前账号</span>
          <select aria-label="当前直播账号" value={accountId}
            disabled={connection !== 'disconnected'}
            title={connection !== 'disconnected' ? '请先断开直播中控台再切换账号' : '切换直播账号'}
            onChange={e => switchAccount(e.target.value)}>
            {accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <button aria-label="编辑当前账号名称" title="编辑账号名称" onClick={() => open('rename')}>
          <Pencil size={14}/>
        </button>
        <button className="live-account-add" aria-label="新增直播账号" title="新增账号"
          onClick={() => open('add')}><Plus size={17}/></button>
      </div>
      {mode && createPortal(
        <div className="live-account-dialog-backdrop" onMouseDown={e => {if(e.target === e.currentTarget)setMode(null)}}>
          <section className="live-account-dialog" role="dialog" aria-modal="true"
            aria-label={mode === 'add' ? '新增直播账号' : '编辑直播账号'}>
            <header>
              <div><UsersRound size={18}/><strong>{mode === 'add' ? '添加直播账号' : '编辑账号名称'}</strong></div>
              <button aria-label="关闭账号弹窗" onClick={() => setMode(null)}><X size={17}/></button>
            </header>
            <p>每个账号的商品、声音和互动配置独立保存，账号名称仅用于本地管理。</p>
            <label>账号名称
              <input value={name} autoFocus maxLength={30} placeholder="输入用于区分的直播账号名称"
                onChange={e => {setName(e.target.value);setError('')}}
                onKeyDown={e => {if(e.key === 'Enter')save()}}/>
            </label>
            {error && <div className="live-account-error" role="alert">{error}</div>}
            <footer><button onClick={() => setMode(null)}>取消</button>
              <button className="live-account-save" onClick={save}>保存并继续</button></footer>
          </section>
        </div>, document.body)}
    </>
  )
}
