import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import WebSocket from 'ws'
import {obsAuthentication,getObsStreamStatus,getObsSceneInfo} from '../electron/main/services/ObsService.ts'

// This is a diagnostic control for real macOS OBS/RTMP independent of CEF.
// It never counts as passing the product's Browser Source verification.
assert.equal(process.env.GITHUB_ACTIONS,'true','Mac OBS control is CI-only')
assert.equal(process.platform,'darwin','Mac OBS control must run on a real Mac')
const config={port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD??''}
const records=process.env.AI_LIVE_RTMP_RECORD_DIR
assert.ok(config.password&&records,'Missing isolated test OBS/WebSocket or RTMP directory')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function obs(requestType,requestData={}){
  const requestId=randomUUID()
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:'+config.port,{handshakeTimeout:4000})
    let done=false
    const deadline=setTimeout(()=>finish(new Error('OBS request timeout: '+requestType)),12000)
    const finish=(error,value)=>{
      if(done)return
      done=true;clearTimeout(deadline)
      ws.close()
      if(error)reject(error)
      else resolve(value??{})
    }
    ws.on('message',raw=>{
      try{
        const packet=JSON.parse(String(raw)),d=packet.d??{}
        if(packet.op===0){
          const id={rpcVersion:1}
          if(d.authentication)id.authentication=obsAuthentication(config.password,
            d.authentication.challenge,d.authentication.salt)
          ws.send(JSON.stringify({op:1,d:id}))
        }else if(packet.op===2)
          ws.send(JSON.stringify({op:6,d:{requestType,requestId,requestData}}))
        else if(packet.op===7&&d.requestId===requestId){
          if(!d.requestStatus?.result)
            throw Error('OBS '+requestType+' rejected: '+d.requestStatus?.code+' '+d.requestStatus?.comment)
          finish(null,d.responseData)
        }
      }catch(e){finish(e)}
    })
    ws.on('error',e=>finish(e))
    ws.on('close',()=>{if(!done)finish(Error('OBS socket closed'))})
  })
}
function cmd(file,args){
  const result=spawnSync(file,args,{timeout:120000,maxBuffer:28*1024*1024})
  if(result.error||result.status!==0)
    throw Error(file+' command failed: '+String(result.stderr).slice(-1800))
  return result.stdout
}
const temp=mkdtempSync(join(tmpdir(),'ai-mac-obs-core-'))
const media=join(temp,'test-blue-tone.mp4')
const capture=join(records,'actual-obs.flv') // The single CI-owned ffmpeg RTMP receiver
const scene='AI Live Commerce - native-ci-'+randomUUID().slice(0,7)
const input=scene+' - FFmpeg AV'
let ownsScene=false,ownsStream=false,previous=null,originalService=null
try{
  const existing=await getObsStreamStatus(config)
  assert.ok(!existing.active&&!existing.reconnecting,'Refuse to interfere with another OBS stream')
  const old=await getObsSceneInfo(config)
  previous=old.currentScene
  assert.ok(previous,'OBS scene absent')
  originalService=await obs('GetStreamServiceSettings')
  // Create actual H.264 video with embedded AAC audio: no OBS browser or fake socket.
  cmd('ffmpeg',['-loglevel','error','-y',
    '-f','lavfi','-i','color=c=blue:s=640x360:r=30',
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t','11','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','128k','-movflags','+faststart',media])
  await obs('SetStreamServiceSettings',{
    streamServiceType:'rtmp_custom',
    streamServiceSettings:{server:'rtmp://127.0.0.1:1935/live',key:'ci-validation-only',use_auth:false}
  })
  const service=await obs('GetStreamServiceSettings')
  assert.equal(service.streamServiceSettings?.server,'rtmp://127.0.0.1:1935/live')
  await obs('CreateScene',{sceneName:scene})
  ownsScene=true
  await obs('CreateInput',{
    sceneName:scene,inputName:input,inputKind:'ffmpeg_source',
    inputSettings:{is_local_file:true,local_file:media,looping:true,
      restart_on_activate:true,close_when_inactive:false},
    sceneItemEnabled:true
  })
  await obs('SetCurrentProgramScene',{sceneName:scene})
  const active=await obs('GetSourceActive',{sourceName:input})
  console.log('MAC-NATIVE-CONTROL actual media source:',JSON.stringify(active))
  await sleep(1600)
  await obs('StartStream')
  ownsStream=true
  let output=null
  for(let i=0;i<30;i++){
    output=await getObsStreamStatus(config)
    if(output.active&&!output.reconnecting)break
    await sleep(200)
  }
  assert.ok(output?.active&&!output?.reconnecting,'Actual macOS OBS did not start RTMP output')
  await sleep(10000)
  await obs('StopStream')
  ownsStream=false
  for(let i=0;i<40;i++){
    if(!(await getObsStreamStatus(config)).active)break
    await sleep(250)
  }
  assert.equal((await getObsStreamStatus(config)).active,false,'OBS did not stop output')
  assert.ok(existsSync(capture),'Mac OBS never sent any RTMP media to receiver')
  await sleep(1400)
  const info=JSON.parse(cmd('ffprobe',['-v','error','-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height','-of','json',capture]).toString())
  const video=info.streams?.find(x=>x.codec_type==='video')
  const audio=info.streams?.find(x=>x.codec_type==='audio')
  assert.ok(video&&video.width>=320,'Mac native OBS RTMP lacks H.264 video')
  assert.ok(audio,'Mac native OBS RTMP lacks AAC audio')
  assert.ok(Number(info.format?.duration)>=7,'Mac OBS RTMP captured too few seconds')
  const pcm=cmd('ffmpeg',['-loglevel','error','-i',capture,'-map','0:a:0',
    '-ar','8000','-ac','1','-f','s16le','pipe:1'])
  let peak=0
  for(let i=0;i+1<pcm.length;i+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i)))
  assert.ok(peak>300,'Actual macOS OBS RTMP AAC is silent')
  console.log('PASS REAL MAC NATIVE OBS CONTROL A/V (NOT product CEF):',
    JSON.stringify({duration:info.format.duration,video:video.codec_name,
      audio:audio.codec_name,peak}))
}catch(e){
  console.error('MAC NATIVE OBS CONTROL FAILED:',e)
  process.exitCode=1
}finally{
  if(ownsStream){
    try{if((await getObsStreamStatus(config)).active)await obs('StopStream')}catch(e){console.error('OBS stop failure',e)}
  }
  if(ownsScene){
    try{
      if((await getObsSceneInfo(config)).currentScene===scene)
        await obs('SetCurrentProgramScene',{sceneName:previous})
      await obs('RemoveScene',{sceneName:scene})
    }catch(e){console.error('OBS scene cleanup issue',e);process.exitCode=1}
  }
  if(originalService?.streamServiceSettings&&Object.keys(originalService.streamServiceSettings).length>0)
    try{await obs('SetStreamServiceSettings',originalService)}catch(e){console.error('OBS stream settings restore issue',e);process.exitCode=1}
  rmSync(temp,{recursive:true,force:true})
}
