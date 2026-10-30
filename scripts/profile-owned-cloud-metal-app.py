#!/usr/bin/env python3
"""Cloud forensic xctrace attaches ONLY the exact independently built GUI probe PID.
Never product acceptance. No security/entitlement changes, all-process capture, or
profiler/target circular wait: the one-stage target quits normally after 60 seconds.
"""
import pathlib,os,sys,json,subprocess,time,signal,platform,xml.etree.ElementTree as ET
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.machine()=="arm64"
assert platform.mac_ver()[0].split(".")[0]=="26"
template=os.environ.get("AI_LIVE_GUI_PROFILE_TEMPLATE","Metal System Trace")
assert template in ["Metal System Trace","Game Performance"],"Only actual documented templates"
root=pathlib.Path("/tmp/ai-live-cloud-timer-policy")
out=root/"owned-gpu-profile";out.mkdir(exist_ok=False)
app=root/"CloudMetalControl.app"
result={"purpose":"FORENSIC target-specific Metal trace, never product or full performance acceptance",
    "completed":False,"traceUsable":False,"recordingAnnouncementIsNotReadiness":True,"exports":[],
    "actualRequestedTemplate":template}
def save():
    (out/"actual-profile-result.json").write_text(json.dumps(result,indent=2))
def command(args,name,timeout=45):
    with (out/(name+".stdout")).open("wb") as stdout,(out/(name+".stderr")).open("wb") as stderr:
        p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
        timed=False
        try:p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed=True;p.send_signal(signal.SIGINT)
            try:p.wait(timeout=15)
            except subprocess.TimeoutExpired:p.kill();p.wait(timeout=10)
    info={"args":args,"returncode":p.returncode,"timedOut":timed}
    (out/(name+".command.json")).write_text(json.dumps(info,indent=2))
    return info,(out/(name+".stdout")).read_text(errors="replace")+(out/(name+".stderr")).read_text(errors="replace")
def capture_owned_profiler_stacks(owned_root,phase):
    assert phase in ["startup","record-stopping"]
    meta,text=command(["ps","-axo","pid=,ppid=,uid=,state=,comm="],phase+"-process-inventory",timeout=10)
    rows=[]
    if meta["returncode"]==0:
        for line in text.splitlines():
            fields=line.strip().split(maxsplit=4)
            if len(fields)==5 and all(s.isdigit() for s in fields[:3]):
                rows.append({"pid":int(fields[0]),"ppid":int(fields[1]),"uid":int(fields[2]),
                    "state":fields[3],"executable":fields[4]})
    owned={owned_root}
    for _ in range(len(rows)+1):
        before=len(owned)
        owned.update(x["pid"] for x in rows if x["ppid"] in owned and x["uid"]==os.getuid())
        if len(owned)==before:break
    actual=[x for x in rows if x["pid"] in owned and x["uid"]==os.getuid()]
    entry={"phase":phase,"actualProcessTree":actual,"actualStackAttempts":[]}
    result.setdefault("actualProfilerBlockEvidence",[]).append(entry);save()
    for i,row in enumerate(actual[:3]):
        # Recheck this exact process identity immediately before a read-only stack sample.
        current=subprocess.run(["ps","-p",str(row["pid"]),"-o","ppid=","-o","uid=","-o","comm="],
            capture_output=True,text=True,timeout=5)
        fields=current.stdout.strip().split(maxsplit=2)
        if current.returncode!=0 or len(fields)!=3 or int(fields[0])!=row["ppid"] or int(fields[1])!=row["uid"] or fields[2]!=row["executable"]:
            entry["actualStackAttempts"].append({"process":row,"skipped":"actual process identity exited or changed"});save();continue
        target=out/("actual-profiler-"+phase+"-stack-"+str(i)+".txt")
        # Exact sample syntax already exercised by the cloud OBS diagnostic launcher.
        meta,text=command(["/usr/bin/sample",str(row["pid"]),"2","1","-file",str(target)],
            "sample-profiler-"+phase+"-"+str(i),timeout=8)
        entry["actualStackAttempts"].append({"process":row,"command":meta,
            "actualStackFile":target.name,"actualStackExists":target.exists()});save()
