#!/usr/bin/env python3
"""Cloud-only read/export of one existing immutable system trace; runs no app."""
import pathlib,os,platform,json,subprocess,signal,hashlib,xml.etree.ElementTree as ET
assert os.environ.get("GITHUB_ACTIONS")=="true"
assert platform.machine()=="arm64" and platform.mac_ver()[0].split(".")[0]=="26"
root=pathlib.Path("/tmp/ai-live-existing-metal-trace")
source=root/"source";out=root/"exports";out.mkdir(parents=True,exist_ok=False)
result={"purpose":"FORENSIC ONLY: export existing trace, no app/performance rerun",
    "completed":False,"notPerformanceAcceptance":True,
    "sourceRun":41135751273,"sourceArtifact":13016257075,
    "sourceArtifactZIP_SHA256":"80b6620db29a8f877689a2bf5fed5410892f7eefffde2f9f7ccc27fec291bd3c",
    "exports":[]}
def save():
    (out/"actual-existing-trace-export.json").write_text(json.dumps(result,indent=2))
def command(args,name,timeout=45):
    with (out/(name+".stdout")).open("wb") as stdout,(out/(name+".stderr")).open("wb") as stderr:
        p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
        timed=False
        try:p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed=True;p.send_signal(signal.SIGINT)
            try:p.wait(timeout=15)
            except subprocess.TimeoutExpired:p.kill();p.wait(timeout=10)
    meta={"args":args,"returncode":p.returncode,"timedOut":timed}
    (out/(name+".command.json")).write_text(json.dumps(meta,indent=2))
    assert meta["returncode"]==0 and not timed,meta
    return meta
try:
    info=json.loads((source/"owned-gpu-profile/actual-profile-result.json").read_text())
    assert info["actualOwnedTarget"]["runID"]==str(result["sourceRun"])
    assert info["recordReturnCode"]==0 and info["recordTimedOut"] is False and info["traceUsable"] is True
    result["sourceActualOwnedTarget"]=info["actualOwnedTarget"]
    result["sourceActualProbeStrictPass"]=info["actualProbePhaseStrictPass"]
    result["sourceFailurePreserved"]=info.get("error")
    trace=source/"owned-gpu-profile/actual-owned-gui-metal.trace"
    assert trace.is_dir() and not trace.is_symlink()
    inventory=[]
    for p in sorted(trace.rglob("*")):
        assert not p.is_symlink(),str(p)
        if p.is_file():inventory.append({"path":str(p.relative_to(trace)),"bytes":p.stat().st_size,
            "sha256":hashlib.sha256(p.read_bytes()).hexdigest()})
    result["actualTraceFileInventory"]=inventory
    inventory_digest=hashlib.sha256(json.dumps(inventory,sort_keys=True,separators=(",",":")).encode()).hexdigest()
    result["actualTraceFileInventorySHA256"]=inventory_digest
    assert inventory_digest=="dec02e755da4f0e2a807e78f102b69f51a8586592ad82142318c77ddec58b9a0","Downloaded trace differs from actual original ZIP"
    save()
    command(["xcrun","xctrace","help","export"],"export-help")
    toc=out/"actual-existing-toc.xml"
    command(["xcrun","xctrace","export","--input",str(trace),"--toc","--output",str(toc)],"export-toc")
    tables=[x.attrib for x in ET.parse(toc).getroot().iter() if x.tag=="table" and "schema" in x.attrib]
    schemas=sorted(set(x["schema"] for x in tables));result["actualPublishedTables"]=tables
    requested=["time-info","thread-info","time-profile","time-sample","kdebug","os-log"]
    for schema in requested:
        assert schema in schemas,("Actual source trace lacks requested published schema",schema)
        target=out/(schema+".xml")
        args=["xcrun","xctrace","export","--input",str(trace),"--xpath",
            "//run/data/table[@schema='"+schema+"']","--output",str(target)]
        meta=command(args,"export-"+schema)
        assert target.exists()
        data=target.read_bytes()
        item={"schema":schema,"file":target.name,"command":meta,"bytes":len(data),
            "sha256":hashlib.sha256(data).hexdigest(),
            "actualRows":sum(x.tag=="row" for x in ET.fromstring(data).iter())}
        result["exports"].append(item);save();print(json.dumps(item))
    result["completed"]=True;save()
    print(json.dumps({k:v for k,v in result.items() if k!="actualTraceFileInventory"},indent=2))
except BaseException as e:
    result["error"]=repr(e);save();raise
