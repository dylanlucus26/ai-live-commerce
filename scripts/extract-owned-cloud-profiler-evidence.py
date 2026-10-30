#!/usr/bin/env python3
"""Cloud-only metadata repack of one immutable failed collector artifact. No workload."""
import os,pathlib,json,hashlib,shutil
assert os.environ.get("GITHUB_ACTIONS")=="true","Cloud only"
root=pathlib.Path("/tmp/ai-live-profiler-evidence-repack")
source=root/"source";out=root/"metadata";out.mkdir(parents=True,exist_ok=False)
report={"purpose":"FORENSIC metadata extraction only; no app launch, decoding or workload rerun",
    "sourceRunID":41142373996,"sourceArtifactID":13019051796,
    "sourceArtifactBytes":621631202,
    "sourceArchiveServerAndUploadSHA256":"579d7d9157b9b3b9ada7c5932935cb06f1dcfbcd81660e5c2b8bd8dc9abc6cf5",
    "sourceArchiveDigestProvenance":"GitHub API and upload log; repack does not independently hash original ZIP",
    "notProductAcceptance":True,"completed":False,"files":[],"copied":[]}
def save():
    (out/"extraction-manifest.json").write_text(json.dumps(report,indent=2))
try:
    assert source.is_dir()
    paths=sorted(source.rglob("*"))
    assert not any(p.is_symlink() for p in paths),"Unexpected symlink in evidence"
    for p in paths:
        if not p.is_file():continue
        rel=p.relative_to(source)
        digest=hashlib.sha256()
        with p.open("rb") as stream:
            for block in iter(lambda:stream.read(4*1024*1024),b""):digest.update(block)
        entry={"path":rel.as_posix(),"bytes":p.stat().st_size,"sha256":digest.hexdigest()}
        report["files"].append(entry)
        inside_trace=any(part.endswith(".trace") for part in rel.parts[:-1])
        issue_db=p.name in ["RunIssues.storedata","RunIssues.storedata-wal","RunIssues.storedata-shm"]
        if not inside_trace or issue_db:
            assert entry["bytes"]<=32*1024*1024,("Sidecar exceeds metadata-only bound; no truncation",entry)
            dest=out/"original"/rel;dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(p,dest)
            report["copied"].append(entry)
    actual=json.loads((source/"owned-gpu-profile/actual-profile-result.json").read_text())
    assert actual["actualOwnedTarget"]["runID"]==str(report["sourceRunID"])
    assert actual["completed"] is False and actual["traceUsable"] is False and actual["recordTimedOut"] is True
    assert actual["actualCollectorMaximumComparison"]["directCLI"]==[20]
    assert actual["actualCollectorMaximumComparison"]["launchServicesChildPython"]==[63]
    assert actual["actualProfilerRootMaxPriorities"]==[63]
    assert actual["recordReturnCode"]==-9 and actual["actualProbePhaseStrictPass"] is False
    assert actual["actualFinalOwnedTargetPIDGone"] is True
    report["originalFailurePreserved"]={k:actual[k] for k in
        ["completed","traceUsable","recordTimedOut","recordReturnCode","actualProbePhaseStrictPass","error"]}
    report["totalSourceBytes"]=sum(x["bytes"] for x in report["files"])
    report["totalCopiedBytes"]=sum(x["bytes"] for x in report["copied"])
    report["completed"]=True
finally:
    save()
    print(json.dumps({k:v for k,v in report.items() if k not in ["files","copied"]},indent=2))
    print("ACTUAL FILE INVENTORY:",json.dumps(report["files"],indent=2))
