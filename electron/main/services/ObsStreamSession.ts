import {
  getObsStreamServiceInfo, getObsStreamStatus, requestObsStreamStart, requestObsStreamStop,
} from './ObsService'
import type { ObsStreamStatus, ObsStreamServiceInfo } from './ObsService'
import type {
  LiveStreamSnapshot, LiveStreamObsConfig, LiveStreamPreflight, LiveStreamStartOptions,
} from 'shared/liveStream'

/** A deliberately narrow transport interface so lifecycle behavior can be tested without a real stream. */
export interface StreamTransport {
  getStatus(config: LiveStreamObsConfig): Promise<ObsStreamStatus>
  getService(config: LiveStreamObsConfig): Promise<ObsStreamServiceInfo>
  start(config: LiveStreamObsConfig): Promise<void>
  stop(config: LiveStreamObsConfig): Promise<void>
}
const defaultTransport: StreamTransport = {
  getStatus: getObsStreamStatus,
  getService: getObsStreamServiceInfo,
  start: requestObsStreamStart,
  stop: requestObsStreamStop,
}
const initialSnapshot = (): LiveStreamSnapshot => ({
  phase: 'idle', accountId: null, obsStreaming: false, ownedByApp: false, startedAt: null, error: null,
})
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Only this session may stop a stream it started; externally running OBS streams are never adopted.
 * This is transport groundwork only. v0.3.0's media/voice readiness must be added before exposing
 * the real one-click go-live button to end users.
 */
export class ObsStreamSession {
  private current: LiveStreamSnapshot = initialSnapshot()
  private ownedConfig: LiveStreamObsConfig | null = null
  private busy = false

  constructor(
    private readonly transport: StreamTransport = defaultTransport,
    private readonly onChange: (state: LiveStreamSnapshot) => void = () => {},
  ) {}

  snapshot(): LiveStreamSnapshot { return { ...this.current } }
  private update(patch: Partial<LiveStreamSnapshot>): LiveStreamSnapshot {
    this.current = { ...this.current, ...patch }
    this.onChange(this.snapshot())
    return this.snapshot()
  }

  async preflight(config: LiveStreamObsConfig): Promise<LiveStreamPreflight> {
    const status = await this.transport.getStatus(config)
    if (status.active) return {
      ready: false, alreadyStreaming: true, serviceConfigured: false,
      reason: 'OBS 已在推流。不会接管或停止外部直播。',
    }
    const service = await this.transport.getService(config)
    return {
      ready: service.configured,
      alreadyStreaming: false,
      serviceConfigured: service.configured,
      reason: service.configured ? null : 'OBS 尚未配置流服务，请先在 OBS 中设置已授权的推流目标。',
    }
  }

  async start(options: LiveStreamStartOptions): Promise<LiveStreamSnapshot> {
    if (!/^[a-zA-Z0-9_-]{1,120}$/u.test(options.accountId))
      throw new Error('直播账号标识无效')
    if (this.busy) throw new Error('直播操作正在进行，请勿重复提交')
    if (this.current.ownedByApp) {
      if (this.current.accountId === options.accountId && this.current.phase === 'streaming')
        return this.snapshot()
      throw new Error('已有直播会话，必须先结束原会话')
    }
    this.busy = true
    this.update({ phase: 'preflight', accountId: options.accountId, error: null, obsStreaming: false, ownedByApp: false, startedAt: null })
    let startRequested = false
    let startAcknowledged = false
    const config = { port: options.port, password: options.password }
    try {
      const check = await this.preflight(config)
      if (!check.ready) throw new Error(check.reason ?? 'OBS 推流预检失败')
      this.update({ phase: 'starting' })
      // A request alone does not establish ownership: a concurrent external stream
      // may start while our StartStream RPC is in flight. Require a positive reply.
      startRequested = true
      await this.transport.start(config)
      startAcknowledged = true
      let status = await this.transport.getStatus(config)
      for (let i = 0; !status.active && i < 12; i++) {
        await wait(250)
        status = await this.transport.getStatus(config)
      }
      if (!status.active) throw new Error('OBS 已接受开始请求，但未确认推流成功')
      this.ownedConfig = config
      return this.update({ phase: 'streaming', obsStreaming: true, ownedByApp: true, startedAt: Date.now() })
    } catch (error) {
      // If StartStream was submitted but its reply was lost, an active stream
      // could be ours OR another operator's. Never adopt/stop it without proof.
      let active = false
      if (startRequested) {
        try { active = (await this.transport.getStatus(config)).active } catch { /* unknown */ }
      }
      // A positively accepted StartStream remains ours even when later polling fails:
      // retain the stop capability for this account until its output is confirmed idle.
      this.ownedConfig = startAcknowledged ? config : null
      const reason = error instanceof Error ? error.message : 'OBS 开播失败'
      this.update({
        phase: 'failed', obsStreaming: active, ownedByApp: startAcknowledged,
        error: startRequested && !startAcknowledged && active
          ? reason + '；OBS 当前正在推流，但无法确认归属，请在 OBS 内手动检查，软件不会强制停掉它。'
          : reason,
      })
      throw error
    } finally {
      this.busy = false
    }
  }

  async refresh(): Promise<LiveStreamSnapshot> {
    if (this.busy || !this.ownedConfig) return this.snapshot()
    try {
      const status = await this.transport.getStatus(this.ownedConfig)
      if (!status.active && this.current.ownedByApp) {
        this.ownedConfig = null
        return this.update({ phase: 'failed', obsStreaming: false, ownedByApp: false,
          error: 'OBS 推流已中断，请检查网络和 OBS 输出状态。' })
      }
      return this.update({ obsStreaming: status.active })
    } catch (error) {
      return this.update({ phase: 'failed', error: error instanceof Error ? error.message : 'OBS 状态查询失败' })
    }
  }

  async stop(accountId: string): Promise<LiveStreamSnapshot> {
    if (this.busy) throw new Error('直播操作正在进行，请稍后再试')
    if (!this.ownedConfig || !this.current.ownedByApp)
      throw new Error('当前没有本软件启动的 OBS 推流，不会停止外部直播')
    if (accountId !== this.current.accountId) throw new Error('直播账号不匹配，拒绝停止')
    this.busy = true
    const config = this.ownedConfig
    this.update({ phase: 'stopping', error: null })
    try {
      const state = await this.transport.getStatus(config)
      if (state.active) await this.transport.stop(config)
      let status = await this.transport.getStatus(config)
      for (let i = 0; status.active && i < 12; i++) {
        await wait(250)
        status = await this.transport.getStatus(config)
      }
      if (status.active) throw new Error('OBS 尚未确认停止推流')
      this.ownedConfig = null
      this.current = initialSnapshot()
      this.onChange(this.snapshot())
      return this.snapshot()
    } catch (error) {
      this.update({ phase: 'failed', error: error instanceof Error ? error.message : 'OBS 停播失败' })
      throw error
    } finally {
      this.busy = false
    }
  }
}
