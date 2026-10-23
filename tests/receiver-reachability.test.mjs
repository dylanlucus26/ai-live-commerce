import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {probeLocalRtmpReceiver} from '../electron/main/services/ReceiverReachabilityService.ts'

test('loopback receiver probe sees a real listening TCP socket then its closure',async()=>{
  const server=createServer(socket=>socket.end())
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const port=server.address().port
  try{
    assert.equal(await probeLocalRtmpReceiver('rtmp://127.0.0.1:'+port+'/live'),true)
    assert.equal(await probeLocalRtmpReceiver('rtmp://localhost:'+port+'/live'),true)
  }finally{
    await new Promise(resolve=>server.close(resolve))
  }
  assert.equal(await probeLocalRtmpReceiver('rtmp://127.0.0.1:'+port+'/live',500),false)
})

test('never probes remote RTMP hosts or URLs with credentials',async()=>{
  for(const candidate of [
    'rtmp://live.example.com/live/key','rtmps://stream.example.com/live',
    'https://127.0.0.1:1935/live','rtmp://user:pass@127.0.0.1:1935/live',
    'not-a-stream',null,'rtmp://192.168.1.5/live',
  ]){
    assert.equal(await probeLocalRtmpReceiver(candidate),undefined)
  }
})
