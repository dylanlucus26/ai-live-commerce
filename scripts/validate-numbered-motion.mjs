import assert from 'node:assert/strict'
import {readFileSync,writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'

const fps=30,bits=12,cell=64,cropWidth=bits*cell,decodedWidth=192,decodedHeight=16
function run(exe,args,limit=120000){
  assert.equal(process.env.GITHUB_ACTIONS,'true','Numbered motion generation/decoding is isolated-cloud only')
  const r=spawnSync(exe,args,{timeout:limit,maxBuffer:128*1024*1024})
  assert.ok(!r.error&&r.status===0,exe+' failed: '+String(r.error??r.stderr).slice(-4000))
  return r.stdout
}
export function createNumberedMotionFixture(filename){
  const filters=[
    'testsrc2=size=1280x720:rate=30:duration=90',
    "drawbox=x=640:y=400:w=640:h=300:color=red:t=fill:enable='lt(mod(n,60),30)'",
    "drawbox=x=640:y=400:w=640:h=300:color=blue:t=fill:enable='gte(mod(n,60),30)'",
    'drawbox=x=0:y=0:w=1280:h=64:color=black:t=fill',
  ]
  for(let bit=0;bit<bits;bit++)
    filters.push("drawbox=x="+bit*cell+":y=0:w=64:h=64:color=white:t=fill:enable='bitand(n,"+(2**bit)+")'")
  run('ffmpeg',['-nostdin','-v','error','-y','-f','lavfi','-i',filters.join(','),
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=90',
    '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',filename])
  return decodeNumberedMotion(filename,{reference:true})
}
export function decodeNumberedMotion(filename,{reference=false}={}){
  const probe=JSON.parse(run('ffprobe',['-v','error','-select_streams','v:0',
    '-show_entries','stream=codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration',
    '-of','json',filename]).toString())
  const video=probe.streams[0]
  assert.equal(video.width,1280);assert.equal(video.height,720)
  assert.equal(video.codec_name,'h264')
  const input=reference?['-i',filename]:['-ss','5','-i',filename,'-t','30']
  // No fps conversion/interpolation: inspect actual decoder output and its visible frame number.
  const raw=run('ffmpeg',['-nostdin','-v','error',...input,'-map','0:v:0','-an',
    '-vf','crop='+cropWidth+':64:0:0,scale='+decodedWidth+':'+decodedHeight+':flags=neighbor',
    '-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'])
  const bytesPerFrame=decodedWidth*decodedHeight*3
  assert.equal(raw.length%bytesPerFrame,0,'Incomplete decoded barcode frame')
  const frames=raw.length/bytesPerFrame,indices=[]
  assert.ok(frames>1,'No actual numbered video frames')
  for(let frame=0;frame<frames;frame++){
    let code=0
    for(let bit=0;bit<bits;bit++){
      let sum=0,count=0
      for(let y=7;y<=9;y++)for(let x=bit*16+7;x<=bit*16+9;x++){
        const offset=frame*bytesPerFrame+(y*decodedWidth+x)*3
        sum+=raw[offset]+raw[offset+1]+raw[offset+2];count+=3
      }
      const value=sum/count
      assert.ok(value<=64||value>=192,'Actual barcode bit is not independently readable')
      if(value>=128)code+=2**bit
    }
    indices.push(code)
  }
  let repeatedFrames=0,skippedSourceFrames=0,sequentialTransitions=0,backwards=0,hold=1,maxHold=1
  for(let i=1;i<indices.length;i++){
    const delta=indices[i]-indices[i-1]
    if(delta===0){repeatedFrames++;hold++}
    else{hold=1;if(delta===1)sequentialTransitions++;else if(delta>1)skippedSourceFrames+=delta-1;else backwards++}
    maxHold=Math.max(maxHold,hold)
  }
  const result={purpose:'actual-decoded-numbered-frames-not-encoder-fps-label',reference,
    targetFps:fps,probe,frames,firstIndex:indices[0],lastIndex:indices.at(-1),repeatedFrames,
    skippedSourceFrames,sequentialTransitions,backwards,maxHoldFrames:maxHold,
    repeatedPercent:100*repeatedFrames/Math.max(1,frames-1),
    observedUniqueFps:reference?null:(frames-repeatedFrames)/30,
    distinctSourceFrames:new Set(indices).size,
    observedDistinctSourceFramesPerSecond:reference?null:new Set(indices).size/30,
    sha256:createHash('sha256').update(readFileSync(filename)).digest('hex'),indices}
  writeFileSync(filename+'.numbered.json',JSON.stringify(result,null,2))
  if(reference){
    assert.equal(frames,90*fps,'Reference fixture must contain exactly 90 seconds at 30 FPS')
    assert.ok(Math.abs(Number(probe.format.duration)-90)<0.001,'Reference duration must be 90 seconds')
    const [numerator,denominator]=video.avg_frame_rate.split('/').map(Number)
    assert.equal(numerator/denominator,30,'Reference encoded cadence must be 30 FPS')
    for(let i=0;i<frames;i++)assert.equal(indices[i],i,'Reference encoded frame-number calibration failed')
  }else{
    assert.ok(frames>=5*fps,'Too few actual RTMP samples for ordinal analysis')
    if(backwards){
      const first=indices.findIndex((value,index)=>index>0&&value<indices[index-1])
      const begin=Math.max(0,first-4),end=Math.min(frames-1,first+4)
      run('ffmpeg',['-nostdin','-v','error','-y','-ss','5','-i',filename,
        '-vf',"select='between(n,"+begin+','+end+")'",'-fps_mode','passthrough',
        '-frames:v',String(end-begin+1),filename+'.backwards-%02d.png'])
    }
    assert.equal(backwards,0,'Actual RTMP frame numbers went backwards or became unreadable')
  }
  console.log('NUMBERED MOTION OBSERVATION:',JSON.stringify({...result,indices:undefined}))
  return result
}
