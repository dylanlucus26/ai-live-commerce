import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync} from 'node:fs'
import {join} from 'node:path'
import {spawn,spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import WebSocket from 'ws'
import {obsAuthentication} from '../electron/main/services/ObsService.ts'
assert.equal(process.env.GITHUB_ACTIONS,'true','Latency diagnostic is cloud only')
assert.equal(process.platform,'darwin')
assert.equal(process.arch,'arm64')
const dir=process.env.AI_LIVE_OBS_LOG_DIR
assert.ok(dir)
mkdirSync(dir,{recursive:true})
const config={port:4455,password:process.env.AI_LIVE_OBS_TEST_PASSWORD}
assert.ok(config.password)
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
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

const helper=join(dir,'launch-obs-own-policy')
const report={purpose:'same-cloud-VM-three-owned-OBS-startups-blank-latency-only-not-product-acceptance',
  policyReadbackScope:'Own process immediately before exec; external post-exec task-policy readback unavailable',
  phases:[],launches:[]}
let child=null,fd=null
async function stop(){
  if(child&&child.exitCode===null&&child.signalCode===null){
    const exiting=once(child,'exit')
    child.kill('SIGCONT');child.kill('SIGTERM')
    await Promise.race([exiting,sleep(10000)])
    if(child.exitCode===null&&child.signalCode===null){
      child.kill('SIGKILL');await exiting
      throw Error('Owned cloud OBS required forced termination')
    }
  }
  child=null
  if(fd!==null){closeSync(fd);fd=null}
}
async function measure(label){
  const start=Date.now(),samples=[{at:Date.now(),...await obs('GetStats')}]
  while(Date.now()-start<45000){
    await sleep(Math.min(5000,45000-(Date.now()-start)))
    samples.push({at:Date.now(),...await obs('GetStats')})
  }
  for(const sample of samples)for(const key of ['renderSkippedFrames','renderTotalFrames','activeFps','averageFrameRenderTime','cpuUsage'])
    assert.ok(Number.isFinite(sample[key]),'Actual numeric OBS '+key+' missing')
  const first=samples[0],last=samples.at(-1)
  const lagged=last.renderSkippedFrames-first.renderSkippedFrames,total=last.renderTotalFrames-first.renderTotalFrames
  assert.ok(total>0&&lagged>=0)
  const mean=key=>samples.reduce((sum,s)=>sum+s[key],0)/samples.length
  const phase={label,elapsedMs:Date.now()-start,lagged,total,lagPercent:100*lagged/total,
    fpsMean:mean('activeFps'),renderMsMean:mean('averageFrameRenderTime'),cpuMean:mean('cpuUsage'),samples}
  report.phases.push(phase)
  writeFileSync(join(dir,'latency-comparison.json'),JSON.stringify(report,null,2))
  console.log('LATENCY STAGE:',JSON.stringify({...phase,samples:undefined}))
}

try{
  const compile=spawnSync('/usr/bin/clang',['-O2','scripts/inspect-obs-task-policy.c','-o',helper],
    {timeout:120000,maxBuffer:4*1024*1024})
  writeFileSync(join(dir,'latency-helper-compile.log'),String(compile.stdout??'')+String(compile.stderr??''))
  assert.ok(!compile.error&&compile.status===0,'Cloud self-policy launcher did not compile')
  for(const [label,mode] of [['original-first','original'],['latency-tier0','latency0'],['original-restored-new-process','original']]){
    const file=join(dir,'obs-'+label+'.log')
    fd=openSync(file,'w')
    child=spawn(helper,[mode],{stdio:['ignore',fd,fd]})
    let ready=false
    for(let attempt=0;attempt<45;attempt++){
      assert.ok(child.exitCode===null&&child.signalCode===null,'Owned official OBS exited before readiness')
      const probe=spawnSync('/usr/bin/nc',['-z','127.0.0.1','4455'],{timeout:1000})
      if(probe.status===0){ready=true;break}
      await sleep(1000)
    }
    assert.ok(ready,'Owned official OBS did not expose WebSocket')
    const log=readFileSync(file,'utf8')
    assert.ok(log.includes('Initializing Metal...'),'Actual Metal renderer is required')
    const policyLine=log.split('\n').find(x=>x.startsWith('POLICY BEFORE EXEC: '))
    assert.ok(policyLine,'Own pre-exec policy observation missing')
    const policy=JSON.parse(policyLine.slice('POLICY BEFORE EXEC: '.length))
    assert.equal(policy.pid,child.pid,'OBS exec did not retain its owned launch PID')
    assert.equal(policy.mode,mode)
    assert.equal(policy.afterThroughput,policy.beforeThroughput)
    assert.equal(policy.afterLatency,mode==='latency0'?((0xff<<16)|1):policy.beforeLatency)
    const video=await obs('GetVideoSettings')
    assert.equal(video.baseWidth,1280);assert.equal(video.baseHeight,720)
    assert.equal(video.outputWidth,1280);assert.equal(video.outputHeight,720)
    assert.equal(video.fpsNumerator/video.fpsDenominator,30)
    const stream=await obs('GetStreamStatus');assert.equal(stream.outputActive,false)
    const scenes=await obs('GetSceneList')
    if(report.launches.length)assert.deepEqual(video,report.launches[0].video)
    report.launches.push({label,pid:child.pid,policy,video,scenes,
      graphics:log.split('\n').filter(x=>/Initializing Metal|- Name\s*:|- Unified Memory\s*:/.test(x))})
    console.log('ACTUAL OWNED OBS LAUNCH:',JSON.stringify(report.launches.at(-1)))
    await measure(label)
    assert.deepEqual(await obs('GetSceneList'),scenes,'Latency probe changed scene state')
    await stop()
  }
  assert.equal(report.launches[2].policy.afterLatency,report.launches[0].policy.afterLatency,
    'Fresh original-policy launch differs from the first baseline')
  report.completed=true
}catch(error){
  report.completed=false;report.error=String(error);process.exitCode=1
  console.error('LATENCY DIAGNOSTIC FAILED:',error)
}finally{
  try{await stop()}catch(error){report.cleanupError=String(error);process.exitCode=1;report.completed=false}
  writeFileSync(join(dir,'latency-comparison.json'),JSON.stringify(report,null,2))
}
