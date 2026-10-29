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
assert hashof(main)=="9f41f37bbcc25a8de2e24953a28cb2ce8ce2408adfc6ee7d608f16c8ed306800"
assert hashof(app/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser")=="11a9c62157cfc8acefbfb610f6c52950f0d37f6943643f878ca63fb34e6e732a"
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
metal=root/"build_macos/libobs-metal/Release/libobs-metal.dylib"
assert metal.is_file() and not metal.is_symlink(),"Expected the actual dylib produced in the preceding cloud build"
verify(browser)
verify(metal)
metal_binary=metal.resolve()
symbols=subprocess.check_output(["nm","-gU",str(metal_binary)],text=True)
assert any(line.split()[-1:] == ["_device_ci_copy_texture_completed"] for line in symbols.splitlines()),"Built Metal export absent"
(out/"actual-metal-exports.txt").write_text(symbols)
original_metal=app/"Contents/Frameworks/libobs-metal.dylib"
assert original_metal.is_file() and not original_metal.is_symlink()
replacements=[(browser,app/"Contents/PlugIns/obs-browser.plugin"),(metal,original_metal)]
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
 "reusedBaseRun":40831785879,"reusedBaseArtifact":12879323025,
 "reusedBaseArtifactZipSHA256":"674eacdde2cbc627ceb1c7a9507482d202446735c8ff44409d1c5055c1fe5782",
 "reusedBaseInnerAppZipSHA256":expected,"reusedBaseExecutableSHA256":prior["experimentalExecutableSHA256"],
 "experimentalExecutableSHA256":hashof(destination/"Contents/MacOS/OBS"),
 "experimentalModuleSHA256":hashof(installed),"experimentalMetalSHA256":hashof(installed_metal),
 "experimentalMetalPath":str(installed_metal),"actualBrowserBuildPath":str(browser),"actualMetalBuildPath":str(metal),
 "publicSourceEntitlementsMatch":True,"entitlementKeys":sorted(declared),
 "signing":"nested upstream build signatures; outer source app ad-hoc seal with same public permissions and hardened runtime",
 "signatureDetails":details,"existingDisposableCloudAppBackup":str(backup) if backup else None,
 "moduleDependencies":subprocess.check_output(["otool","-L",str(installed)],text=True),
 "metalDependencies":subprocess.check_output(["otool","-L",str(installed_metal)],text=True)}
(out/"module-provenance.json").write_text(json.dumps(record,indent=2))
print(json.dumps(record,indent=2))
