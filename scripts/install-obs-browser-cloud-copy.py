#!/usr/bin/env python3
"""Install the separately source-built cloud experiment, using upstream build signing."""
import os,platform,pathlib,json,hashlib,subprocess,shutil,plistlib,tempfile
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin"
assert platform.machine()=="arm64"
root=pathlib.Path("cloud-obs-source").resolve()
out=pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"]).resolve()
built=root/"build_macos/frontend/Release/OBS.app"
module=built/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser"
assert built.is_dir() and module.is_file(),"Upstream full build did not produce its actual app and plugin"
hashof=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def entitlements(app):
    return subprocess.run(["codesign","-d","--entitlements","-","--xml",str(app)],capture_output=True,check=True).stdout
subprocess.run(["codesign","--verify","--deep","--strict",str(built)],check=True)
declared=plistlib.loads((root/"frontend/cmake/macos/entitlements.plist").read_bytes())
before=entitlements(built)
(out/"built-source-app-entitlements.plist").write_bytes(before)
assert plistlib.loads(before)==declared,"Independent app entitlement output differs from its actual public upstream source"
destination=pathlib.Path("/Applications/OBS.app")
assert destination.is_dir() and not destination.is_symlink()
original_hash=hashof(destination/"Contents/MacOS/OBS")
backup=pathlib.Path(tempfile.mkdtemp(prefix="ai-live-cloud-official-backup-"))/"OBS.app"
shutil.move(str(destination),str(backup))
subprocess.run(["/usr/bin/ditto",str(built),str(destination)],check=True)
subprocess.run(["codesign","--verify","--deep","--strict",str(destination)],check=True)
after=entitlements(destination)
(out/"installed-source-app-entitlements.plist").write_bytes(after)
assert plistlib.loads(after)==declared
installed=destination/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser"
assert hashof(installed)==hashof(module)
record={"purpose":"UNSHIPPED full independently source-built OBS cloud experiment, not an official installer",
 "obsCommit":"ba2f32bdf791005443988a4955e963663e16b1ed",
 "browserCommit":"3f0a2cdf378939ebe3c6f9ab36d4ea100c25aac2",
 "originalOfficialExecutableSHA256":original_hash,"originalOfficialBackup":str(backup),
 "sourceBuiltApp":str(built),"experimentalExecutableSHA256":hashof(destination/"Contents/MacOS/OBS"),
 "experimentalModuleSHA256":hashof(installed),"publicSourceEntitlementsMatch":True,
 "signing":"normal upstream Xcode ad-hoc build; no preserved third-party restricted identities",
 "entitlementKeys":sorted(declared),"moduleDependencies":subprocess.check_output(["otool","-L",str(installed)],text=True)}
(out/"module-provenance.json").write_text(json.dumps(record,indent=2))
print(json.dumps(record,indent=2))
