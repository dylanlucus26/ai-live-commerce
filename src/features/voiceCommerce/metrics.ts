import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { EVENTS, eventEmitter } from '@/utils/events'

export type CommerceMetricType =
  | 'comment_received' | 'reply_generated' | 'text_attempted' | 'text_accepted'
  | 'text_failed' | 'voice_queued' | 'voice_played' | 'voice_failed'
  | 'inventory_synced' | 'schedule_fired' | 'video_action'
export interface CommerceMetric {
  id: string
  type: CommerceMetricType
  at: number
  durationMs?: number
  source?: 'ai' | 'keyword' | 'manual' | 'system'
}
interface MetricsState {
  accounts: Record<string, CommerceMetric[]>
  record: (accountId: string, type: CommerceMetricType, details?: Pick<CommerceMetric, 'durationMs' | 'source'>) => void
  clear: (accountId: string) => void
}
const MAX_EVENTS = 500
const MAX_AGE_MS = 7 * 24 * 3600_000
const accountValid = (id: string) => /^[a-zA-Z0-9_-]{1,120}$/.test(id)
export const useCommerceMetrics = create<MetricsState>()(
  persist(set => {
    eventEmitter.on(EVENTS.ACCOUNT_REMOVED, (id: string) => set(s => {
      const accounts = { ...s.accounts }
      delete accounts[id]
      return { accounts }
    }))
    return {
      accounts: {},
      record: (accountId, type, details) => {
        if (!accountValid(accountId)) return
        const now = Date.now()
        set(state => ({
          accounts: {
            ...state.accounts,
            [accountId]: [
              ...(state.accounts[accountId] ?? []).filter(e => e.at >= now - MAX_AGE_MS),
              { id: crypto.randomUUID(), type, at: now,
                source: details?.source,
                durationMs: typeof details?.durationMs === 'number' && Number.isFinite(details.durationMs)
                  ? Math.max(0, Math.min(300_000, Math.round(details.durationMs))) : undefined,
              },
            ].slice(-MAX_EVENTS),
          },
        }))
      },
      clear: accountId => set(s => {
        const accounts = { ...s.accounts }
        delete accounts[accountId]
        return { accounts }
      }),
    }
  }, { name: 'commerce-metrics-v1', version: 1 }),
)

export function metricSummary(events: CommerceMetric[]) {
  const count = (type: CommerceMetricType) => events.filter(e => e.type === type).length
  const latency = events.filter(e => e.type === 'reply_generated' && e.durationMs !== undefined)
  return {
    received: count('comment_received'),
    generated: count('reply_generated'),
    textAttempted: count('text_attempted'),
    textAccepted: count('text_accepted'),
    textFailed: count('text_failed'),
    voiceQueued: count('voice_queued'),
    voicePlayed: count('voice_played'),
    voiceFailed: count('voice_failed'),
    avgReplyMs: latency.length
      ? Math.round(latency.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / latency.length)
      : null,
  }
}
