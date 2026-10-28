import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { probeLocalRtmpReceiver } from './ReceiverReachabilityService'
import { MacObsBrowserBootstrap } from './MacObsBrowserBootstrap'
const macBrowserBootstrap = new MacObsBrowserBootstrap()

interface ObsConfig {
  port: number
  password: string
}
export interface ObsSceneInfo {
  scenes: string[]
  currentScene: string
  mediaInputs: string[]
}
function sha256Base64(input: string): string {
  return createHash('sha256').update(input).digest('base64')
}
export function obsAuthentication(password: string, challenge: string, salt: string): string {
  const secret = sha256Base64(password + salt)
  return sha256Base64(secret + challenge)
}
const ALLOWED_REQUESTS = new Set([
  'GetSceneList','GetInputList','SetCurrentProgramScene','TriggerMediaInputAction',
  'GetStreamStatus','GetStreamServiceSettings','StartStream','StopStream',
  'CreateScene','CreateInput','RemoveScene','GetVideoSettings',
  'GetOutputList',
  'GetSceneCollectionList','CreateSceneCollection','SetCurrentSceneCollection',
])
async function obsRequest(
  config: ObsConfig,
  requestType: string,
  requestData?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!ALLOWED_REQUESTS.has(requestType)) throw new Error('不支持的 OBS 操作')
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('OBS 端口范围必须为 1024～65535')
  }
  if (config.password.length > 256) throw new Error('OBS 密码过长')
  const requestId = randomUUID()
  const url = 'ws://127.0.0.1:' + config.port
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 5000, perMessageDeflate: false })
    let done = false
    const timeout = setTimeout(() => fail(new Error('OBS 连接超时')), 8000)
    const finish = (value: Record<string, unknown>) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      ws.close()
      resolve(value)
    }
    const fail = (error: Error) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      ws.terminate()
      reject(error)
    }
    ws.on('message', raw => {
      if (done) return
      try {
        const packet = JSON.parse(raw.toString()) as { op: number; d?: Record<string, unknown> }
        const data = packet.d ?? {}
        if (packet.op === 0) {
          const auth = data.authentication as { challenge?: string; salt?: string } | undefined
          const identify: Record<string, unknown> = { rpcVersion: 1 }
          if (auth) {
            if (!config.password || !auth.challenge || !auth.salt) throw new Error('OBS 需要 WebSocket 密码')
            identify.authentication = obsAuthentication(config.password, auth.challenge, auth.salt)
          }
          ws.send(JSON.stringify({ op: 1, d: identify }))
        }
        if (packet.op === 2) {
          ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData: requestData ?? {} } }))
        }
        if (packet.op === 7 && data.requestId === requestId) {
          const status = data.requestStatus as { result?: boolean; code?: number } | undefined
          if (!status?.result) throw new Error('OBS 拒绝操作（错误码 ' + (status?.code ?? '?') + '）')
          finish((data.responseData as Record<string, unknown>) ?? {})
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error('OBS 返回的数据格式错误'))
      }
    })
    ws.on('error', () => fail(new Error('无法连接本机 OBS，请检查是否开启 WebSocket 服务')))
    ws.on('close', () => { if (!done) fail(new Error('OBS 连接已断开，密码或协议版本可能不匹配')) })
  })
}

export async function getObsSceneInfo(config: ObsConfig): Promise<ObsSceneInfo> {
  const [sceneData, inputData] = await Promise.all([
    obsRequest(config, 'GetSceneList'), obsRequest(config, 'GetInputList'),
  ])
  const scenes = Array.isArray(sceneData.scenes) ? sceneData.scenes : []
  const inputs = Array.isArray(inputData.inputs) ? inputData.inputs : []
  return {
    scenes: scenes.map(item => typeof item.sceneName === 'string' ? item.sceneName : '').filter(Boolean).slice(0, 200),
    currentScene: typeof sceneData.currentProgramSceneName === 'string' ? sceneData.currentProgramSceneName : '',
    mediaInputs: inputs.filter(item => item.inputKind === 'ffmpeg_source' || item.inputKind === 'vlc_source')
      .map(item => typeof item.inputName === 'string' ? item.inputName : '').filter(Boolean).slice(0, 200),
  }
}
/** Read OBS's actual canvas; never change the operator's output settings. */
export async function getObsCanvasSize(config: ObsConfig): Promise<{width:number;height:number}> {
  const settings=await obsRequest(config,'GetVideoSettings')
  const width=settings.baseWidth,height=settings.baseHeight
  if(typeof width!=='number'||typeof height!=='number'||!Number.isInteger(width)||!Number.isInteger(height)
    ||width<1||height<1||width>8192||height>8192)throw new Error('无法确认 OBS 画布尺寸')
  return {width,height}
}
export async function switchObsScene(config: ObsConfig & { sceneName: string }): Promise<boolean> {
  const sceneName = config.sceneName.trim()
  if (!sceneName || sceneName.length > 200) throw new Error('请先选择有效的 OBS 场景')
  await obsRequest(config, 'SetCurrentProgramScene', { sceneName })
  return true
}
export async function controlObsMedia(
  config: ObsConfig & { inputName: string; action: 'play' | 'pause' | 'restart' | 'stop' },
): Promise<boolean> {
  if (!config.inputName.trim() || config.inputName.length > 200) throw new Error('请先选择 OBS 媒体源')
  const actions = {
    play: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
    pause: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
    restart: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    stop: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP',
  }
  await obsRequest(config, 'TriggerMediaInputAction', {
    inputName: config.inputName, mediaAction: actions[config.action],
  })
  return true
}

