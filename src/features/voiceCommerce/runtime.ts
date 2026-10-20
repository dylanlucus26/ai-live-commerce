import { create } from 'zustand'
import { useAccounts } from '@/hooks/useAccounts'
import { useVoiceCommerceStore } from '@/hooks/useVoiceCommerce'
import { useCommerceMetrics } from '@/features/voiceCommerce/metrics'
import { VoicePlaybackEngine } from '@/features/voiceCommerce/VoicePlaybackEngine'
import { IPC_CHANNELS } from 'shared/ipcChannels'

export interface RuntimeState {
  nowSpeaking: string
  error: string
  playing: boolean
  pitching: boolean
  broadcastAudioEnabled: boolean
  armedSchedules: boolean
  inventoryPolling: boolean
  inventoryInterval: number
  inventoryMode: 'file' | 'bridge'
  bridgePort: number
  lastInventoryAt: number
  setRuntime: (patch: Partial<Omit<RuntimeState, 'setRuntime'>>) => void
}
export const useVoiceRuntime = create<RuntimeState>()(set => ({
  nowSpeaking: '',
  error: '',
  playing: false,
  pitching: false,
  broadcastAudioEnabled: false,
  armedSchedules: false,
  inventoryPolling: false,
  inventoryInterval: 60,
  inventoryMode: 'file', bridgePort: 18080,
  lastInventoryAt: 0,
  setRuntime: patch => set(patch),
}))
let player: VoicePlaybackEngine | null = null
let playerAccount: string | null = null
export function runtimePlayer(): VoicePlaybackEngine {
  if (!player) {
    player = new VoicePlaybackEngine(
      () => {
        const accountId = useAccounts.getState().currentAccountId
        const current = useVoiceCommerceStore.getState().contexts[accountId]
        const config = { voiceProvider: current?.voiceProvider ?? 'system', voiceRate: current?.voiceRate ?? 1,
          mimoVoice: current?.mimoVoice ?? '冰糖', mimoStyle: current?.mimoStyle ?? '',
          outputDeviceId: current?.outputDeviceId ?? 'default', pitchGapMs: current?.pitchGapMs ?? 1500,
          useClonedVoice: current?.useClonedVoice ?? false }
        return { provider: config.voiceProvider, voiceRate: config.voiceRate,
          mimoVoice: config.mimoVoice, mimoStyle: config.mimoStyle,
          cloneAccountId: config.useClonedVoice ? accountId : undefined,
          outputDeviceId: config.outputDeviceId, pitchGapMs: config.pitchGapMs }
      },
      args => window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.tts.synthesize, args),
      event => {
        const patch = useVoiceRuntime.getState().setRuntime
        if (event.type === 'playing') patch({ playing: true,
          nowSpeaking: event.text, error: '' })
        if (event.type === 'ended') {
          if (event.kind === 'reply' && playerAccount)
            useCommerceMetrics.getState().record(playerAccount, 'voice_played')
          patch({ playing: false, nowSpeaking: '' })
        }
        if (event.type === 'error') {
          if (playerAccount) useCommerceMetrics.getState().record(playerAccount, 'voice_failed')
          patch({ playing: false, pitching: false, error: event.detail, nowSpeaking: '' })
        }
        if (event.type === 'stopped') patch({ playing: false, pitching: false, nowSpeaking: '' })
      },
      {
        enabled: () => useVoiceRuntime.getState().broadcastAudioEnabled,
        play: async audioBase64 => {
          await window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.stream.audioPlay,{wavBase64:audioBase64})
        },
        cancel: () => {
          void window.ipcRenderer.invoke(IPC_CHANNELS.voiceCommerce.stream.audioCancel).catch(() => {})
        },
      },
    )
  }
  return player
}
export function bindRuntimeAccount(accountId: string) {
  if (playerAccount !== accountId) {
    player?.stopAll()
    playerAccount = accountId
    useVoiceRuntime.getState().setRuntime({
      pitching: false, broadcastAudioEnabled: false, armedSchedules: false, inventoryPolling: false, playing: false,
    })
  }
}
export function queueVoiceReply(text: string) {
  runtimePlayer().enqueueReply(text)
  useCommerceMetrics.getState().record(useAccounts.getState().currentAccountId, 'voice_queued')
}
export function stopRuntimeAudio() {
  runtimePlayer().stopAll()
  useVoiceRuntime.getState().setRuntime({ pitching: false })
}
export function startRuntimePitch(lines: string[]) {
  runtimePlayer().startPitch(lines)
  useVoiceRuntime.getState().setRuntime({ pitching: true })
}
export function stopRuntimePitch() {
  runtimePlayer().stopPitch()
  useVoiceRuntime.getState().setRuntime({ pitching: false })
}
export function shutdownRuntime() {
  player?.dispose()
  player = null
  playerAccount = null
  useVoiceRuntime.getState().setRuntime({broadcastAudioEnabled:false})
}
