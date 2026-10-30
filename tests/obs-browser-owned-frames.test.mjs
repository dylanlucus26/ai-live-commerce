import {test} from 'node:test'
import assert from 'node:assert/strict'
import {WebSocketServer} from 'ws'
import {createObsBrowserInput} from '../electron/main/services/ObsService.ts'

test('product source opt-in is scoped to the created Mac browser, without changing video or other sources',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0})
  await new Promise(resolve=>server.once('listening',resolve))
  const calls=[]
  server.on('connection',socket=>{
    socket.send(JSON.stringify({op:0,d:{rpcVersion:1}}))
    socket.on('message',raw=>{
      const packet=JSON.parse(String(raw))
      if(packet.op===1)socket.send(JSON.stringify({op:2,d:{negotiatedRpcVersion:1}}))
      if(packet.op===6){
        calls.push(packet.d)
        socket.send(JSON.stringify({op:7,d:{requestId:packet.d.requestId,
          requestStatus:{result:true,code:100},responseData:{}}}))
      }
    })
  })
  try{
    const url='http://127.0.0.1:32123/'+'a'.repeat(48)+'/index.html'
    await createObsBrowserInput({port:server.address().port,password:''},{
      sceneName:'AI Live Commerce - 12345678',inputName:'Own product source',
      url,width:1280,height:720,
    })
    assert.deepEqual(calls.map(x=>x.requestType),['CreateInput'])
    const data=calls[0].requestData,settings=data.inputSettings
    assert.equal(data.sceneName,'AI Live Commerce - 12345678')
    assert.equal(data.inputName,'Own product source')
    assert.equal(data.inputKind,'browser_source')
    assert.equal(data.sceneItemEnabled,true)
    assert.equal(settings.url,url);assert.equal(settings.width,1280);assert.equal(settings.height,720)
    assert.equal(settings.reroute_audio,true)
    assert.equal(settings.macos_owned_frame_queue,process.platform==='darwin'?true:undefined)
    assert.equal(settings.fps_custom,undefined)
    assert.equal(settings.fps,undefined)
  }finally{
    for(const client of server.clients)client.terminate()
    await new Promise(resolve=>server.close(resolve))
  }
})
