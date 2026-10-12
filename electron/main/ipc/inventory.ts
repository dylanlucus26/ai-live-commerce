import { IPC_CHANNELS } from 'shared/ipcChannels'
import { fetchBridgeInventory } from '#/services/LocalInventoryBridgeService'
import { typedIpcMainHandle } from '#/utils'
import { clearInventorySource, inventorySourceName, readInventoryFile, selectInventoryFile } from '#/services/InventoryFeedService'

export function setupInventoryIpcHandlers(): void {
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.bridge, (_, port) => fetchBridgeInventory(port))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.choose, (_, accountId) => selectInventoryFile(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.name, (_, accountId) => inventorySourceName(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.read, (_, accountId) => readInventoryFile(accountId))
  typedIpcMainHandle(IPC_CHANNELS.voiceCommerce.inventory.clear, (_, accountId) => clearInventorySource(accountId))
}
