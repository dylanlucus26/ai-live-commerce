import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {validateRtmpCapture} from './validate-real-rtmp.mjs'
import {decodeNumberedMotion} from './validate-numbered-motion.mjs'
assert.equal(process.env.GITHUB_ACTIONS,'true')
assert.equal(process.platform,'darwin')
const out='/tmp/ai-live-prior-queue-audit'
mkdirSync(out,{recursive:true})
const report={purpose:'Cloud decode of existing failed queue recordings, not a rerun or acceptance pass',run:40837217931,
  artifact:12881616290,artifactZipSHA256:'700a08623ed8b1b9574e1cd31769a31802e88f3266bbbbf926fccb4e5de3df72',entries:[]}
const errors=[]
for(const label of ['owned-gpu-latest-first','owned-gpu-ordered-queue']){
  const file=join('prior-failed-queue','recordings','render-'+label+'.flv')
  const entry={label,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}
  report.entries.push(entry)
  try{entry.capture=validateRtmpCapture(file,{minDuration:35})}catch(error){entry.captureError=String(error);errors.push(error)}
  try{entry.numbered=decodeNumberedMotion(file)}catch(error){entry.numberedError=String(error);errors.push(error)}
  entry.has900SequentialDistinctFrames=entry.numbered?.frames===900&&entry.numbered.distinctSourceFrames===900&&
    entry.numbered.repeatedFrames===0&&entry.numbered.skippedSourceFrames===0&&entry.numbered.backwards===0
}
report.extractionCompleted=errors.length===0
report.originalRunRemainsFailed=true
writeFileSync(join(out,'prior-failed-queue-capture-audit.json'),JSON.stringify(report,null,2))
console.log('EXISTING FAILED CAPTURE AUDIT:',JSON.stringify(report))
if(errors.length)throw new AggregateError(errors,'Existing failed capture could not be fully decoded')