launcher=None;recorder=None
try:
    _,help_text=command(["xcrun","xctrace","help","record"],"record-help")
    _,export_help=command(["xcrun","xctrace","help","export"],"export-help")
    _,templates=command(["xcrun","xctrace","list","templates"],"actual-templates")
    command(["codesign","-d","--verbose=4",str(app)],"actual-probe-signature")
    assert template in templates
    for option in ["--attach","--template","--time-limit","--output"]:assert option in help_text
    for option in ["--input","--toc","--xpath","--output"]:assert option in export_help
    start_file=root/"actual-gui-probe-start.json"
    gate=root/"actual-profiler-begin-work.json"
    assert not start_file.exists() and not gate.exists(),"No stale target ownership"
    launch_args=["/usr/bin/open","--wait-apps","--new","--stdout",str(root/"actual-gui-probe.stdout"),
        "--stderr",str(root/"actual-gui-probe.stderr"),str(app),"--args",str(root/"actual-cloud-preflight.json"),
        str(root/"gui-metal-comparison.json")]
    with (out/"actual-launch.stdout").open("wb") as stdout,(out/"actual-launch.stderr").open("wb") as stderr:
        launcher=subprocess.Popen(launch_args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
    target_bound=time.monotonic()+20
    while not start_file.exists():
        assert launcher.poll() is None,"LaunchServices exited before real target announcement"
        assert time.monotonic()<target_bound,"Owned GUI target did not announce within20s"
        time.sleep(0.05)
    target=json.loads(start_file.read_text())
    pid=target["actualPID"]
    assert isinstance(pid,int) and pid>1 and target["uid"]==os.getuid()
    assert target["runID"]==os.environ["GITHUB_RUN_ID"] and abs(time.time()-target["at"])<20
    assert target["bundleIdentifier"]=="org.ai-live-commerce.cloud-metal-control"
    assert pathlib.Path(target["bundlePath"]).resolve()==app.resolve()
    expected=app/"Contents/MacOS/CloudMetalControl"
    assert pathlib.Path(target["executablePath"]).resolve()==expected.resolve()
    actual_ps=subprocess.check_output(["ps","-p",str(pid),"-o","uid=","-o","comm="],text=True).strip()
    uid_text,path_text=actual_ps.split(maxsplit=1)
    assert int(uid_text)==os.getuid() and pathlib.Path(path_text).resolve()==expected.resolve(),actual_ps
    result["actualOwnedTarget"]=target;result["actualOwnershipPS"]=actual_ps
    trace=out/"actual-owned-gui-metal.trace"
    args=["xcrun","xctrace","record","--template",template,"--attach",str(pid),
        "--time-limit","45s","--output",str(trace)]
    if "--no-prompt" in help_text:args.append("--no-prompt")
    result["recordArgs"]=args;result["recordStartWall"]=time.time()
    record_start=time.monotonic()
    with (out/"record.stdout").open("wb") as stdout,(out/"record.stderr").open("wb") as stderr:
        recorder=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
    announcement_end=time.monotonic()+20
    while True:
        assert recorder.poll() is None,"Profiler exited before announcing any recording attempt"
        text=(out/"record.stdout").read_text(errors="replace")
        if "Starting recording with" in text and template in text:break
        if time.monotonic()>=announcement_end:
            result["actualAnnouncementDeadlineExceededWall"]=time.time();save()
            capture_owned_profiler_stacks(recorder.pid,"startup")
            raise AssertionError("Profiler did not announce within20s; actual owned startup stacks retained, no work released")
        time.sleep(0.05)
    result["actualAttemptAnnouncement"]=text;result["workReleasedWall"]=time.time()
    gate.write_text(json.dumps({"releaseReason":"Actual xctrace stdout announced a recording attempt; not proof of active/usable trace",
        "profilerPID":recorder.pid,"at":time.time()},indent=2))
    save()
    launcher.wait(timeout=100)
    result["launchReturnCode"]=launcher.returncode
    assert launcher.returncode==0,"Actual LaunchServices wait failed"
    result["targetFinishedWall"]=time.time()
    try:os.kill(pid,0)
    except ProcessLookupError:result["actualOwnedTargetExited"]=True
    else:raise AssertionError("Owned target PID still exists after normal app quit")
    probe=json.loads((root/"gui-metal-comparison.json").read_text())
    assert probe.get("completed") is True and probe.get("notPerformanceAcceptance") is True and len(probe.get("phases",[]))==1
    assert probe.get("originalRequestedQoSRestoreStatus")==0,"Restore original independent worker pthread QoS"
    result["actualProbePhaseStrictPass"]=probe.get("allThirtyFPSDeadlinesAndGPUChecksPassed") is True
    result["actualProbeSummary"]={k:v for k,v in probe["phases"][0].items() if k not in ["samples","actualSchedulingSamples"]}
    remaining=max(0.1,90-(time.monotonic()-record_start))
    timed_out=False
    try:recorder.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        timed_out=True
        result["actualRecordDeadlineExceededWall"]=time.time();save()
        capture_owned_profiler_stacks(recorder.pid,"record-stopping")
        recorder.send_signal(signal.SIGINT)
        try:recorder.wait(timeout=15)
        except subprocess.TimeoutExpired:recorder.kill();recorder.wait(timeout=10)
    result["recordReturnCode"]=recorder.returncode;result["recordTimedOut"]=timed_out
    result["recordFinishedWall"]=time.time();result["traceExists"]=trace.exists()
    save()
    assert recorder.returncode==0 and not timed_out and trace.exists(),"Actual owned-target trace did not finish; partial data retained, not accepted"
    toc=out/"actual-toc.xml"
    meta,text=command(["xcrun","xctrace","export","--input",str(trace),"--toc","--output",str(toc)],"export-toc")
    assert meta["returncode"]==0 and not meta["timedOut"] and toc.exists(),text
    tree=ET.parse(toc)
    schemas=sorted({x.attrib["schema"] for x in tree.iter() if x.tag.rsplit("}",1)[-1]=="table" and "schema" in x.attrib})
    result["actualSchemas"]=schemas
    selected=[s for s in schemas if any(t in s.lower() for t in
        ["gpu","metal","thread","process-info","scheduling","sched","context","syscall","system-call","time-info","time-profile","time-sample"])]
    assert any("gpu" in s.lower() or "metal" in s.lower() for s in selected),"No actual published GPU schema; not fabricated"
    gpu_rows=0;scheduling_rows=0
    for i,schema in enumerate(selected):
        assert "'" not in schema
        xml=out/("actual-table-"+str(i)+".xml")
        xpath="//run/data/table[@schema='"+schema+"']"
        meta,text=command(["xcrun","xctrace","export","--input",str(trace),"--xpath",xpath,"--output",str(xml)],"export-table-"+str(i))
        item={"actualSchema":schema,"file":xml.name,"command":meta,"actualRowCount":None}
        result["exports"].append(item);save()
        assert meta["returncode"]==0 and not meta["timedOut"] and xml.exists(),text
        item["actualRowCount"]=sum(x.tag.rsplit("}",1)[-1]=="row" for x in ET.parse(xml).getroot().iter())
        if "gpu" in schema.lower() or "metal" in schema.lower():gpu_rows+=item["actualRowCount"]
        if any(t in schema.lower() for t in ["thread-state","sched","context-switch","thread-wait"]):
            scheduling_rows+=item["actualRowCount"]
    result["actualGPUishRowCount"]=gpu_rows
    result["actualSchedulingNamedRowCount"]=scheduling_rows
    result["GPUishRowsAreNotProofOfHardwareExecutionIntervals"]=True
    assert gpu_rows>0,"Actual exported GPU tables contain no rows; insufficient evidence"
    if template=="Game Performance":
        assert scheduling_rows>0,"No actual scheduling/state rows; missing evidence is not fabricated"
    result["traceUsable"]=True;result["completed"]=True;save()
    print(json.dumps(result,indent=2))
    assert result["actualProbePhaseStrictPass"],"Actual traced phase missed original GPU/deadline gate; forensic trace never substitutes for product acceptance"
except BaseException as e:
    result["error"]=repr(e);save();print(json.dumps(result,indent=2));raise
finally:
    if recorder is not None and recorder.poll() is None:
        recorder.send_signal(signal.SIGINT)
        try:recorder.wait(timeout=15)
        except subprocess.TimeoutExpired:recorder.kill();recorder.wait(timeout=10)
    if launcher is not None and launcher.poll() is None:
        # No force-kill of a target or foreign process: own one-stage app exits itself.
        try:launcher.wait(timeout=75)
        except subprocess.TimeoutExpired:
            result["normalTargetQuitNotObserved"]=True;save()
    if recorder is not None:result["actualFinalRecorderReturnCode"]=recorder.returncode
    if launcher is not None:result["actualFinalLaunchReturnCode"]=launcher.returncode
    target=result.get("actualOwnedTarget",{}).get("actualPID")
    if target:
        try:os.kill(target,0)
        except ProcessLookupError:result["actualFinalOwnedTargetPIDGone"]=True
        except OSError as e:result["actualFinalTargetQueryError"]=repr(e)
        else:result["actualFinalOwnedTargetPIDGone"]=False
    save()
