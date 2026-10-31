#!/usr/bin/env python3
"""Cloud-only narrow Metal replacement on the exact verified cc0 unshipped bundle."""
import os,platform,pathlib,json,hashlib,subprocess,shutil,plistlib
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin" and platform.machine()=="arm64"
assert platform.mac_ver()[0].split(".")[0]=="26"
root=pathlib.Path("cloud-obs-source").resolve()
base=pathlib.Path("prior-identical-cc0-base").resolve()
out=pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"]).resolve()
app=pathlib.Path("/Applications/OBS.app")
hashof=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
prior=json.loads((base/"module-provenance.json").read_text())
assert prior["experimentalExecutableSHA256"]=="2bc164c035195001efcb5a3b85be916bf4976333374eedd27a9ab6edd11e906b"
assert prior["experimentalModuleSHA256"]=="b856caca091f912cdbca4a4edc5ca032c461f7a13cc85aeb3046aa3cef344f05"
assert prior["experimentalMetalSHA256"]=="de3ac1c33e16e5e892176335ab699d06cf1d4d878f6f2668b15ee63c40c71dba"
before=json.loads((out/"module-provenance.json").read_text())
for path,key in [("Contents/MacOS/OBS","experimentalExecutableSHA256"),("Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser","experimentalModuleSHA256"),("Contents/Frameworks/libobs-metal.dylib","experimentalMetalSHA256"),("Contents/Frameworks/QtGui.framework/Versions/A/QtGui","experimentalQtGuiSHA256")]:
    assert hashof(app/path)==prior[key],key
old_sources=json.loads((base/"source-provenance.json").read_text())
new_sources=json.loads((out/"source-provenance.json").read_text())
old={x["file"]:x["patchedSHA256"] for x in old_sources["files"]}
new={x["file"]:x["patchedSHA256"] for x in new_sources["files"]}
assert set(old)==set(new)
changed=[name for name in sorted(new) if old[name]!=new[name]]
assert changed==["libobs-metal/MetalStageBuffer.swift"],changed
assert all(hashof(root/x["file"])==x["patchedSHA256"] for x in new_sources["files"] if x["file"].startswith("libobs-metal/"))
metal=root/"build_macos/libobs-metal/Release/libobs-metal.dylib"
assert metal.is_file() and not metal.is_symlink()
subprocess.run(["codesign","--verify","--strict",str(metal)],check=True)
symbols=subprocess.check_output(["nm","-gU",str(metal)],text=True)
for symbol in ["_device_ci_readback_timing_json","_device_ci_readback_control","_device_ci_copy_texture_completed_timed"]:
    assert any(line.split()[-1:]==[symbol] for line in symbols.splitlines()),symbol
(out/"actual-metal-exports.txt").write_text(symbols)
assert hashof(metal)!=prior["experimentalMetalSHA256"]
target=app/"Contents/Frameworks/libobs-metal.dylib"
assert target.is_file() and not target.is_symlink()
target.unlink()
subprocess.run(["/usr/bin/ditto",str(metal),str(target)],check=True)
declared_bytes=(out/"public-source-app-entitlements.plist").read_bytes()
assert hashlib.sha1(("blob "+str(len(declared_bytes))+"\0").encode()+declared_bytes).hexdigest()=="9931d62e03b105b385ead68338502484b9c00c44"
declared=plistlib.loads(declared_bytes,fmt=plistlib.FMT_XML)
subprocess.run(["codesign","--force","--sign","-","--options","runtime","--entitlements",str(out/"public-source-app-entitlements.plist"),str(app)],check=True)
subprocess.run(["codesign","--verify","--deep","--strict",str(app)],check=True)
actual=subprocess.run(["codesign","-d","--entitlements","-","--xml",str(app)],capture_output=True,check=True).stdout
assert plistlib.loads(actual)==declared
(out/"installed-source-app-entitlements.plist").write_bytes(actual)
module=app/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser"
qtgui=app/"Contents/Frameworks/QtGui.framework/Versions/A/QtGui"
assert hashof(module)==prior["experimentalModuleSHA256"]
assert hashof(qtgui)==prior["experimentalQtGuiSHA256"]
assert hashof(target)==hashof(metal)
before.update({"purpose":"UNSHIPPED retained GPU readback wait releases the single graphics context entry",
    "runtimePurpose":"Same cc0 browser, Qt and core source; only MetalStageBuffer Swift source changes",
    "reusedPriorBuildRun":41109496526,"reusedPriorBuildArtifact":13004227950,
    "priorComponentSHA256":{k:v for k,v in prior.items() if k.endswith("SHA256")},
    "exactChangedNativeSourceFiles":changed,
    "experimentalExecutableSHA256":hashof(app/"Contents/MacOS/OBS"),
    "experimentalModuleSHA256":hashof(module),"experimentalMetalSHA256":hashof(target),
    "experimentalMetalPath":str(target),"experimentalQtGuiSHA256":hashof(qtgui),
    "publicSourceEntitlementsMatch":True,
    "runtimeSignatureAndAllComponentHashesMatch":False,
    "candidateSignatureAndAllComponentHashesVerified":True,
    "signing":"Rebuilt signed Metal library; enclosing ad-hoc seal renewed with same public entitlements",
    "metalDependencies":subprocess.check_output(["otool","-L",str(target)],text=True)})
(out/"module-provenance.json").write_text(json.dumps(before,indent=2))
print(json.dumps(before,indent=2))
