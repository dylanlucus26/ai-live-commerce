import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { ObsStreamSession } from '#/services/ObsStreamSession'
import { LiveOutputServer } from '#/services/LiveOutputServer'
import { resolveLiveMedia } from '#/services/MediaLibraryService'
import { ManagedObsSceneController } from '#/services/ManagedObsSceneController'
import { VisualPreviewController } from '#/services/VisualPreviewController'
import { getObsStreamStatus } from '#/services/ObsService'

const session = new ObsStreamSession(undefined, snapshot => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.voiceCommerce.stream.changed, snapshot)
  }
})
const output = new LiveOutputServer((accountId,mediaId)=>{
  const asset=resolveLiveMedia(accountId,mediaId)
  return asset?{id:mediaId,...asset}:null
})
const preview = new VisualPreviewController(output,new ManagedObsSceneController(),getObsStreamStatus)
export function setupLiveStreamIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.preflight, (_, config) => session.preflight(config))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.start, (_, options) => session.start(options))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.stop, (_, accountId) => session.stop(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.status, () => session.snapshot())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.refresh, () => session.refresh())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.previewStart, (_, options) => preview.start(options))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.previewStop, (_, accountId) => preview.stop(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.previewStatus, () => preview.snapshot())
}
