import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { IPC_CHANNELS } from '../shared/ipcChannels.ts'

test('all media and inventory IPC controllers are registered during Electron startup', () => {
  const entry = readFileSync(new URL('../electron/main/ipc/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /import \{ setupMediaIpcHandlers \} from ['"]\.\/media['"]/)
  assert.match(entry, /import \{ setupInventoryIpcHandlers \} from ['"]\.\/inventory['"]/)
  assert.match(entry, /setupMediaIpcHandlers\(\)/)
  assert.match(entry, /setupInventoryIpcHandlers\(\)/)
  const media = readFileSync(new URL('../electron/main/ipc/media.ts', import.meta.url), 'utf8')
  const stock = readFileSync(new URL('../electron/main/ipc/inventory.ts', import.meta.url), 'utf8')
  for (const name of ['list','import','remove'])
    assert.match(media, new RegExp('IPC_CHANNELS\\.voiceCommerce\\.media\\.' + name))
  for (const name of ['choose','name','read','clear','bridge'])
    assert.match(stock, new RegExp('IPC_CHANNELS\\.voiceCommerce\\.inventory\\.' + name))
  assert.equal(IPC_CHANNELS.voiceCommerce.media.list, 'voiceCommerce:media:list')
  assert.equal(IPC_CHANNELS.voiceCommerce.inventory.name, 'voiceCommerce:inventory:name')
})