/** OBS outputActive is the authoritative OBS transport status, NOT platform go-live confirmation. */
export interface ObsStreamStatus {
  active: boolean
  reconnecting: boolean
  durationMs: number
  /** Total bytes OBS reports emitted to the streaming output, when supported. */
  outputBytes?: number
  /** OBS transport congestion in [0,1], when supported. */
  congestion?: number
}
export interface ObsStreamServiceInfo {
  configured: boolean
  serviceType: string
}
export async function getObsStreamStatus(config: ObsConfig): Promise<ObsStreamStatus> {
  const response = await obsRequest(config, 'GetStreamStatus')
  return {
    active: response.outputActive === true,
    reconnecting: response.outputReconnecting === true,
    durationMs: typeof response.outputDuration === 'number' && Number.isFinite(response.outputDuration)
      ? Math.max(0, response.outputDuration) : 0,
    outputBytes: typeof response.outputBytes === 'number' && Number.isFinite(response.outputBytes)
      ? Math.max(0, response.outputBytes) : undefined,
    congestion: typeof response.outputCongestion === 'number' && Number.isFinite(response.outputCongestion)
      ? Math.max(0, Math.min(1, response.outputCongestion)) : undefined,
  }
}
export async function getObsStreamServiceInfo(config: ObsConfig): Promise<ObsStreamServiceInfo> {
  const response = await obsRequest(config, 'GetStreamServiceSettings')
  const serviceType = typeof response.streamServiceType === 'string' ? response.streamServiceType : ''
  // The service type alone is NOT proof of a valid streaming destination.
  // Never return the server/key to the renderer: they may contain private credentials.
  const settings = response.streamServiceSettings as Record<string, unknown> | undefined
  const key = typeof settings?.key === 'string' ? settings.key.trim() : ''
  const server = typeof settings?.server === 'string' ? settings.server.trim() : ''
  const configured = serviceType === 'rtmp_custom'
    ? /^rtmps?:\/\/[^\s@]+/u.test(server) && key.length > 0
    : serviceType.length > 0 && key.length > 0
  return { configured, serviceType }
}
/** Only confirms reachability of a configured local RTMP listening port.
 * No credentials or full RTMP path are sent; remote platform health is UNKNOWN.
 */
export async function getObsLocalReceiverReachability(config: ObsConfig): Promise<boolean | undefined> {
  const response=await obsRequest(config,'GetStreamServiceSettings')
  if(response.streamServiceType!=='rtmp_custom')return undefined
  const settings=response.streamServiceSettings as Record<string,unknown>|undefined
  return probeLocalRtmpReceiver(settings?.server)
}
export async function requestObsStreamStart(config: ObsConfig): Promise<void> {
  await obsRequest(config, 'StartStream')
}
export async function requestObsStreamStop(config: ObsConfig): Promise<void> {
  await obsRequest(config, 'StopStream')
}

/** A session must use unique scene/input names; never overwrite existing OBS assets. */
export async function createObsManagedScene(config: ObsConfig, sceneName: string): Promise<void> {
  if (process.platform === 'darwin') {
    await macBrowserBootstrap.initialize((type, data) => obsRequest(config, type, data))
  }
  await obsRequest(config, 'CreateScene', { sceneName })
}
export async function createObsBrowserInput(
  config: ObsConfig, params: { sceneName: string; inputName: string; url: string; width: number; height: number },
): Promise<void> {
  await obsRequest(config,'CreateInput',{
    sceneName:params.sceneName, inputName:params.inputName, inputKind:'browser_source',
    inputSettings:{
      url:params.url, width:params.width, height:params.height,
      reroute_audio:true, shutdown:false,
    },
    sceneItemEnabled:true,
  })
}
export async function removeObsManagedScene(config: ObsConfig, sceneName: string): Promise<void> {
  await obsRequest(config, 'RemoveScene', { sceneName })
}
