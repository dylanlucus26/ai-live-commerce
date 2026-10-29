import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
assert.equal(process.env.GITHUB_ACTIONS,'true','Prior-media decoding is isolated-cloud only')
const root=process.argv[2],out=process.argv[3]
assert.ok(root&&out)
mkdirSync(out,{recursive:true})
const file=join(root,'recordings','render-cef-presentation.flv')
assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),
  '14bcdf2e22bb48a80621d46dcd659abdcf23c97759840a21da4ac56174b6d577',
  'Audit must use the exact official OBS presentation-trace capture')
const report=JSON.parse(readFileSync(file+'.numbered.json','utf8'))
const indices=report.indices,events=[]
function run(exe,args){
  const r=spawnSync(exe,args,{timeout:120000,maxBuffer:64*1024*1024})
  assert.ok(!r.error&&r.status===0,String(r.error??r.stderr))
  return r.stdout
}
for(let index=1;index<indices.length;index++){
  if(indices[index]>=indices[index-1])continue
  const begin=Math.max(0,index-4),end=Math.min(indices.length-1,index+4)
  run('ffmpeg',['-nostdin','-v','error','-y','-ss','5','-i',file,
    '-vf',"select='between(n,"+begin+','+end+")'",'-fps_mode','passthrough',
    '-frames:v',String(end-begin+1),join(out,'event-'+index+'-frame-%02d.png')])
  events.push({atDecodedFrame:index,from:indices[index-1],to:indices[index],
    nearby:indices.slice(begin,end+1),decodedFrameBegin:begin,decodedFrameEnd:end})
}
assert.ok(events.length>0,'Known previous backwards signal was not found')
const timestamps=JSON.parse(run('ffprobe',['-v','error','-select_streams','v:0',
  '-show_frames','-show_entries','frame=best_effort_timestamp_time,pkt_dts_time,pict_type',
  '-of','json',file]))
const pts=timestamps.frames.map(frame=>Number(frame.best_effort_timestamp_time))
assert.ok(pts.length>900&&pts.every(Number.isFinite),'Actual full decoded timestamps missing')
assert.ok(pts.slice(1).every((value,i)=>value>pts[i]),'Decoded frame PTS is not strictly increasing')
writeFileSync(join(out,'actual-decoded-timestamps.json'),JSON.stringify(timestamps,null,2))
writeFileSync(join(out,'presentation-order-audit.json'),JSON.stringify({
  purpose:'inspect-existing-failed-media-only-not-a-new-acceptance',
  priorRun:40826265620,priorJob:123289892409,priorArtifact:12876882283,
  strictlyIncreasingDecodedPts:true,decodedTimestampCount:pts.length,
  sha256:report.sha256,events,priorMetrics:{...report,indices:undefined},
},null,2))
console.log('Existing failed order evidence extracted:',JSON.stringify(events))
