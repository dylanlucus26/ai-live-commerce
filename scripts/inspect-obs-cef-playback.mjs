import assert from 'node:assert/strict'
import {once} from 'node:events'
import {spawnSync} from 'node:child_process'
import WebSocket from 'ws'

async function connectCefDiagnostic(url){
  const parsed=new URL(url)
  assert.equal(parsed.protocol,'ws:')
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))
  assert.equal(parsed.port,'9222')
  const socket=new WebSocket(url,{handshakeTimeout:8000})
  const pending=new Map();let serial=0
  socket.on('message',raw=>{
    const packet=JSON.parse(String(raw)),entry=pending.get(packet.id)
    if(!entry)return
    pending.delete(packet.id);clearTimeout(entry.timer)
    if(packet.error)entry.reject(Error(entry.method+': '+JSON.stringify(packet.error)))
    else entry.resolve(packet.result??{})
  })
  const failAll=error=>{
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error)}
    pending.clear()
  }
  socket.on('error',failAll)
  socket.on('close',()=>failAll(Error('Owned CEF diagnostic socket closed')))
  await once(socket,'open')
  return {
    request(method,params={}){
      assert.ok(['SystemInfo.getInfo','Runtime.evaluate'].includes(method),'Read-only diagnostic method not allowed')
      const id=++serial
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' diagnostic timeout'))},8000)
        pending.set(id,{method,resolve,reject,timer})
        socket.send(JSON.stringify({id,method,params}))
      })
    },
    close(){socket.close()},
  }
}
export async function openCefPlaybackObserver(expectedPageUrl){
  assert.equal(process.env.GITHUB_ACTIONS,'true','Existing CEF inspection is isolated-cloud only')
  assert.equal(process.platform,'darwin')
  const listener=spawnSync('lsof',['-nP','-iTCP:9222','-sTCP:LISTEN'],
    {timeout:10000,maxBuffer:1024*1024})
  assert.ok(!listener.error&&listener.status===0,'CEF diagnostic listener missing')
  const listenerLines=String(listener.stdout).split('\n').slice(1).filter(Boolean)
  assert.ok(listenerLines.length>0)
  for(const line of listenerLines){
    assert.match(line,/\s(?:127\.0\.0\.1|\[::1\]):9222\s+\(LISTEN\)/u,'CEF observer must remain loopback only')
    assert.equal(line.trim().split(/\s+/)[1],process.env.AI_LIVE_OBS_TEST_PID,
      'CEF diagnostic port does not belong to this job owned OBS')
  }
  const json=async path=>{
    const result=await fetch('http://127.0.0.1:9222'+path,{signal:AbortSignal.timeout(8000)})
    assert.ok(result.ok,'CEF diagnostic HTTP '+result.status)
    return result.json()
  }
  const version=await json('/json/version')
  const targets=await json('/json/list')
  assert.ok(Array.isArray(targets))
  const matching=targets.filter(target=>target.url===expectedPageUrl)
  assert.equal(matching.length,1,'Cannot uniquely identify this product owned Browser Source target')
  let root=null,page=null
  const metadata={browser:version.Browser,protocol:version['Protocol-Version'],
    loopbackListener:String(listener.stdout),inspection:'read-only CDP; no focus, FPS, DOM or browser-default overrides'}
  try{
    root=await connectCefDiagnostic(version.webSocketDebuggerUrl)
    try{
      const {gpu,modelName,modelVersion}=await root.request('SystemInfo.getInfo')
      assert.ok(gpu&&Array.isArray(gpu.devices),'CEF did not return real GPU information')
      metadata.systemInfo={gpu,modelName,modelVersion}
    }catch(error){metadata.gpuError=String(error)}
    page=await connectCefDiagnostic(matching[0].webSocketDebuggerUrl)
    return {
      metadata,
      async applyCanvasVariant(){
        assert.equal(process.env.AI_LIVE_OBS_CEF_CANVAS_VARIANT,'true',
          'Canvas DOM mutation requires this explicit isolated-cloud experiment')
        metadata.inspection='explicit cloud test-only canvas DOM variant; no focus or output FPS override'
        const result=await page.request('Runtime.evaluate',{returnByValue:true,awaitPromise:true,expression:
          'new Promise((resolve,reject)=>{const v=document.getElementById("moving");'+
          'if(!v||typeof v.requestVideoFrameCallback!=="function")throw Error("Real video frame callback unavailable");'+
          'if(window.__ciCanvasDiagnostic)throw Error("Canvas variant already active");'+
          'const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;'+
          'if(c.width!==1280||c.height!==720)throw Error("Actual decoded video dimensions differ");'+
          'Object.assign(c.style,{position:"absolute",inset:"0",width:"100%",height:"100%",objectFit:"contain",pointerEvents:"none"});'+
          'document.body.appendChild(c);const ctx=c.getContext("2d",{alpha:false});'+
          'if(!ctx)throw Error("Actual 2D canvas unavailable");'+
          'const state=window.__ciCanvasDiagnostic={frames:0,lastMediaTime:0,lastDrawNow:0,error:null};'+
          'const deadline=setTimeout(()=>reject(Error("No actual first canvas video frame")),5000);'+
          'function draw(now,meta){try{ctx.drawImage(v,0,0,c.width,c.height);state.frames++;'+
          'state.lastMediaTime=meta.mediaTime;state.lastDrawNow=now;'+
          'if(state.frames===1){clearTimeout(deadline);resolve({frames:state.frames,width:c.width,height:c.height,mediaTime:meta.mediaTime})}'+
          'v.requestVideoFrameCallback(draw)}catch(e){state.error=String(e);clearTimeout(deadline);reject(e)}}'+
          'v.requestVideoFrameCallback(draw)})'})
        assert.ok(!result.exceptionDetails,'Actual canvas variant failed: '+JSON.stringify(result.exceptionDetails))
        const value=result.result?.value
        assert.ok(value&&value.frames===1,'No real first decoded frame was drawn to the experimental canvas')
        return value
      },
      async sample(){
        const requestedAt=Date.now()
        const result=await page.request('Runtime.evaluate',{returnByValue:true,expression:
          '(()=>{const v=document.getElementById("moving");if(!v)throw Error("Product video element missing");'+
          'const q=v.getVideoPlaybackQuality();return {performanceNow:performance.now(),currentTime:v.currentTime,'+
          'duration:v.duration,readyState:v.readyState,paused:v.paused,ended:v.ended,muted:v.muted,'+
          'playbackRate:v.playbackRate,defaultPlaybackRate:v.defaultPlaybackRate,videoWidth:v.videoWidth,videoHeight:v.videoHeight,'+
          'totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,'+
          'visibility:document.visibilityState,documentHasFocus:document.hasFocus(),'+
          'canvasDiagnostic:window.__ciCanvasDiagnostic??null,'+
          'buffered:Array.from({length:v.buffered.length},(_,i)=>[v.buffered.start(i),v.buffered.end(i)])};})()'})
        assert.ok(!result.exceptionDetails,'CEF video observation threw: '+JSON.stringify(result.exceptionDetails))
        const value=result.result?.value
        assert.ok(value,'CEF video observation did not return actual values')
        for(const key of ['performanceNow','currentTime','duration','totalVideoFrames','droppedVideoFrames'])
          assert.ok(Number.isFinite(value[key]),'CEF video observation missing numeric '+key)
        assert.equal(value.playbackRate,1,'Product video playback speed changed')
        assert.equal(value.videoWidth,1280);assert.equal(value.videoHeight,720)
        return {requestedAt,receivedAt:Date.now(),...value}
      },
      close(){page?.close();root?.close()},
    }
  }catch(error){page?.close();root?.close();throw error}
}
