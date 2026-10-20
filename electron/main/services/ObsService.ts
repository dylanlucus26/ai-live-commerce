import { createHash, randomUUID } from 'node:crypto'
import WebSocket from 'ws'

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
const ALLOWED_REQUESTS = new Set(['GetSceneList', 'GetInputList', 'SetCurrentProgramScene', 'TriggerMediaInputAction', 'GetStreamStatus', 'GetStreamServiceSettings', 'StartStream', 'StopStream'])
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
  }
}
export async function getObsStreamServiceInfo(config: ObsConfig): Promise<ObsStreamServiceInfo> {
  const response = await obsRequest(config, 'GetStreamServiceSettings')
  const serviceType = typeof response.streamServiceType === 'string' ? response.streamServiceType : ''
  // Never pass streamServiceSettings to the renderer: it may contain the private stream key.
  return { configured: serviceType.length > 0, serviceType }
}
export async function requestObsStreamStart(config: ObsConfig): Promise<void> {
  await obsRequest(config, 'StartStream')
}
export async function requestObsStreamStop(config: ObsConfig): Promise<void> {
  await obsRequest(config, 'StopStream')
}
