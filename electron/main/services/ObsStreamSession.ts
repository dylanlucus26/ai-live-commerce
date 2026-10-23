import {
  getObsStreamServiceInfo, getObsStreamStatus, getObsLocalReceiverReachability,
  requestObsStreamStart, requestObsStreamStop,
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
  /** Optional receiver-side liveness; undefined means remote destination is unobservable. */
  getLocalReceiverReachability?(config: LiveStreamObsConfig): Promise<boolean | undefined>
}
const defaultTransport: StreamTransport = {
  getStatus: getObsStreamStatus,
  getService: getObsStreamServiceInfo,
  start: requestObsStreamStart,
  stop: requestObsStreamStop,
  getLocalReceiverReachability: getObsLocalReceiverReachability,
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
  private lastOutputBytes: number | null = null
  private lastByteProgressAt = 0
  private congestedSince: number | null = null
  private localReceiverFailures = 0

  constructor(
    private readonly transport: StreamTransport = defaultTransport,
    private readonly onChange: (state: LiveStreamSnapshot) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): LiveStreamSnapshot { return { ...this.current } }
  private update(patch: Partial<LiveStreamSnapshot>): LiveStreamSnapshot {
    this.current = { ...this.current, ...patch }
    this.onChange(this.snapshot())
    return this.snapshot()
  }

  async preflight(config: LiveStreamObsConfig): Promise<LiveStreamPreflight> {
    const status = await this.transport.getStatus(config)
    if (status.active || status.reconnecting) return {
      ready: false, alreadyStreaming: status.active, serviceConfigured: false,
      reason: status.reconnecting
        ? 'OBS 正在重连，尚未确认流接收端就绪；不会接管其他直播。'
        : 'OBS 已在推流。不会接管或停止外部直播。',
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
    this.lastOutputBytes = null
    this.lastByteProgressAt = 0
    this.congestedSince = null
    this.localReceiverFailures = 0
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
      // outputActive may be true while OBS is still reconnecting and the remote
      // RTMP receiver has no packets. Never label that state "直播中".
      for (let i = 0; (!status.active || status.reconnecting) && i < 12; i++) {
        await wait(250)
        status = await this.transport.getStatus(config)
      }
      if (!status.active || status.reconnecting)
        throw new Error(status.reconnecting
          ? 'OBS 正在重连，流接收端尚未确认；请检查 RTMP 连接。'
          : 'OBS 已接受开始请求，但未确认推流成功')
      this.ownedConfig = config
      this.lastOutputBytes = status.outputBytes ?? null
      this.lastByteProgressAt = this.now()
      this.congestedSince = null
      this.localReceiverFailures = 0
      return this.update({ phase: 'streaming', obsStreaming: true, ownedByApp: true, startedAt: this.now() })
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
      if (status.reconnecting && this.current.ownedByApp) {
        return this.update({
          phase: 'failed', obsStreaming: status.active, ownedByApp: true,
          error: 'OBS 推流正在重连，观众可能无法收到音视频；已暂停 AI 自动互动，请检查 RTMP 接收端。',
        })
      }
      if (!status.active && this.current.ownedByApp) {
        this.ownedConfig = null
        return this.update({ phase: 'failed', obsStreaming: false, ownedByApp: false,
          error: 'OBS 推流已中断，请检查网络和 OBS 输出状态。' })
      }
      // OBS can keep incrementing outputBytes with zero reported congestion
      // even after a TCP receiver has died. For explicitly local destinations
      // only, independently check whether the RTMP receiver still listens.
      // Two consecutive failed checks avoid one transient socket refusal.
      if (status.active && this.current.ownedByApp && this.current.phase === 'streaming' &&
          this.transport.getLocalReceiverReachability) {
        const reachable=await this.transport.getLocalReceiverReachability(this.ownedConfig)
        if(reachable===false) {
          this.localReceiverFailures++
          if(this.localReceiverFailures>=2){
            return this.update({
              phase: 'failed', obsStreaming: true, ownedByApp: true,
              error: '本机 RTMP 接收端连续两次无法连接。即使 OBS 显示推流中，也无法确认音视频送达；已暂停 AI 自动互动。',
            })
          }
        } else if(reachable===true)this.localReceiverFailures=0
      }
      // An active OBS output may remain "true" after the actual RTMP receiver
      // disconnects. The output byte counter is a second, independent liveness
      // signal. Ignore unsupported metrics rather than manufacturing certainty.
      if (status.active && this.current.ownedByApp && this.current.phase === 'streaming') {
        const now = this.now()
        if (status.outputBytes !== undefined) {
          if (this.lastOutputBytes === null || status.outputBytes > this.lastOutputBytes ||
              status.outputBytes < this.lastOutputBytes) {
            this.lastOutputBytes = status.outputBytes
            this.lastByteProgressAt = now
          } else if (now - this.lastByteProgressAt >= 12000) {
            return this.update({
              phase: 'failed', obsStreaming: true, ownedByApp: true,
              error: 'OBS 虽仍显示推流中，但输出字节超过 12 秒未增长；RTMP 接收端可能已断开。已暂停 AI 自动互动，请核查接收端。',
            })
          }
        }
        if (status.congestion !== undefined && status.congestion >= 0.98) {
          this.congestedSince ??= now
          if (now - this.congestedSince >= 12000) {
            return this.update({
              phase: 'failed', obsStreaming: true, ownedByApp: true,
              error: 'OBS 网络拥塞持续超过 12 秒，实际音视频可能无法送达；已暂停 AI 自动互动。',
            })
          }
        } else this.congestedSince = null
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
      this.lastOutputBytes = null
      this.lastByteProgressAt = 0
      this.congestedSince = null
      this.localReceiverFailures = 0
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
