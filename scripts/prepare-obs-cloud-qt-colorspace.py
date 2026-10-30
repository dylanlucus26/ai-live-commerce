#!/usr/bin/env python3
"""Cloud-only installation of an exact test bundle and the official QtGui QTBUG-147602 fix."""
import os,platform,pathlib,json,hashlib,subprocess,sys,tempfile,urllib.request,tarfile,shutil,plistlib
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin" and platform.machine()=="arm64"
mode,base=sys.argv[1:3]
assert mode in ("patch","verify")
subprocess.run([sys.executable,"scripts/install-obs-cloud-verified-bundle.py",base],check=True)
out=pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"])
app=pathlib.Path("/Applications/OBS.app")
provenance=json.loads((out/"module-provenance.json").read_text())
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
qt=app/"Contents/Frameworks/QtGui.framework"
binary=qt/"Versions/A/QtGui"
if mode=="patch":
    before_browser=digest(app/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser")
    before_metal=digest(app/"Contents/Frameworks/libobs-metal.dylib")
    old_qt=digest(binary)
    def unchanged_files():
        return {str(p.relative_to(app)):digest(p) for p in app.rglob("*") if p.is_file() and not p.is_symlink()
            and not str(p.relative_to(app)).startswith(("Contents/Frameworks/QtGui.framework/","Contents/_CodeSignature/"))
            and str(p.relative_to(app))!="Contents/MacOS/OBS"}
    untouched=unchanged_files()
    archive=out/"official-macos-deps-qt6-2026-10-23-arm64.tar.xz"
    url="https://github.com/obsproject/obs-deps/releases/download/2026-10-23/macos-deps-qt6-2026-10-23-arm64.tar.xz"
    with urllib.request.urlopen(url,timeout=60) as response,archive.open("wb") as target:
        shutil.copyfileobj(response,target)
    archive_sha=digest(archive)
    assert archive_sha=="3f9153cd85b68526d865b60bd8b66fc98b945a8acefea77b2ae3a9eb2bf8718a"
    expanded=pathlib.Path(tempfile.mkdtemp(prefix="official-fixed-qtgui-"))
    with tarfile.open(archive,"r:xz") as tar:
        members=[m for m in tar.getmembers() if m.name=="lib/QtGui.framework" or m.name.startswith("lib/QtGui.framework/")]
        assert members
        tar.extractall(expanded,members=members,filter="data")
    fixed=expanded/"lib/QtGui.framework"
    fixed_binary=fixed/"Versions/A/QtGui"
    assert digest(fixed_binary)=="2f92fd46f2772635fc2edf7e20230830e0b1d4880e8ff34b0c7c41dd581dc2d6"
    header=fixed/"Versions/A/Headers/6.11.1/QtGui/private/qcoregraphics_p.h"
    data=header.read_bytes()
    blob=hashlib.sha1(("blob "+str(len(data))+"\0").encode()+data).hexdigest()
    assert blob=="00ba98f0ba222cb9ee416529051fe134cf6c89ce"
    assert b"QCFType<CGColorSpaceRef> colorSpace" in data and b"std::optional<QCGImageFormat>" in data
    (out/"official-fixed-qcoregraphics_p.h").write_bytes(data)
    info=plistlib.loads((fixed/"Versions/A/Resources/Info.plist").read_bytes())
    assert info["CFBundleVersion"]=="6.11.1"
    (out/"official-QtGui-load-commands.txt").write_text(subprocess.check_output(["otool","-l",str(fixed_binary)],text=True))
    (out/"official-QtGui-dependencies.txt").write_text(subprocess.check_output(["otool","-L",str(fixed_binary)],text=True))
    assert subprocess.check_output(["lipo","-archs",str(fixed_binary)],text=True).strip()=="arm64"
    shutil.rmtree(qt)
    subprocess.run(["/usr/bin/ditto",str(fixed),str(qt)],check=True)
    subprocess.run(["codesign","--force","--sign","-",str(qt)],check=True)
    subprocess.run(["codesign","--force","--sign","-","--options","runtime","--entitlements",str(out/"public-source-app-entitlements.plist"),str(app)],check=True)
    subprocess.run(["codesign","--verify","--deep","--strict",str(app)],check=True)
    entitlements=subprocess.run(["codesign","-d","--entitlements","-","--xml",str(app)],capture_output=True,check=True).stdout
    assert plistlib.loads(entitlements)==plistlib.loads((out/"public-source-app-entitlements.plist").read_bytes(),fmt=plistlib.FMT_XML)
    assert digest(app/"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser")==before_browser
    assert digest(app/"Contents/Frameworks/libobs-metal.dylib")==before_metal
    assert untouched==unchanged_files(),"Unexpected change outside QtGui and enclosing app code signature"
    provenance.update({
        "purpose":"UNSHIPPED private-frame test bundle with the official same-version QtGui color-space lifetime fix",
        "experimentalExecutableSHA256":digest(app/"Contents/MacOS/OBS"),
        "experimentalQtGuiSHA256":digest(binary),
        "qtFix":{"issue":"QTBUG-147602","qtVersion":"6.11.1","oldQtGuiSHA256":old_qt,
          "officialRelease":"2026-10-23","officialSourceCommit":"cbf0a3d8a0a34c07e822bda22a5f8214f91801d7",
          "upstreamQtFixCommit":"08e464f8559719662c5b2207d1d4c84c251eca07",
          "archiveURL":url,"archiveSHA256":archive_sha,
          "unsignedQtGuiSHA256":"2f92fd46f2772635fc2edf7e20230830e0b1d4880e8ff34b0c7c41dd581dc2d6",
          "fixedHeaderGitBlob":blob,"unchangedFilesOutsideQtGuiAndOuterSignature":len(untouched),
          "browserAndMetalUnchanged":True,"samePublicAppEntitlements":True}
    })
else:
    assert provenance["qtFix"]["issue"]=="QTBUG-147602"
    assert digest(binary)==provenance["experimentalQtGuiSHA256"],"Runtime QtGui differs from the preceding fixed bundle"
    provenance["runtimeQtGuiHashMatches"]=True
provenance["runtimePurpose"]="Exact cloud-built unshipped OBS and QtGui bundle on "+platform.mac_ver()[0]
provenance["runtimeOS"]=platform.mac_ver()[0]
(out/"module-provenance.json").write_text(json.dumps(provenance,indent=2))
print(json.dumps(provenance,indent=2))
