import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { controlObsMedia, getObsSceneInfo, switchObsScene } from '#/services/ObsService'
import { loadObsProfile } from '#/services/ObsProfileService'

export function setupObsIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.scenes, (_, args) => getObsSceneInfo(args))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.switchScene, (_, args) => switchObsScene(args))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.mediaAction, (_, args) => controlObsMedia(args))
  // Saved credentials are decrypted only in the Electron main process.
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.savedScenes, (_, accountId) =>
    getObsSceneInfo(loadObsProfile(accountId)))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.savedSwitchScene, (_, accountId, sceneName) =>
    switchObsScene({...loadObsProfile(accountId),sceneName}))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.savedMediaAction, (_, accountId, inputName, action) =>
    controlObsMedia({...loadObsProfile(accountId),inputName,action}))
}
