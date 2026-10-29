import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import WebSocket from 'ws'
import {obsAuthentication} from '../electron/main/services/ObsService.ts'
assert.equal(process.env.GITHUB_ACTIONS,'true','Latency diagnostic is cloud only')
assert.equal(process.platform,'darwin')
assert.equal(process.arch,'arm64')
const dir=process.env.AI_LIVE_OBS_LOG_DIR,pid=process.env.AI_LIVE_OBS_TEST_PID
assert.ok(dir&&/^[1-9][0-9]*$/.test(pid??''))
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

const helper=join(dir,'inspect-obs-task-policy')
const report={purpose:'same-owned-OBS-blank-scene-latency-ABA-only-not-product-acceptance',phases:[]}
let before=null,changed=false
function policy(latency,throughput){
  const args=latency===undefined?[pid]:[pid,String(latency),String(throughput)]
  const result=spawnSync(helper,args,{timeout:10000,maxBuffer:1024*1024})
  assert.ok(!result.error&&result.status===0,'Actual owned OBS QoS operation failed: '+String(result.error??result.stderr))
  const state=JSON.parse(String(result.stdout))
  assert.equal(state.pid,Number(pid))
  report.policyReads??=[];report.policyReads.push({at:Date.now(),...state})
  console.log('ACTUAL OBS TASK POLICY:',JSON.stringify(report.policyReads.at(-1)))
  return state
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
  assert.ok(!compile.error&&compile.status===0,'Cloud task-policy inspector did not compile')
  const log=readFileSync(join(dir,'obs-native.log'),'utf8')
  assert.ok(log.includes('Initializing Metal...'),'Actual Metal renderer is required')
  report.graphics=log.split('\n').filter(x=>/Initializing Metal|- Name\s*:|- Unified Memory\s*:/.test(x))
  report.video=await obs('GetVideoSettings')
  assert.equal(report.video.baseWidth,1280);assert.equal(report.video.baseHeight,720)
  assert.equal(report.video.outputWidth,1280);assert.equal(report.video.outputHeight,720)
  assert.equal(report.video.fpsNumerator/report.video.fpsDenominator,30)
  const stream=await obs('GetStreamStatus');assert.equal(stream.outputActive,false)
  report.sceneBefore=await obs('GetSceneList')
  before=policy()
  await measure('blank-original-policy')
  // Apple's published LATENCY_QOS_TIER_0. Only latency is overridden; preserve
  // throughput, process role and every OBS source/output setting.
  changed=true
  policy((0xff<<16)|1,before.override.throughput)
  await measure('blank-latency-tier-0')
  const restored=policy(before.override.latency,before.override.throughput)
  assert.deepEqual(restored.override,before.override,'Original task policy did not actually restore')
  changed=false
  await measure('blank-restored-policy')
  report.sceneAfter=await obs('GetSceneList')
  assert.deepEqual(report.sceneAfter,report.sceneBefore,'Task-policy probe changed OBS scene state')
  report.completed=true
}catch(error){
  report.completed=false;report.error=String(error);process.exitCode=1
  console.error('LATENCY DIAGNOSTIC FAILED:',error)
}finally{
  if(changed&&before){
    try{const restored=policy(before.override.latency,before.override.throughput);assert.deepEqual(restored.override,before.override)}
    catch(error){report.restoreError=String(error);process.exitCode=1;report.completed=false}
  }
  writeFileSync(join(dir,'latency-comparison.json'),JSON.stringify(report,null,2))
}
