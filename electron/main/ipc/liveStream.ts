import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { ObsStreamSession } from '#/services/ObsStreamSession'

const session = new ObsStreamSession(undefined, snapshot => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.voiceCommerce.stream.changed, snapshot)
  }
})
export function setupLiveStreamIpcHandlers() {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.preflight, (_, config) => session.preflight(config))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.start, (_, options) => session.start(options))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.stop, (_, accountId) => session.stop(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.status, () => session.snapshot())
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.stream.refresh, () => session.refresh())
}
