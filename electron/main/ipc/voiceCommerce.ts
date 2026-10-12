import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { clearMiMoKey, hasMiMoKey, saveMiMoKey, synthesizeMiMo, clearMiMoAudioCache } from '#/services/MiMoTTSService'

import { chooseVoiceReference, deleteVoiceReference, hasVoiceReference } from '#/services/VoiceReferenceService'

export function setupVoiceCommerceIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.clone.has, (_, accountId) => hasVoiceReference(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.clone.select, async (_, accountId, authorized) => {
    const ok = await chooseVoiceReference(accountId, authorized)
    if (ok) clearMiMoAudioCache()
    return ok
  })
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.clone.remove, (_, accountId) => {
    clearMiMoAudioCache()
    return deleteVoiceReference(accountId)
  })
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
