#!/usr/bin/env python3
"""Replace only the disposable runner's plugin executable; preserve app permissions."""
import os,platform,pathlib,json,hashlib,subprocess,shutil,plistlib
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin"
root=pathlib.Path("cloud-obs-source/build_macos").resolve()
out=pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"]).resolve()
built=list(root.glob("**/Release/obs-browser.plugin/Contents/MacOS/obs-browser"))
installed=list(pathlib.Path("/Applications/OBS.app/Contents/PlugIns").glob("obs-browser.plugin/Contents/MacOS/obs-browser"))
assert len(built)==len(installed)==1,([str(x) for x in built],[str(x) for x in installed])
original=installed[0]
hashof=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
record={"purpose":"unshipped disposable cloud OBS plugin copy experiment","originalModule":str(original),"originalSHA256":hashof(original),"builtModule":str(built[0]),"builtSHA256":hashof(built[0]),"mainExecutableSHA256":hashof(pathlib.Path("/Applications/OBS.app/Contents/MacOS/OBS"))}
before=subprocess.run(["codesign","-d","--entitlements","-","--xml","/Applications/OBS.app"],capture_output=True,check=True).stdout
(out/"original-app-entitlements.plist").write_bytes(before)
shutil.copy2(built[0],original)
subprocess.run(["codesign","--force","--sign","-","--preserve-metadata=identifier,entitlements,flags",str(original.parents[2])],check=True)
subprocess.run(["codesign","--force","--sign","-","--preserve-metadata=identifier,entitlements,flags","/Applications/OBS.app"],check=True)
subprocess.run(["codesign","--verify","--deep","--strict","/Applications/OBS.app"],check=True)
after=subprocess.run(["codesign","-d","--entitlements","-","--xml","/Applications/OBS.app"],capture_output=True,check=True).stdout
(out/"experimental-app-entitlements.plist").write_bytes(after)
assert plistlib.loads(before)==plistlib.loads(after),"Existing app permission entitlements changed"
record["installedExperimentalSHA256"]=hashof(original)
record["experimentalMainExecutableSHA256"]=hashof(pathlib.Path("/Applications/OBS.app/Contents/MacOS/OBS"))
record["appEntitlementsUnchanged"]=True
record["moduleSigning"]="ad-hoc experiment, not official installed bundle"
record["otool"]=subprocess.check_output(["otool","-L",str(original)],text=True)
(out/"module-provenance.json").write_text(json.dumps(record,indent=2))
print(json.dumps(record,indent=2))
