#!/usr/bin/env python3
"""Offline recovery of immutable raw .atrc in Mac cloud. Never launches target or records."""
import pathlib,os,platform,json,subprocess,signal,hashlib,time,xml.etree.ElementTree as ET
assert os.environ.get("GITHUB_ACTIONS")=="true"
assert platform.machine()=="arm64" and platform.mac_ver()[0].split(".")[0]=="26"
root=pathlib.Path("/tmp/ai-live-offline-metal-import")
source=root/"source";out=root/"exports";out.mkdir(parents=True,exist_ok=False)
template=os.environ.get("AI_LIVE_OFFLINE_IMPORT_TEMPLATE","Metal System Trace")
assert template in ["Metal System Trace","Time Profiler"],"Only actual inventoried template names"
report={"actualRequestedTemplate":template,"purpose":"FORENSIC offline import only; original target not launched and original record failure preserved",
    "sourceRun":41142373996,"sourceArtifact":13019051796,"completed":False,
    "notProductAcceptance":True,"exports":[]}
def save():(out/"actual-offline-import.json").write_text(json.dumps(report,indent=2))
def sample_owned_importer(owned_root):
    # Only the exact Popen root and its same-UID descendants; no service/system process sampling.
    inventory=subprocess.run(["ps","-axo","pid=,ppid=,uid=,state=,comm="],capture_output=True,text=True,timeout=10)
    (out/"import-deadline-process-inventory.txt").write_text(inventory.stdout)
    rows=[]
    for line in inventory.stdout.splitlines():
        fields=line.strip().split(maxsplit=4)
        if len(fields)==5 and all(x.isdigit() for x in fields[:3]):
            rows.append({"pid":int(fields[0]),"ppid":int(fields[1]),"uid":int(fields[2]),
                "state":fields[3],"executable":fields[4]})
    owned={owned_root}
    for _ in range(len(rows)+1):
        before=len(owned);owned.update(x["pid"] for x in rows if x["ppid"] in owned and x["uid"]==os.getuid())
        if len(owned)==before:break
    actual=[x for x in rows if x["pid"] in owned and x["uid"]==os.getuid()]
    report["actualImporterDeadlineProcesses"]=actual;report["actualImporterStackAttempts"]=[];save()
    for i,row in enumerate(actual[:3]):
        if row["pid"]==owned_root and row["ppid"]!=os.getpid():continue
        current=subprocess.run(["ps","-p",str(row["pid"]),"-o","ppid=","-o","uid=","-o","comm="],
            capture_output=True,text=True,timeout=5)
        fields=current.stdout.strip().split(maxsplit=2)
        if current.returncode!=0 or len(fields)!=3 or int(fields[0])!=row["ppid"] or int(fields[1])!=row["uid"] or fields[2]!=row["executable"]:continue
        target=out/("actual-importer-deadline-stack-"+str(i)+".txt")
        args=["/usr/bin/sample",str(row["pid"]),"2","1","-file",str(target)]
        try:
            p=subprocess.run(args,capture_output=True,text=True,timeout=8)
            item={"process":row,"args":args,"returncode":p.returncode,"timedOut":False}
            (out/("sample-importer-"+str(i)+".stdout")).write_text(p.stdout)
            (out/("sample-importer-"+str(i)+".stderr")).write_text(p.stderr)
        except subprocess.TimeoutExpired:
            item={"process":row,"args":args,"timedOut":True}
        item["actualStackFile"]=target.name;item["actualStackExists"]=target.exists()
        report["actualImporterStackAttempts"].append(item);save()
def command(args,name,timeout=45):
    print("ACTUAL OFFLINE COMMAND",name,flush=True)
    with (out/(name+".stdout")).open("wb") as stdout,(out/(name+".stderr")).open("wb") as stderr:
        p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
        timed=False;started=time.time()
        try:p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed=True
            report["actualOfflineDeadlineExceeded"]={"command":name,"at":time.time(),"originalTimeoutSeconds":timeout};save()
            if name=="actual-import":
                try:sample_owned_importer(p.pid)
                except Exception as evidence_error:report["actualImporterSampleError"]=repr(evidence_error);save()
            if p.poll() is None:p.send_signal(signal.SIGINT)
            try:p.wait(timeout=15)
            except subprocess.TimeoutExpired:p.kill();p.wait(timeout=10)
    meta={"args":args,"returncode":p.returncode,"timedOut":timed,"elapsedSeconds":time.time()-started}
    (out/(name+".command.json")).write_text(json.dumps(meta,indent=2))
    print(json.dumps(meta),flush=True)
    return meta
