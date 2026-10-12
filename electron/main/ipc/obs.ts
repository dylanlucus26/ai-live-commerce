import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { controlObsMedia, getObsSceneInfo, switchObsScene } from '#/services/ObsService'

export function setupObsIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.scenes, (_, args) => getObsSceneInfo(args))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.switchScene, (_, args) => switchObsScene(args))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.obs.mediaAction, (_, args) => controlObsMedia(args))
}
