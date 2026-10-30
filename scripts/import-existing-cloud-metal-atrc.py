#!/usr/bin/env python3
"""Offline recovery of immutable raw .atrc in Mac cloud. Never launches target or records."""
import pathlib,os,platform,json,subprocess,signal,hashlib,time,xml.etree.ElementTree as ET
assert os.environ.get("GITHUB_ACTIONS")=="true"
assert platform.machine()=="arm64" and platform.mac_ver()[0].split(".")[0]=="26"
root=pathlib.Path("/tmp/ai-live-offline-metal-import")
source=root/"source";out=root/"exports";out.mkdir(parents=True,exist_ok=False)
report={"purpose":"FORENSIC offline import only; original target not launched and original record failure preserved",
    "sourceRun":41142373996,"sourceArtifact":13019051796,"completed":False,
    "notProductAcceptance":True,"exports":[]}
def save():(out/"actual-offline-import.json").write_text(json.dumps(report,indent=2))
def command(args,name,timeout=45):
    print("ACTUAL OFFLINE COMMAND",name,flush=True)
    with (out/(name+".stdout")).open("wb") as stdout,(out/(name+".stderr")).open("wb") as stderr:
        p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
        timed=False;started=time.time()
        try:p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed=True;p.send_signal(signal.SIGINT)
            try:p.wait(timeout=15)
            except subprocess.TimeoutExpired:p.kill();p.wait(timeout=10)
    meta={"args":args,"returncode":p.returncode,"timedOut":timed,"elapsedSeconds":time.time()-started}
    (out/(name+".command.json")).write_text(json.dumps(meta,indent=2))
    print(json.dumps(meta),flush=True)
    return meta
try:
    original=json.loads((source/"owned-gpu-profile/actual-profile-result.json").read_text())
    assert original["actualOwnedTarget"]["runID"]==str(report["sourceRun"])
    assert original["completed"] is False and original["traceUsable"] is False
    assert original["recordReturnCode"]==-9 and original["recordTimedOut"] is True
    report["originalFailurePreserved"]={k:original[k] for k in
        ["completed","traceUsable","recordReturnCode","recordTimedOut","actualProbePhaseStrictPass","error"]}
    (out/"original-profile-result.json").write_text(json.dumps(original,indent=2))
    raw=source/"owned-gpu-profile/actual-owned-gui-metal.trace/Trace1.run/Attachments/trace-data.atrc"
    assert raw.is_file() and not raw.is_symlink() and raw.stat().st_size==6543936664
    digest=hashlib.sha256()
    with raw.open("rb") as f:
        for block in iter(lambda:f.read(4*1024*1024),b""):digest.update(block)
    report["actualRawSHA256"]=digest.hexdigest();save()
    assert report["actualRawSHA256"]=="9653bb2dff460e493b292242e4f2e1422987bfb8fd3c85f0e810cb75a0f47c43"
    helpmeta=command(["xcrun","xctrace","help","import"],"actual-import-help")
    helptext=(out/"actual-import-help.stdout").read_text()+(out/"actual-import-help.stderr").read_text()
    print(helptext,flush=True)
    assert helpmeta["returncode"]==0 and not helpmeta["timedOut"]
    for option in ["--input","--output","--template","--instrument"]:
        assert option in helptext,("Required option absent from actual CLI help",option)
    trace=root/"offline-recovered.trace"
    # Separate, bounded offline indexing of the same bytes; original record's 90s failure remains.
    meta=command(["xcrun","xctrace","import","--input",str(raw),"--output",str(trace),
        "--template","Metal System Trace","--instrument","Thread State Trace"],"actual-import",timeout=240)
    report["actualImport"]=meta;save()
    print((out/"actual-import.stdout").read_text(errors="replace"),flush=True)
    print((out/"actual-import.stderr").read_text(errors="replace"),flush=True)
    assert meta["returncode"]==0 and not meta["timedOut"],"Offline importer failed; original recording never accepted"
    toc=out/"actual-offline-toc.xml"
    meta=command(["xcrun","xctrace","export","--input",str(trace),"--toc","--output",str(toc)],"actual-export-toc")
    assert meta["returncode"]==0 and not meta["timedOut"] and toc.is_file()
    tables=[x.attrib for x in ET.parse(toc).getroot().iter() if x.tag=="table" and "schema" in x.attrib]
    report["actualPublishedTables"]=tables;save()
    selected=[x["schema"] for x in tables if x["schema"] in [
        "time-info","thread-info","thread-state","context-switch","syscall",
        "metal-application-command-buffer-submissions","metal-command-buffer-completed",
        "metal-driver-command-buffer-events"]]
    for schema in sorted(set(selected)):
        target=out/(schema+".xml")
        meta=command(["xcrun","xctrace","export","--input",str(trace),"--xpath",
            "//run/data/table[@schema='"+schema+"']","--output",str(target)],"export-"+schema,timeout=60)
        assert meta["returncode"]==0 and not meta["timedOut"] and target.is_file()
        digest=hashlib.sha256();rows=0
        with target.open("rb") as f:
            for block in iter(lambda:f.read(4*1024*1024),b""):digest.update(block)
        for event,elem in ET.iterparse(target,events=("end",)):
            if elem.tag=="row":rows+=1;elem.clear()
        item={"actualSchema":schema,"file":target.name,"bytes":target.stat().st_size,
            "sha256":digest.hexdigest(),"actualRows":rows,"command":meta}
        report["exports"].append(item);save();print(json.dumps(item),flush=True)
    assert report["exports"],"No actual published tables exported"
    report["completed"]=True;save()
except BaseException as error:
    report["error"]=repr(error);save();raise
finally:
    print(json.dumps(report,indent=2),flush=True)
