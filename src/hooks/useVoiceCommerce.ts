import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CommerceProduct } from '@/features/voiceCommerce/model'
import { EVENTS, eventEmitter } from '@/utils/events'

export interface ScheduledRecording {
  id: string
  mediaId: string
  at: string // local HH:mm
  enabled: boolean
}
interface CommerceContext {
  products: CommerceProduct[]
  selectedId: string
  autoVoice: boolean
  voiceRate: number
  voiceProvider: 'system' | 'mimo'
  mimoVoice: string
  mimoStyle: string
  outputDeviceId: string
  pitchGapMs: number
  useClonedVoice: boolean
  schedules: ScheduledRecording[]
}
interface CommerceState {
  contexts: Record<string, CommerceContext>
  setProducts: (accountId: string, products: CommerceProduct[]) => void
  selectProduct: (accountId: string, productId: string) => void
  setSchedules: (accountId: string, schedules: ScheduledRecording[]) => void
  updateSettings: (accountId: string, settings: Partial<Pick<CommerceContext, 'autoVoice' | 'voiceRate' | 'voiceProvider' | 'mimoVoice' | 'mimoStyle' | 'outputDeviceId' | 'pitchGapMs' | 'useClonedVoice'>>) => void
}
export const defaultCommerceContext = (): CommerceContext => ({
  products: [], selectedId: '', autoVoice: false, voiceRate: 1,
  voiceProvider: 'system', mimoVoice: '冰糖', mimoStyle: '自然、亲切、清晰的中文讲解语气。', outputDeviceId: 'default', pitchGapMs: 1500,
  useClonedVoice: false, schedules: [],
})
const ensureContext = (state: CommerceState, accountId: string): CommerceContext =>
  state.contexts[accountId] ?? defaultCommerceContext()

export const useVoiceCommerceStore = create<CommerceState>()(
  persist(
    set => {
      eventEmitter.on(EVENTS.ACCOUNT_REMOVED, (accountId: string) => {
        set(state => {
          const contexts = { ...state.contexts }
          delete contexts[accountId]
          return { contexts }
        })
      })
      return {
        contexts: {},
        setProducts: (accountId, products) =>
          set(state => ({
            contexts: {
              ...state.contexts,
              [accountId]: { ...ensureContext(state, accountId), products },
            },
          })),
        setSchedules: (accountId, schedules) =>
          set(state => ({
            contexts: {
              ...state.contexts,
              [accountId]: { ...ensureContext(state, accountId), schedules },
            },
          })),
        selectProduct: (accountId, selectedId) =>
          set(state => ({
            contexts: {
              ...state.contexts,
              [accountId]: { ...ensureContext(state, accountId), selectedId },
            },
          })),
        updateSettings: (accountId, settings) =>
          set(state => ({
            contexts: {
              ...state.contexts,
              [accountId]: { ...ensureContext(state, accountId), ...settings },
            },
          })),
      }
    },
    { name: 'voice-commerce-storage', version: 1 },
  ),
)
