import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'

assert.equal(process.env.GITHUB_ACTIONS,'true','Cloud desktop diagnosis only')
assert.equal(process.platform,'darwin','Cloud Mac required')
const logDir=process.env.AI_LIVE_OBS_LOG_DIR
const pid=Number(process.env.AI_LIVE_OBS_TEST_PID)
assert.ok(logDir&&Number.isInteger(pid)&&pid>0,'Owned cloud OBS environment missing')
const tool=join(logDir,'inspect-obs-foreground')
const compile=spawnSync('/usr/bin/swiftc',['-O',
  join(process.cwd(),'scripts/inspect-obs-foreground.swift'),'-o',tool],
  {timeout:120000,maxBuffer:4*1024*1024})
writeFileSync(join(logDir,'desktop-helper-compile.log'),String(compile.stdout??'')+String(compile.stderr??''))
assert.ok(!compile.error&&compile.status===0,'Cloud desktop inspector did not compile')
const inspect=action=>{
  const result=spawnSync(tool,[String(pid),action],{timeout:12000,maxBuffer:1024*1024})
  writeFileSync(join(logDir,'desktop-'+action+'.json'),String(result.stdout??''))
  writeFileSync(join(logDir,'desktop-'+action+'.log'),String(result.stderr??''))
  assert.ok(!result.error,'Cloud foreground inspector failed: '+String(result.error))
  const state=JSON.parse(String(result.stdout))
  console.log('ACTUAL CLOUD DESKTOP:',JSON.stringify({action,exitCode:result.status,...state}))
  return {action,exitCode:result.status,state}
}
const screenshot=name=>{
  const path=join(logDir,name+'.png')
  const result=spawnSync('/usr/sbin/screencapture',['-x',path],{timeout:20000,maxBuffer:1024*1024})
  assert.ok(!result.error&&result.status===0&&statSync(path).size>0,
    'Could not capture actual cloud desktop: '+String(result.error??result.stderr))
  console.log('SAVED actual cloud desktop:',path)
  return {path,bytes:statSync(path).size}
}
const report={purpose:'desktop-evidence-only-not-product-acceptance',pid}
report.before=inspect('status')
report.beforeScreenshot=screenshot('cloud-desktop-before')
report.activation=inspect('activate')
report.afterScreenshot=screenshot('cloud-desktop-after')
report.actualGraphicsLines=readFileSync(join(logDir,'obs-native.log'),'utf8').split('\n')
  .filter(l=>/Initializing (Metal|OpenGL)|- Name\s*:|Loading up OpenGL on adapter/u.test(l))
report.evidenceCaptured=true
writeFileSync(join(logDir,'cloud-desktop-diagnostic.json'),JSON.stringify(report,null,2))
if(!report.activation.state.targetIsFrontmost){
  console.error('Cloud foreground remains blocked; screenshots and actual PID state retained')
  process.exitCode=1
}else console.log('PASS cloud desktop activation observed; this is not a performance acceptance pass')
