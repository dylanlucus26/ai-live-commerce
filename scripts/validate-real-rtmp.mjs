import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const check=(value,message)=>assert.ok(value,message)
function run(executable,args,maxMs=120000) {
  const result=spawnSync(executable,args,{timeout:maxMs,maxBuffer:128*1024*1024})
  if(result.error||result.status!==0)throw Error(executable+' failed: '+String(result.stderr).slice(-3500))
  return result.stdout
}
export function toneWav(seconds=3.5,rate=24000){
  const samples=Math.floor(seconds*rate),b=Buffer.alloc(44+samples*2)
  b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVE',8)
  b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20)
  b.writeUInt16LE(1,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2,28)
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34)
  b.write('data',36);b.writeUInt32LE(samples*2,40)
  for(let i=0;i<samples;i++){
    const fade=Math.min(1,i/600,(samples-i)/600)
    b.writeInt16LE(Math.round(12000*fade*Math.sin(i*2*Math.PI*440/rate)),44+2*i)
  }
  return b.toString('base64')
}
export function validateRtmpCapture(filename, {minDuration=7, requireChange=true} = {}){
  const info=JSON.parse(run('ffprobe',['-v','error','-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height','-of','json',filename]).toString())
  const v=info.streams?.find(x=>x.codec_type==='video')
  const a=info.streams?.find(x=>x.codec_type==='audio')
  check(v,'Actual RTMP recording has no video track')
  check(a,'Actual RTMP recording has no audio track')
  check(v.width>=320&&v.height>=240,'Actual OBS video dimensions invalid')
  check(Number(info.format?.duration)>=minDuration,'RTMP recording duration shorter than '+minDuration+' seconds')

  const duration=Number(info.format.duration)
  const offsets=duration>=120
    ? [...new Set([0,Math.floor(duration/120)*60,Math.floor((duration-20)/60)*60])]
    : [0]
  const clips=offsets.map(offset=>run('ffmpeg',['-loglevel','error','-ss',String(offset),
    '-i',filename,'-t','20','-map','0:a:0','-ar','8000','-ac','1','-f','s16le','pipe:1']))
  const pcm=Buffer.concat(clips)
  let sumSq=0,peak=0
  for(let i=0;i+1<pcm.length;i+=2){
    const sample=pcm.readInt16LE(i)
    sumSq+=sample*sample
    peak=Math.max(peak,Math.abs(sample))
  }
  const rms=Math.sqrt(sumSq/Math.max(1,pcm.length/2))
  check(peak>250&&rms>45,'Actual RTMP AUDIO IS SILENT: peak='+peak+' rms='+rms)

  // Nonzero energy alone could be unrelated desktop/microphone noise. The
  // injected Browser Source verification WAV is a 440 Hz tone; confirm that
  // frequency is present in the actual OBS -> RTMP -> AAC decoded recording.
  const spectralPeak = hz => {
    const rate = 8000
    const windowSize = rate // 1 second, integer bin alignment at 440 Hz
    const frames = Math.floor(pcm.length / (windowSize*2))
    let largest = 0
    for (let frame=0;frame<frames;frame++) {
      let real=0,imag=0
      const start=frame*windowSize
      for (let i=0;i<windowSize;i++) {
        const v=pcm.readInt16LE((start+i)*2)
        const radians=2*Math.PI*hz*i/rate
        real+=v*Math.cos(radians)
        imag+=v*Math.sin(radians)
      }
      largest=Math.max(largest,2*Math.hypot(real,imag)/windowSize)
    }
    return largest
  }
  const tone440=spectralPeak(440)
  const other620=spectralPeak(620)
  check(tone440>Math.max(200,rms*0.3) && tone440>other620*3,
    'RTMP audio lacks injected 440Hz OBS Browser Source tone: '+
    JSON.stringify({tone440,other620,rms}))
  console.log('PASS injected 440Hz Browser Source tone detected in recorded RTMP AAC:',
    JSON.stringify({tone440:Math.round(tone440),other620:Math.round(other620)}))

  for(let c=0;c<clips.length;c++){
    const clip=clips[c]
    let found=false
    for(let off=0;off+16000<=clip.length;off+=16000){
      let re=0,im=0
      for(let n=0;n<8000;n++){
        const value=clip.readInt16LE(off+n*2),angle=2*Math.PI*440*n/8000
        re+=value*Math.cos(angle);im+=value*Math.sin(angle)
      }
      if(2*Math.hypot(re,im)/8000>250){found=true;break}
    }
    check(found,'RTMP audio checkpoint lacks actual 440Hz at second '+offsets[c])
  }
  console.log('PASS actual RTMP audio checkpoints:',JSON.stringify(offsets))

  const rgb=run('ffmpeg',['-loglevel','error','-i',filename,'-map','0:v:0',
    '-vf','fps=1,scale=32:32','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],600000)
  const frames=Math.floor(rgb.length/(32*32*3))
  check(frames>=5,'Actual RTMP recording contains too few decoded video frames: '+frames)
  const palette=new Set(), minuteChecks=new Map()
  let visible=0
  for(let f=0;f<frames;f++){
    let red=0,green=0,blue=0
    for(let i=f*3072;i<(f+1)*3072;i+=3){
      red+=rgb[i];green+=rgb[i+1];blue+=rgb[i+2]
    }
    const color=[red/1024,green/1024,blue/1024]
    if(Math.max(...color)>35)visible++
    const key=color.map(n=>Math.floor(n/18)).join('-')
    palette.add(key)
    const minute=Math.floor(f/60)
    const entry=minuteChecks.get(minute)??{frames:0,visible:0,palette:new Set()}
    entry.frames++
    if(Math.max(...color)>35)entry.visible++
    entry.palette.add(key)
    minuteChecks.set(minute,entry)
  }
  check(visible>=3,'RTMP video is black or has missing visual content')
  if(requireChange)check(palette.size>=2,'RTMP video does not show image-to-video change')
  if(duration>=120){
    for(const [minute,entry] of minuteChecks){
      if(entry.frames<45)continue
      check(entry.visible>=3,'RTMP minute '+minute+' is black')
      if(requireChange)check(entry.palette.size>=2,'RTMP minute '+minute+' lacks product changes')
    }
    console.log('PASS actual per-minute RTMP visual checkpoints:',minuteChecks.size)
  }
  const result={
    duration:info.format.duration,videoCodec:v.codec_name,audioCodec:a.codec_name,
    audioPeak:peak,audioRms:rms.toFixed(1),decodedFrames:frames,colors:palette.size,audioCheckpoints:offsets
  }
  console.log('PASS real RTMP capture:',JSON.stringify(result))
  return result
}

