import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { ObsStreamSession } from '#/services/ObsStreamSession'
import { LiveOutputServer } from '#/services/LiveOutputServer'
import { resolveLiveMedia } from '#/services/MediaLibraryService'
import { ManagedObsSceneController } from '#/services/ManagedObsSceneController'
import { VisualPreviewController } from '#/services/VisualPreviewController'
import { getObsStreamStatus } from '#/services/ObsService'
import { LiveBroadcastController } from '#/services/LiveBroadcastController'
import { saveObsProfile, loadObsProfile, obsProfileInfo } from '#/services/ObsProfileService'
import { ObsProcessManager } from '#/services/ObsProcessManager'

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
const broadcast = new LiveBroadcastController(preview,session)
const obsProcess = new ObsProcessManager()
export function setupLiveStreamIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.preflight, (_, config) => session.preflight(config))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.start, (_, options) => session.start(options))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.stop, (_, accountId) => session.stop(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.status, () => session.snapshot())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.refresh, () => session.refresh())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.previewStart, (_, options) => preview.start(options))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.previewStop, (_, accountId) => preview.stop(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.previewStatus, () => preview.snapshot())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.audioPlay, async (_, args) => {
    await output.playAudio(args.wavBase64)
    return true
  })
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.audioCancel, () => {
    output.cancelAudio()
    return true
  })
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.audioStatus, () => output.audioStatus())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.broadcastStart, (_, options) => broadcast.start(options))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.broadcastStop, (_, accountId) => broadcast.stop(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.broadcastStatus, () => broadcast.snapshot())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.saveObsProfile, (_, accountId, config, accepted) =>
    saveObsProfile(accountId,config,accepted))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.obsProfileInfo, (_, accountId) => obsProfileInfo(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.oneClickStart, async (_, args) => {
    const profile=loadObsProfile(args.accountId)
    await obsProcess.ensureReady(profile)
    return broadcast.start({...profile,accountId:args.accountId,mediaIds:args.mediaIds})
  })
}

/** Managed output must not survive Electron main window shutdown unnoticed. */
export function isManagedBroadcastActive(): boolean {
  const live = broadcast.snapshot()
  return live.phase === 'preparing' || live.phase === 'streaming' || live.phase === 'stopping'
    || live.obsStreaming || preview.snapshot().previewing || session.snapshot().ownedByApp
}
export async function stopManagedBroadcastForExit(): Promise<void> {
  output.cancelAudio()
  const current = broadcast.snapshot()
  if (current.accountId && (current.obsStreaming || current.visualReady)) {
    await broadcast.stop(current.accountId)
  }
  const raw = session.snapshot()
  if (raw.ownedByApp && raw.accountId) await session.stop(raw.accountId)
  const visual = preview.snapshot()
  if (visual.previewing && visual.accountId) await preview.stop(visual.accountId)
  await output.stop()
}
