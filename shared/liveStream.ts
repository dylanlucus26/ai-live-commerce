/** OBS transport state. OBS 'streaming' never implies Douyin has confirmed the room is live. */
export type LiveStreamPhase = 'idle' | 'preflight' | 'starting' | 'streaming' | 'stopping' | 'failed'
export interface LiveStreamSnapshot {
  phase: LiveStreamPhase
  accountId: string | null
  obsStreaming: boolean
  ownedByApp: boolean
  startedAt: number | null
  error: string | null
}
export interface LiveStreamObsConfig {
  port: number
  password: string
}
export interface LiveStreamStartOptions extends LiveStreamObsConfig {
  accountId: string
}
export interface LiveStreamPreflight {
  ready: boolean
  alreadyStreaming: boolean
  serviceConfigured: boolean
  reason: string | null
}
