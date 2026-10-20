import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// GitHub Actions runner only. Creates a dedicated CI-only OBS scene collection and
// encoder profile, so OBS never waits for its first-launch configuration wizard.
if (!process.env.CI && !process.env.GITHUB_ACTIONS) {
  throw new Error('Refusing to write OBS profile outside of an isolated CI runner')
}
const home = homedir()
const root = process.platform === 'darwin'
  ? join(home, 'Library', 'Application Support', 'obs-studio')
  : process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(home,'AppData','Roaming'),'obs-studio')
    : join(home,'.config','obs-studio')
const scenes = join(root,'basic','scenes')
const profileDir = join(root,'basic','profiles','AI-Live-CI')
mkdirSync(scenes,{recursive:true})
mkdirSync(profileDir,{recursive:true})

const collection = {
  name:'AI-Live-CI',
  current_scene:'Base',
  current_program_scene:'Base',
  scene_order:[{name:'Base'}],
  sources:[{
    name:'Base',
    id:'scene',
    versioned_id:'scene',
    settings:{id_counter:0,custom_size:false,items:[]},
    mixers:0,sync:0,flags:0,volume:1,balance:0.5,
    enabled:true,muted:false,hotkeys:{'OBSBasic.SelectScene':[]},
  }],
  groups:[],transitions:[],quick_transitions:[],
  current_transition:'Fade',transition_duration:300,
  preview_locked:false,scaling_enabled:false,
}
writeFileSync(join(scenes,'AI-Live-CI.json'),JSON.stringify(collection,null,2))
writeFileSync(join(profileDir,'basic.ini'),[
  '[General]','Name=AI-Live-CI',
  '[Output]','Mode=Simple',
  '[SimpleOutput]','VBitrate=1200','ABitrate=128','StreamEncoder=x264',
  '[Video]','BaseCX=1280','BaseCY=720','OutputCX=1280','OutputCY=720','FPSCommon=30',
  '[Audio]','SampleRate=48000','ChannelSetup=Stereo',
].join('\n')+'\n')
writeFileSync(join(root,'global.ini'),[
  '[General]','FirstRun=false','EnableAutoUpdates=false','LastVersion=5000000',
  '[Basic]','SceneCollection=AI-Live-CI','SceneCollectionFile=AI-Live-CI',
  'Profile=AI-Live-CI','ProfileDir=AI-Live-CI',
  '[BasicWindow]','WarnBeforeStartingStream=false',
].join('\n')+'\n')
console.log('Prepared CI-only OBS profile and scene collection: AI-Live-CI')