try:
    version=command(["xcodebuild","-version"],"actual-xcode-version")
    assert version["returncode"]==0 and not version["timedOut"]
    report["actualXcodeVersion"]=(out/"actual-xcode-version.stdout").read_text()
    report["actualDeveloperDir"]=os.environ.get("DEVELOPER_DIR")
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
    templates=command(["xcrun","xctrace","list","templates"],"actual-current-templates")
    assert templates["returncode"]==0 and not templates["timedOut"]
    actual_names=(out/"actual-current-templates.stdout").read_text().splitlines()
    assert template in actual_names,("Selected template absent from actual installed tool",template)
    helpmeta=command(["xcrun","xctrace","help","import"],"actual-import-help")
    helptext=(out/"actual-import-help.stdout").read_text()+(out/"actual-import-help.stderr").read_text()
    print(helptext,flush=True)
    assert helpmeta["returncode"]==0 and not helpmeta["timedOut"]
    for option in ["--input","--output","--template","--instrument"]:
        assert option in helptext,("Required option absent from actual CLI help",option)
    trace=root/"offline-recovered.trace"
    # Separate, bounded offline indexing of the same bytes; original record's 90s failure remains.
    meta=command(["xcrun","xctrace","import","--input",str(raw),"--output",str(trace),
        "--template",template,"--instrument","Thread State Trace"],"actual-import",timeout=240)
    report["actualImport"]=meta;save()
    print((out/"actual-import.stdout").read_text(errors="replace"),flush=True)
    print((out/"actual-import.stderr").read_text(errors="replace"),flush=True)
    import_ok=meta["returncode"]==0 and not meta["timedOut"]
    report["offlineImportFailed"]=not import_ok
    report["actualGeneratedTraceExists"]=trace.is_dir()
    report["actualGeneratedTraceFileInventory"]=[]
    if trace.is_dir():
        for f in sorted(trace.rglob("*")):
            assert not f.is_symlink(),str(f)
            if not f.is_file():continue
            digest=hashlib.sha256()
            with f.open("rb") as stream:
                for block in iter(lambda:stream.read(4*1024*1024),b""):digest.update(block)
            report["actualGeneratedTraceFileInventory"].append(
                {"path":str(f.relative_to(trace)),"bytes":f.stat().st_size,"sha256":digest.hexdigest()})
    save()
    assert report["actualGeneratedTraceExists"],"No generated trace to inspect; original/offline failure preserved"
    # A failed importer may have emitted a readable partial trace. Read evidence; NEVER turn its exit green.
    toc=out/"actual-offline-toc.xml"
    meta=command(["xcrun","xctrace","export","--input",str(trace),"--toc","--output",str(toc)],"actual-export-toc")
    assert meta["returncode"]==0 and not meta["timedOut"] and toc.is_file()
    tables=[x.attrib for x in ET.parse(toc).getroot().iter() if x.tag=="table" and "schema" in x.attrib]
    report["actualPublishedTables"]=tables;save()
    selected=[x["schema"] for x in tables if x["schema"] in [
        "time-info","process-info","thread-info","thread-snapshot","thread-state","context-switch","syscall",
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
    if template=="Time Profiler":
        assert any(x["actualSchema"]=="time-info" and x["actualRows"]>0 for x in report["exports"]),"Actual clock table missing"
        assert any(x["actualSchema"] in ["thread-state","context-switch"] and x["actualRows"]>0 for x in report["exports"]),"Actual scheduling/state rows missing"
        report["projectionBoundary"]="Thread/clock evidence only. No product acceptance or physical GPU execution claim."
    report["evidenceExportCompleted"]=True
    report["partialEvidenceOnly"]=not import_ok
    report["completed"]=import_ok;save()
    assert import_ok,"Offline importer failed; exported partial evidence does not change original failure"
except BaseException as error:
    report["error"]=repr(error);save();raise
finally:
    print(json.dumps(report,indent=2),flush=True)
