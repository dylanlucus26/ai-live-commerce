import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { clearMiMoKey, hasMiMoKey, saveMiMoKey, synthesizeMiMo } from '#/services/MiMoTTSService'

export function setupVoiceCommerceIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.tts.hasKey, () => hasMiMoKey())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.tts.saveKey, (_, key) => {
    saveMiMoKey(key)
    return true
  })
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.tts.clearKey, () => {
    clearMiMoKey()
    return true
  })
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.tts.synthesize, (_, args) => synthesizeMiMo(args))
}
