import { useEffect, useRef } from 'react'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { useAccounts } from '@/hooks/useAccounts'
import { useVoiceCommerceStore } from '@/hooks/useVoiceCommerce'
import { useAutoReplyStore } from '@/hooks/useAutoReply'
import { useCommerceMetrics } from '@/features/voiceCommerce/metrics'
import { parseProductCsv } from '@/features/voiceCommerce/csv'
import { parseProductJson } from '@/features/voiceCommerce/model'
import { applyInventorySnapshot } from '@/features/voiceCommerce/inventory'
import { bindRuntimeAccount, queueVoiceReply, runtimePlayer,
  shutdownRuntime, useVoiceRuntime } from '@/features/voiceCommerce/runtime'

/** Runs for the lifetime of the Electron window, even when the operator navigates to another page.
 * Runtime switches are NOT persisted across app restarts; operator must arm again.
 */
export default function VoiceRuntimeHost() {
  const accountId = useAccounts(s => s.currentAccountId)
  const replyContexts = useAutoReplyStore(s => s.contexts)
  const initialized = useRef(false)
  const seen = useRef<Record<string, Set<string>>>({})
  const fired = useRef<Map<string,string>>(new Map())
  const inventoryInFlight = useRef(false)

  useEffect(() => {
    bindRuntimeAccount(accountId)
    const oldReplies = useAutoReplyStore.getState().contexts[accountId]?.replies ?? []
    if (!seen.current[accountId]) seen.current[accountId] = new Set(oldReplies.map(reply => reply.id))
    if (!initialized.current) {
      // Existing replies in the store must not be spoken on initial app startup.
      for (const [key, ctx] of Object.entries(useAutoReplyStore.getState().contexts))
        seen.current[key] = new Set(ctx.replies.map(reply => reply.id))
      initialized.current = true
    }
    return () => {}
  }, [accountId])
  useEffect(() => {
    return () => shutdownRuntime()
  }, [])

  useEffect(() => {
    const history = seen.current[accountId] ?? new Set<string>()
    seen.current[accountId] = history
    const replies = replyContexts[accountId]?.replies ?? []
    for (const reply of replies.slice().reverse()) {
      if (history.has(reply.id)) continue
      history.add(reply.id)
      const config = useVoiceCommerceStore.getState().contexts[accountId]
      if (config?.autoVoice) queueVoiceReply(reply.replyContent)
    }
    // Keep memory bounded.
    if (history.size > 1000) seen.current[accountId] = new Set(replies.map(r => r.id))
  }, [accountId, replyContexts])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (!alive) return
      const state = useVoiceRuntime.getState()
      const cfg = useVoiceCommerceStore.getState().contexts[accountId]
      if (state.armedSchedules && cfg) {
        const now = new Date()
        const today = now.toLocaleDateString('en-CA')
        const hhmm = [now.getHours(), now.getMinutes()].map(n => String(n).padStart(2,'0')).join(':')
        const jobs = (cfg.schedules ?? []).filter(j => j.enabled && j.at === hhmm)
        if (jobs.length) {
          try {
            const media = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.media.list, accountId)
            if (!alive || useAccounts.getState().currentAccountId !== accountId ||
                !useVoiceRuntime.getState().armedSchedules) return
            for (const job of jobs) {
              const key = accountId + ':' + job.id
              if (fired.current.get(key) === today) continue
              const asset = media.find(v => v.kind === 'audio' && v.id === job.mediaId)
              if (!asset) continue
              fired.current.set(key, today)
              runtimePlayer().enqueueRecording(asset.url)
              useCommerceMetrics.getState().record(accountId, 'schedule_fired')
            }
          } catch {
            state.setRuntime({ error: '录音排期检查失败，请检查本机素材库。', armedSchedules: false })
          }
        }
      }
      if (state.inventoryPolling && !inventoryInFlight.current &&
          Date.now() - state.lastInventoryAt >= state.inventoryInterval * 1000) {
        inventoryInFlight.current = true
        state.setRuntime({ lastInventoryAt: Date.now() })
        try {
          const changes = state.inventoryMode === 'bridge'
            ? (await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.bridge, state.bridgePort))
                .map(row => ({ id: row.sku, sku: row.sku, name: row.name ?? '',
                  price: row.price ?? '', stock: row.stock ?? '', highlights: '', faq: '' }))
            : await (async () => {
                const file = await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.inventory.read, accountId)
                return file.extension === '.csv' ? parseProductCsv(file.content) : parseProductJson(file.content)
              })()
          if (!alive || useAccounts.getState().currentAccountId !== accountId ||
              !useVoiceRuntime.getState().inventoryPolling) return
          const currentStore = useVoiceCommerceStore.getState()
          const current = currentStore.contexts[accountId]?.products ?? []
          const result = applyInventorySnapshot(current, changes)
          if (result.changed) currentStore.setProducts(accountId, result.products)
          useCommerceMetrics.getState().record(accountId, 'inventory_synced')
        } catch {
          state.setRuntime({ inventoryPolling: false, error: '后台库存刷新失败，已停止轮询。' })
        } finally { inventoryInFlight.current = false }
      }
    }
    void tick()
    const interval = setInterval(() => { void tick() }, 10_000)
    return () => { alive = false; clearInterval(interval) }
  }, [accountId])
  return null
}
