import { IPC_CHANNELS } from 'shared/ipcChannels'
import { typedIpcMainHandle } from '#/utils'
import { clearInventorySource, inventorySourceName, readInventoryFile, selectInventoryFile } from '#/services/InventoryFeedService'

export function setupInventoryIpcHandlers(): void {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.choose, (_, accountId) => selectInventoryFile(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.name, (_, accountId) => inventorySourceName(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.read, (_, accountId) => readInventoryFile(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.clear, (_, accountId) => clearInventorySource(accountId))
}
