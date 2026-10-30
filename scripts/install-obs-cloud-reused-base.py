#!/usr/bin/env python3
"""Cloud-only module rebuild installed into the prior independently built, unshipped OBS app."""
import os,platform,pathlib,json,hashlib,subprocess,shutil,plistlib,tempfile
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin"
assert platform.machine()=="arm64"
root=pathlib.Path("cloud-obs-source").resolve()
out=pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"]).resolve()
base=pathlib.Path("prior-unshipped-base").resolve()
hashof=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
expected=(base/"SHA256SUMS").read_text().split()[0]
assert len(expected)==64 and hashof(base/"OBS.zip")==expected,"Saved cloud app archive changed"
prior=json.loads((base/"module-provenance.json").read_text())
assert prior["obsCommit"]=="ba2f32bdf791005443988a4955e963663e16b1ed"
assert prior["browserCommit"]=="3f0a2cdf378939ebe3c6f9ab36d4ea100c25aac2"
expanded=pathlib.Path(tempfile.mkdtemp(prefix="ai-live-cloud-base-"))
subprocess.run(["/usr/bin/ditto","-x","-k",str(base/"OBS.zip"),str(expanded)],check=True)
app=expanded/"OBS.app"
assert app.is_dir() and not app.is_symlink()
main=app/"Contents/MacOS/OBS"
assert hashof(main)=="132d421821335ae7f613dac552a17f678923c82c5c41fb5bb9e1f99661486d76"
assert hashof(app/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser")=="8a9ee4d1b0690b3665ee5d790d5b4d654916331b9040de0327cda89f596f6f35"
def verify(p):
    subprocess.run(["codesign","--verify","--deep","--strict",str(p)],check=True)
def entitlements(p):
    return subprocess.run(["codesign","-d","--entitlements","-","--xml",str(p)],capture_output=True,check=True).stdout
verify(app)
declared_bytes=(root/"frontend/cmake/macos/entitlements.plist").read_bytes()
declared=plistlib.loads(declared_bytes,fmt=plistlib.FMT_XML)
assert plistlib.loads(entitlements(app))==declared
(out/"public-source-app-entitlements.plist").write_bytes(declared_bytes)
def unique_bundle(name):
    found=[p for p in (root/"build_macos").rglob(name) if p.is_dir() and not p.is_symlink()]
    assert len(found)==1,{"bundle":name,"actualCandidates":[str(p) for p in found]}
    return found[0]
browser=unique_bundle("obs-browser.plugin")
metal=app/"Contents/Frameworks/libobs-metal.dylib"
assert metal.is_file() and not metal.is_symlink(),"Pinned reused Metal library missing"
verify(browser)
verify(metal)
metal_binary=metal.resolve()
symbols=subprocess.check_output(["nm","-gU",str(metal_binary)],text=True)
for expected_symbol in ["_device_ci_copy_texture_completed","_device_ci_readback_control"]:
    assert any(line.split()[-1:] == [expected_symbol] for line in symbols.splitlines()),expected_symbol
(out/"actual-metal-exports.txt").write_text(symbols)
assert hashof(metal)=="519814d4f0901b60b12b16e65279cf8496b53ac51da134542c41498ced160a49"
expected_metal_sources={"libobs-metal/metal-texture2d.swift":"b431d26e89befd2724e982d9eac0089df2785c5f264b02b942cf5a30af2cc214",
 "libobs-metal/MetalStageBuffer.swift":"73fd2ef65be0cbe9625a98ac649de2f7cc27f267d2443fcce50d8b6f42f1b4ab",
 "libobs-metal/metal-stagesurf.swift":"1f23fedb170741873b7d4e271696d7c32d15809179e2a61c07175fccfb55f20d",
 "libobs-metal/MetalDevice.swift":"0b5ad3add970d0278633448696bc43ec2ba46e254b1642e0e5d9c9377c6cfb18"}
actual_sources={x["file"]:x["patchedSHA256"] for x in json.loads((out/"source-provenance.json").read_text())["files"]}
assert all(actual_sources.get(k)==v for k,v in expected_metal_sources.items()),"Reused Metal sources differ from the actual compiled base"
original_metal=app/"Contents/Frameworks/libobs-metal.dylib"
assert original_metal.is_file() and not original_metal.is_symlink()
replacements=[(browser,app/"Contents/PlugIns/obs-browser.plugin")]
for built,target in replacements:
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    subprocess.run(["/usr/bin/ditto",str(built),str(target)],check=True)
# Keep each nested bundle's own upstream build signature and permissions. Renew only the enclosing ad-hoc seal.
subprocess.run(["codesign","--force","--sign","-","--options","runtime","--entitlements",
                str(out/"public-source-app-entitlements.plist"),str(app)],check=True)
verify(app)
assert plistlib.loads(entitlements(app))==declared
details=subprocess.run(["codesign","-dv","--verbose=4",str(app)],capture_output=True,check=True).stderr.decode()
assert "runtime" in details,details
destination=pathlib.Path("/Applications/OBS.app")
backup=None
if destination.exists():
    assert destination.is_dir() and not destination.is_symlink()
    backup=pathlib.Path(tempfile.mkdtemp(prefix="ai-live-cloud-existing-backup-"))/"OBS.app"
    shutil.move(str(destination),str(backup))
subprocess.run(["/usr/bin/ditto",str(app),str(destination)],check=True)
verify(destination)
after=entitlements(destination)
(out/"installed-source-app-entitlements.plist").write_bytes(after)
assert plistlib.loads(after)==declared
installed=destination/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser"
installed_metal=(destination/"Contents/Frameworks/libobs-metal.dylib").resolve()
assert hashof(installed)==hashof(browser/"Contents/MacOS/obs-browser")
assert hashof(installed_metal)==hashof(metal_binary)
record={"purpose":"UNSHIPPED cloud module rebuild on saved independent source app, not official OBS or alpha.4",
 "obsCommit":prior["obsCommit"],"browserCommit":prior["browserCommit"],
 "reusedBaseRun":40990917910,"reusedBaseArtifact":12949014732,
 "reusedBaseArtifactZipSHA256":"89e3023ffb9942e48f8cd0c220aeaedef969dd1918955e68904e2646cd7e98aa",
 "reusedBaseInnerAppZipSHA256":expected,"reusedBaseExecutableSHA256":prior["experimentalExecutableSHA256"],
 "experimentalExecutableSHA256":hashof(destination/"Contents/MacOS/OBS"),
 "experimentalModuleSHA256":hashof(installed),"experimentalMetalSHA256":hashof(installed_metal),
 "experimentalMetalPath":str(installed_metal),"actualBrowserBuildPath":str(browser),"reusedMetalPath":str(metal),"metalReusedFromRun":40990917910,"unchangedMetalSourcesVerified":True,
 "publicSourceEntitlementsMatch":True,"entitlementKeys":sorted(declared),
 "signing":"nested upstream build signatures; outer source app ad-hoc seal with same public permissions and hardened runtime",
 "signatureDetails":details,"existingDisposableCloudAppBackup":str(backup) if backup else None,
 "moduleDependencies":subprocess.check_output(["otool","-L",str(installed)],text=True),
 "metalDependencies":subprocess.check_output(["otool","-L",str(installed_metal)],text=True)}
(out/"module-provenance.json").write_text(json.dumps(record,indent=2))
print(json.dumps(record,indent=2))
