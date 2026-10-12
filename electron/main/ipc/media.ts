import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { deleteMedia, importMedia, listMedia } from '#/services/MediaLibraryService'

export function setupMediaIpcHandlers(): void {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.media.list, (_, accountId) => listMedia(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.media.import, (_, accountId, kind) => importMedia(accountId, kind))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.media.remove, (_, accountId, id) => deleteMedia(accountId, id))
}
