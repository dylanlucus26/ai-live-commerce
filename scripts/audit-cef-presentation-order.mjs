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
function decodeBarcodes(raw){
  const width=192,height=16,bytes=width*height*3
  assert.equal(raw.length%bytes,0)
  const result=[]
  for(let frame=0;frame<raw.length/bytes;frame++){
    let code=0
    for(let bit=0;bit<12;bit++){
      let sum=0,count=0
      for(let y=7;y<=9;y++)for(let x=bit*16+7;x<=bit*16+9;x++){
        const p=frame*bytes+(y*width+x)*3
        sum+=raw[p]+raw[p+1]+raw[p+2];count+=3
      }
      const value=sum/count
      assert.ok(value<=64||value>=192,'Barcode bit not independently readable')
      if(value>=128)code+=2**bit
    }
    result.push(code)
  }
  return result
}
const barcodeFilter='crop=768:64:0:0,scale=192:16:flags=neighbor'
const fullStart=decodeBarcodes(run('ffmpeg',['-nostdin','-v','error','-i',file,
  '-map','0:v:0','-an','-vf','trim=start=5:end=35,setpts=PTS-STARTPTS,'+barcodeFilter,
  '-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1']))
writeFileSync(join(out,'full-start-explicit-trim-indices.json'),JSON.stringify(fullStart))
assert.deepEqual(fullStart,indices,'Independent full-start trim differs from original input-seek ordinal stream')
function pngCode(path){
  const codes=decodeBarcodes(run('ffmpeg',['-nostdin','-v','error','-i',path,
    '-vf',barcodeFilter,'-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1']))
  assert.equal(codes.length,1)
  return codes[0]
}
for(let index=1;index<indices.length;index++){
  if(indices[index]>=indices[index-1])continue
  const begin=Math.max(0,index-4),end=Math.min(indices.length-1,index+4)
  const select="select='between(n,"+begin+','+end+")'"
  run('ffmpeg',['-nostdin','-v','error','-y','-ss','5','-i',file,
    '-vf',select,'-fps_mode','passthrough',
    '-frames:v',String(end-begin+1),join(out,'legacy-seek-'+index+'-frame-%02d.png')])
  run('ffmpeg',['-nostdin','-v','error','-y','-i',file,
    '-vf','trim=start=5,setpts=PTS-STARTPTS,'+select,'-fps_mode','passthrough',
    '-frames:v',String(end-begin+1),join(out,'event-'+index+'-frame-%02d.png')])
  const expected=indices.slice(begin,end+1),legacy=[],actual=[]
  for(let n=1;n<=expected.length;n++){
    const number=String(n).padStart(2,'0')
    legacy.push(pngCode(join(out,'legacy-seek-'+index+'-frame-'+number+'.png')))
    actual.push(pngCode(join(out,'event-'+index+'-frame-'+number+'.png')))
  }
  events.push({atDecodedFrame:index,from:indices[index-1],to:indices[index],
    nearby:expected,decodedFrameBegin:begin,decodedFrameEnd:end,
    legacyExportCodes:legacy,explicitTrimExportCodes:actual,legacyMatches:JSON.stringify(legacy)===JSON.stringify(expected)})
  writeFileSync(join(out,'png-export-alignment.json'),JSON.stringify(events,null,2))
  assert.deepEqual(actual,expected,'Exported PNG pixels do not match actual raw ordinal stream')
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
  independentFullStartOrdinalMatch:true,exportedPngPixelCodesMatch:true,
  sha256:report.sha256,events,priorMetrics:{...report,indices:undefined},
},null,2))
console.log('Existing failed order evidence extracted:',JSON.stringify(events))
