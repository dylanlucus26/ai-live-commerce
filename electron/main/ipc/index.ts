import { setupAIChatIpcHandlers } from './aichat'
import { setupAppIpcHandlers } from './app'
import { setupAutoMessageIpcHandlers } from './autoMessage'
import { setupAutoPopUpIpcHandlers } from './autoPopUp'
import { setupBrowserIpcHandlers } from './browser'
import { setupAutoReplyIpcHandlers } from './commentListener'
import { setupLiveControlIpcHandlers } from './connection'
import { setupPinCommentIpcHandler } from './pinComment'
import { setupRedPacketIpcHandlers } from './redPacket'
import { setupUpdateIpcHandlers } from './update'
import { setupVoiceCommerceIpcHandlers } from './voiceCommerce'
import { setupObsIpcHandlers } from './obs'
import { setupMediaIpcHandlers } from './media'
import { setupInventoryIpcHandlers } from './inventory'

setupLiveControlIpcHandlers()
setupAIChatIpcHandlers()
setupAutoPopUpIpcHandlers()
setupAutoReplyIpcHandlers()
setupAutoMessageIpcHandlers()
setupBrowserIpcHandlers()
setupAppIpcHandlers()
setupUpdateIpcHandlers()
setupPinCommentIpcHandler()
setupRedPacketIpcHandlers()
setupVoiceCommerceIpcHandlers()
setupObsIpcHandlers()
setupLiveStreamIpcHandlers()
setupMediaIpcHandlers()
setupInventoryIpcHandlers()
