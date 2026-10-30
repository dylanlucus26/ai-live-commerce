#!/usr/bin/env python3
"""Install only the exact cloud-built unshipped bundle verified by the preceding job."""
import os,platform,pathlib,hashlib,json,plistlib,subprocess,tempfile,shutil,sys
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin" and platform.machine()=="arm64"
base=pathlib.Path(sys.argv[1]).resolve()
out=pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"]).resolve();out.mkdir(parents=True,exist_ok=True)
hashof=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
expected=(base/"SHA256SUMS").read_text().split()[0]
assert len(expected)==64 and hashof(base/"OBS.zip")==expected
provenance=json.loads((base/"module-provenance.json").read_text())
assert provenance["obsCommit"]=="ba2f32bdf791005443988a4955e963663e16b1ed"
assert provenance["browserCommit"]=="3f0a2cdf378939ebe3c6f9ab36d4ea100c25aac2"
declared_bytes=(base/"public-source-app-entitlements.plist").read_bytes()
blob=hashlib.sha1(("blob "+str(len(declared_bytes))+"\0").encode()+declared_bytes).hexdigest()
assert blob=="9931d62e03b105b385ead68338502484b9c00c44"
declared=plistlib.loads(declared_bytes,fmt=plistlib.FMT_XML)
def verify(app):
 subprocess.run(["codesign","--verify","--deep","--strict",str(app)],check=True)
 result=subprocess.run(["codesign","-d","--entitlements","-","--xml",str(app)],capture_output=True,check=True)
 assert plistlib.loads(result.stdout)==declared
 for path,key in [("Contents/MacOS/OBS","experimentalExecutableSHA256"),("Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser","experimentalModuleSHA256"),("Contents/Frameworks/libobs-metal.dylib","experimentalMetalSHA256")]:
  assert hashof(app/path)==provenance[key],key
expanded=pathlib.Path(tempfile.mkdtemp(prefix="ai-live-verified-cloud-"))
subprocess.run(["/usr/bin/ditto","-x","-k",str(base/"OBS.zip"),str(expanded)],check=True)
app=expanded/"OBS.app";assert app.is_dir() and not app.is_symlink();verify(app)
destination=pathlib.Path("/Applications/OBS.app")
if destination.exists():
 assert destination.is_dir() and not destination.is_symlink()
 backup=pathlib.Path(tempfile.mkdtemp(prefix="ai-live-existing-cloud-"))/"OBS.app"
 shutil.move(str(destination),str(backup))
subprocess.run(["/usr/bin/ditto",str(app),str(destination)],check=True);verify(destination)
provenance.update({"runtimePurpose":"Exact unshipped macOS26-built bundle verification on a separate macOS15 ARM64 cloud runner",
 "runtimeOS":platform.mac_ver()[0],"runtimeWorkflowRun":os.environ["GITHUB_RUN_ID"],
 "runtimeInnerAppZipSHA256":expected,"runtimeSignatureAndAllComponentHashesMatch":True,
 "experimentalMetalPath":str(destination/"Contents/Frameworks/libobs-metal.dylib")})
(out/"module-provenance.json").write_text(json.dumps(provenance,indent=2))
(out/"public-source-app-entitlements.plist").write_bytes(declared_bytes)
print(json.dumps(provenance,indent=2))
