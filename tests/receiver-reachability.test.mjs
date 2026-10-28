import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,createConnection} from 'node:net'
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

test('an accepted single-session receiver remains healthy after it stops listening',async()=>{
  const server=createServer()
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const port=server.address().port
  const accepted=once(server,'connection')
  const client=createConnection({host:'127.0.0.1',port})
  await once(client,'connect')
  const [peer]=await accepted
  const closed=new Promise(resolve=>server.close(resolve))
  try{
    assert.equal(await probeLocalRtmpReceiver('rtmp://127.0.0.1:'+port+'/live'),true,
      'The receiver still owns its established media connection')
  }finally{
    peer.destroy();client.destroy()
    await closed
  }
  assert.equal(await probeLocalRtmpReceiver('rtmp://127.0.0.1:'+port+'/live'),false,
    'After both accepted socket and listener close the receiver really is absent')
})
