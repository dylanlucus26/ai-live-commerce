import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ObsStreamSession } from '../electron/main/services/ObsStreamSession.ts'

const config = { accountId: 'test-account', port: 4455, password: 'not-persisted' }
const create = () => {
  const requests = []
  const state = { active: false, serviceConfigured: true }
  const transport = {
    getStatus: async () => { requests.push('status'); return { active: state.active, reconnecting: false, durationMs: 0 } },
    getService: async () => { requests.push('service'); return { configured: state.serviceConfigured, serviceType: 'rtmp_custom' } },
    start: async () => { requests.push('start'); state.active = true },
    stop: async () => { requests.push('stop'); state.active = false },
  }
  return { session: new ObsStreamSession(transport), state, requests, transport }
}

test('OBS preflight verifies service and never starts a stream', async () => {
  const { session, requests } = create()
  assert.deepEqual(await session.preflight(config), {
    ready: true, alreadyStreaming: false, serviceConfigured: true, reason: null,
  })
  assert.deepEqual(requests, ['status', 'service'])
})

test('unconfigured OBS service blocks StartStream', async () => {
  const { session, state, requests } = create()
  state.serviceConfigured = false
  await assert.rejects(session.start(config), /尚未配置流服务/)
  assert.equal(session.snapshot().phase, 'failed')
  assert.equal(requests.includes('start'), false)
})

test('pre-existing OBS stream cannot be adopted or stopped', async () => {
  const { session, state, requests } = create()
  state.active = true
  await assert.rejects(session.start(config), /已在推流/)
  await assert.rejects(session.stop(config.accountId), /不会停止外部直播/)
  assert.equal(requests.includes('start'), false)
  assert.equal(requests.includes('stop'), false)
})

test('owned stream only: idempotent start, account isolation and stop', async () => {
  const { session, requests } = create()
  const started = await session.start(config)
  assert.equal(started.phase, 'streaming')
  assert.equal(started.ownedByApp, true)
  assert.equal(started.obsStreaming, true)
  await session.start(config)
  assert.equal(requests.filter(v => v === 'start').length, 1)
  await assert.rejects(session.start({ ...config, accountId: 'other' }), /已有直播会话/)
  await assert.rejects(session.stop('other'), /账号不匹配/)
  const stopped = await session.stop(config.accountId)
  assert.equal(stopped.phase, 'idle')
  assert.equal(stopped.ownedByApp, false)
  assert.equal(requests.filter(v => v === 'stop').length, 1)
  await assert.rejects(session.stop(config.accountId), /不会停止外部直播/)
})

test('stream startup transport error never declares success', async () => {
  const { session, transport } = create()
  transport.start = async () => { throw new Error('connection reset') }
  await assert.rejects(session.start(config), /connection reset/)
  assert.equal(session.snapshot().phase, 'failed')
  assert.equal(session.snapshot().obsStreaming, false)
  assert.equal(session.snapshot().ownedByApp, false)
})

test('lost StartStream acknowledgment never adopts a concurrently active external stream', async () => {
  const { session, transport, state, requests } = create()
  transport.start = async () => {
    requests.push('start-failed')
    state.active = true // Could belong to another OBS operator.
    throw new Error('StartStream response lost')
  }
  await assert.rejects(session.start(config), /response lost/)
  assert.equal(session.snapshot().obsStreaming, true)
  assert.equal(session.snapshot().ownedByApp, false)
  assert.match(session.snapshot().error, /无法确认归属/)
  await assert.rejects(session.stop(config.accountId), /不会停止外部直播/)
  assert.equal(requests.includes('stop'), false)
})

test('accepted StartStream retains safe stop ownership after status query timeout', async () => {
  const { session, transport, state, requests } = create()
  let accepted = false
  const originalGetStatus = transport.getStatus
  transport.start = async () => {
    accepted = true
    state.active = true
    requests.push('start-accepted')
  }
  transport.getStatus = async config => {
    if (accepted) throw new Error('GetStreamStatus timeout')
    return originalGetStatus(config)
  }
  await assert.rejects(session.start(config), /GetStreamStatus timeout/)
  assert.equal(session.snapshot().ownedByApp, true)
  transport.getStatus = originalGetStatus
  assert.equal((await session.stop(config.accountId)).phase, 'idle')
  assert.equal(requests.includes('stop'), true)
})

test('stop error preserves owned session so operator can retry', async () => {
  const { session, transport, state } = create()
  await session.start(config)
  transport.stop = async () => { throw new Error('OBS returned 500') }
  await assert.rejects(session.stop(config.accountId), /OBS returned 500/)
  assert.equal(session.snapshot().phase, 'failed')
  assert.equal(session.snapshot().ownedByApp, true)
  assert.equal(state.active, true)
  transport.stop = async () => { state.active = false }
  assert.equal((await session.stop(config.accountId)).phase, 'idle')
})

test('external interruption detected by status refresh', async () => {
  const { session, state } = create()
  await session.start(config)
  state.active = false
  const current = await session.refresh()
  assert.equal(current.phase, 'failed')
  assert.equal(current.ownedByApp, false)
  assert.match(current.error, /已中断/)
})

test('account identifier validation and concurrent duplicate calls', async () => {
  const { session, transport, state } = create()
  await assert.rejects(session.start({ ...config, accountId: '../bad' }), /账号标识无效/)
  let resolveStart
  transport.start = async () => new Promise(resolve => { resolveStart = () => { state.active = true; resolve() } })
  const pending = session.start(config)
  await new Promise(resolve => setTimeout(resolve, 20))
  await assert.rejects(session.start(config), /正在进行/)
  resolveStart()
  const current = await pending
  assert.equal(current.phase, 'streaming')
  await session.stop(config.accountId)
})
