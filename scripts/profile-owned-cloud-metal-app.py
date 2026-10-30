#!/usr/bin/env python3
"""Cloud forensic xctrace attaches ONLY the exact independently built GUI probe PID.
Never product acceptance. No security/entitlement changes, all-process capture, or
profiler/target circular wait: the one-stage target quits normally after 60 seconds.
"""
import pathlib,os,sys,json,subprocess,time,signal,platform,xml.etree.ElementTree as ET
import ctypes,ctypes.util,select,struct,uuid,bisect
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
    assert phase in ["startup","record-stopping","record-started"]
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
    entry={"phase":phase,"actualProcessTree":actual,"actualStackAttempts":[],"actualPriorityAttempts":[]}
    result.setdefault("actualProfilerProcessEvidence",[]).append(entry);save()
    for i,row in enumerate(actual[:3]):
        # Recheck this exact process identity immediately before a read-only stack sample.
        current=subprocess.run(["ps","-p",str(row["pid"]),"-o","ppid=","-o","uid=","-o","comm="],
            capture_output=True,text=True,timeout=5)
        fields=current.stdout.strip().split(maxsplit=2)
        if current.returncode!=0 or len(fields)!=3 or int(fields[0])!=row["ppid"] or int(fields[1])!=row["uid"] or fields[2]!=row["executable"]:
            entry["actualStackAttempts"].append({"process":row,"skipped":"actual process identity exited or changed"});save();continue
        priority_name="actual-priority-"+phase+"-"+str(i)
        meta,priority_text=command([str(root/"inspect-owned-profiler-priorities"),str(row["pid"]),
            row["executable"],str(row["ppid"])],priority_name,timeout=8)
        entry["actualPriorityAttempts"].append({"process":row,"command":meta,"output":priority_name+".stdout"})
        save()
        if phase=="record-started":
            assert meta["returncode"]==0 and not meta["timedOut"],"Actual owned-profiler priority read failed"
            snapshots=[json.loads(line) for line in (out/(priority_name+".stdout")).read_text().splitlines()]
            samples=[x for x in snapshots if x.get("event")=="thread-sample"]
            assert len(samples)==1 and samples[0]["ownedPID"]==row["pid"] and samples[0]["uid"]==os.getuid()
            if row["pid"]==owned_root:
                maxima=[x["maxPriority"] for x in samples[0]["threads"] if "maxPriority" in x]
                result["actualProfilerRootMaxPriorities"]=sorted(set(maxima));save()
                assert maxima and max(maxima)>20,"Actual profiler still at20 maximum; changed collector context not established"
            continue
        target=out/("actual-profiler-"+phase+"-stack-"+str(i)+".txt")
        # Exact sample syntax already exercised by the cloud OBS diagnostic launcher.
        meta,text=command(["/usr/bin/sample",str(row["pid"]),"2","1","-file",str(target)],
            "sample-profiler-"+phase+"-"+str(i),timeout=8)
        entry["actualStackAttempts"].append({"process":row,"command":meta,
            "actualStackFile":target.name,"actualStackExists":target.exists()});save()
launcher=None;recorder=None;notify_lib=None;notify_token=None
try:
    assert os.environ.get("AI_LIVE_COLLECTOR_LAUNCH_CONTEXT")=="launchservices-host","Explicit isolated collector host only"
    host_file=root/"actual-profiler-host.json"
    host_bound=time.monotonic()+5
    while True:
        host=json.loads(host_file.read_text()) if host_file.exists() else {}
        if host.get("actualPythonPID")==os.getpid():break
        assert time.monotonic()<host_bound,"No actual current host/Python ownership"
        time.sleep(0.02)
    assert host["runID"]==os.environ["GITHUB_RUN_ID"] and host["uid"]==os.getuid()
    assert host["actualHostPID"]==os.getppid() and abs(time.time()-host["at"])<30
    expected_host=root/"CloudProfilerHost.app/Contents/MacOS/CloudProfilerHost"
    assert pathlib.Path(host["actualHostExecutable"]).resolve()==expected_host.resolve()
    host_ps=subprocess.check_output(["ps","-p",str(os.getppid()),"-o","uid=","-o","comm="],text=True).strip().split(maxsplit=1)
    assert int(host_ps[0])==os.getuid() and pathlib.Path(host_ps[1]).resolve()==expected_host.resolve()
    assert pathlib.Path(host["actualScript"]).resolve()==pathlib.Path(__file__).resolve()
    assert pathlib.Path(host["actualPythonPath"]).resolve()==pathlib.Path(sys.executable).resolve()
    baseline_identity=json.loads((root/"actual-direct-cli-identity.json").read_text())
    assert baseline_identity["runID"]==os.environ["GITHUB_RUN_ID"] and baseline_identity["exit"]==0
    assert abs(time.time()-baseline_identity["at"])<120
    result["actualDirectCLIBaselineIdentity"]=baseline_identity
    result["actualLaunchServicesCollectorHost"]=host
    meta,text=command([str(root/"inspect-owned-profiler-priorities"),str(os.getpid()),sys.executable,
        str(os.getppid())],"actual-hosted-python-priorities",timeout=8)
    assert meta["returncode"]==0 and not meta["timedOut"]
    hosted=[json.loads(x) for x in (out/"actual-hosted-python-priorities.stdout").read_text().splitlines() if x]
    hosted_samples=[x for x in hosted if x.get("event")=="thread-sample"]
    direct=[json.loads(x) for x in (root/"actual-direct-cli-priorities.jsonl").read_text().splitlines() if x]
    direct_samples=[x for x in direct if x.get("event")=="thread-sample"]
    assert len(hosted_samples)==1 and len(direct_samples)==1
    hosted_max=sorted(set(x["maxPriority"] for x in hosted_samples[0]["threads"] if "maxPriority" in x))
    direct_max=sorted(set(x["maxPriority"] for x in direct_samples[0]["threads"] if "maxPriority" in x))
    result["actualCollectorMaximumComparison"]={"directCLI":direct_max,"launchServicesChildPython":hosted_max,
        "readOnly":True,"notProductAcceptance":True};save()
    assert direct_max and max(direct_max)==20 and hosted_max and max(hosted_max)>20,"The hypothesized inherited20 collector limit was not established; no trace reattempt"
    _,help_text=command(["xcrun","xctrace","help","record"],"record-help")
    _,export_help=command(["xcrun","xctrace","help","export"],"export-help")
    _,templates=command(["xcrun","xctrace","list","templates"],"actual-templates")
    command(["codesign","-d","--verbose=4",str(app)],"actual-probe-signature")
    assert template in templates
    for option in ["--attach","--template","--time-limit","--output","--window","--notify-tracing-started"]:assert option in help_text
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
    # Public Darwin file-descriptor delivery has an exact network-order token.
    # notify_check is intentionally not used: Apple's contract permits false positives.
    system_library=ctypes.util.find_library("System")
    assert system_library,"Actual public System library not found"
    notify_lib=ctypes.CDLL(system_library)
    notify_lib.notify_register_file_descriptor.argtypes=[ctypes.c_char_p,ctypes.POINTER(ctypes.c_int),ctypes.c_int,ctypes.POINTER(ctypes.c_int)]
    notify_lib.notify_register_file_descriptor.restype=ctypes.c_uint32
    notify_lib.notify_cancel.argtypes=[ctypes.c_int];notify_lib.notify_cancel.restype=ctypes.c_uint32
    notification_name="org.ai-live-commerce.profiler.started."+os.environ["GITHUB_RUN_ID"]+"."+str(pid)+"."+uuid.uuid4().hex
    notification_fd=ctypes.c_int(-1);token=ctypes.c_int(-1)
    registration=notify_lib.notify_register_file_descriptor(notification_name.encode("ascii"),ctypes.byref(notification_fd),0,ctypes.byref(token))
    result["actualStartedNotificationRegistration"]={"name":notification_name,"status":registration,
        "fd":notification_fd.value,"token":token.value,"systemLibrary":system_library}
    assert registration==0 and notification_fd.value>=0 and token.value>=0
    notify_token=token.value
    assert not select.select([notification_fd.value],[],[],0)[0],"Unexpected event before owned profiler launch"
    trace=out/"actual-owned-gui-metal.trace"
    args=["xcrun","xctrace","record","--template",template,"--attach",str(pid),
        "--time-limit","45s","--notify-tracing-started",notification_name,"--output",str(trace)]
    if template=="Game Performance":
        args+=["--window","45s"]
    else:
        # Actual public Thread State Trace instrument; retain Metal template's Deferred mode.
        assert "--instrument" in help_text
        args+=["--instrument","Thread State Trace"]
        result["actualAddedInstruments"]=["Thread State Trace"]
    if "--no-prompt" in help_text:args.append("--no-prompt")
    result["recordArgs"]=args;result["recordStartWall"]=time.time()
    record_start=time.monotonic()
    with (out/"record.stdout").open("wb") as stdout,(out/"record.stderr").open("wb") as stderr:
        recorder=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
    announcement_end=time.monotonic()+20
    actual_announcement=None;notification_bytes=b""
    while True:
        assert recorder.poll() is None,"Profiler exited before announcing any recording attempt"
        text=(out/"record.stdout").read_text(errors="replace")
        if "Starting recording with" in text and template in text:actual_announcement=text
        if len(notification_bytes)<4 and select.select([notification_fd.value],[],[],0)[0]:
            notification_bytes+=os.read(notification_fd.value,4-len(notification_bytes))
        if len(notification_bytes)==4:
            received=struct.unpack("!I",notification_bytes)[0]
            assert received==notify_token,("Actual notification token mismatch",received,notify_token)
            result["actualStartedNotificationReceived"]={"token":received,"at":time.time(),
                "monotonic":time.monotonic(),"rawBytesHex":notification_bytes.hex()}
        if actual_announcement is not None and len(notification_bytes)==4:break
        if time.monotonic()>=announcement_end:
            result["actualAnnouncementDeadlineExceededWall"]=time.time();save()
            capture_owned_profiler_stacks(recorder.pid,"startup")
            raise AssertionError("Profiler did not announce AND send actual started FD notification within original20s; owned startup stacks retained, no work released")
        time.sleep(0.05)
    cancel_status=notify_lib.notify_cancel(notify_token)
    result["actualStartedNotificationCancelStatus"]=cancel_status;notify_token=None
    assert cancel_status==0,"Owned notification registration cleanup failed"
    capture_owned_profiler_stacks(recorder.pid,"record-started")
    result["actualAttemptAnnouncement"]=actual_announcement;result["workReleasedWall"]=time.time()
    gate.write_text(json.dumps({"releaseReason":"Actual own xctrace announcement AND matching Darwin started-notification FD token received; exported fault coverage still required",
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
    result["actualRecordingMode"]=tree.findtext(".//recording-mode")
    if template=="Metal System Trace":
        assert result["actualRecordingMode"]=="Deferred","Actual recording mode changed; do not infer full fault coverage"
    schemas=sorted({x.attrib["schema"] for x in tree.iter() if x.tag.rsplit("}",1)[-1]=="table" and "schema" in x.attrib})
    result["actualSchemas"]=schemas
    selected=[s for s in schemas if any(t in s.lower() for t in
        ["gpu","metal","thread","process-info","scheduling","sched","context","syscall","system-call","time-info","time-profile","time-sample"])]
    assert any("gpu" in s.lower() or "metal" in s.lower() for s in selected),"No actual published GPU schema; not fabricated"
    gpu_rows=0;scheduling_rows=0
    for i,schema in enumerate(selected):
        assert "'" not in schema
        print("Exporting actual published schema:",schema,flush=True)
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
    assert scheduling_rows>0,"No actual scheduling/state rows; missing evidence is not fabricated"
    # Validate actual captured fault coverage using published schema/clock data.
    by_schema={x["actualSchema"]:out/x["file"] for x in result["exports"]}
    for required in ["time-info","metal-application-command-buffer-submissions","metal-command-buffer-completed"]:
        assert required in by_schema,("Missing actual published coverage table",required)
    clock=ET.parse(by_schema["time-info"]).getroot()
    epoch_ticks=int(clock.find(".//mach-absolute-time").text)
    timebase=[int(x.text) for x in clock.findall(".//mach-timebase-info/mach-timebase-info-field")]
    assert len(timebase)==2 and min(timebase)>0
    epoch_seconds=epoch_ticks*timebase[0]/timebase[1]/1e9
    def actual_rows(path):
        xml=ET.parse(path).getroot();ids={x.get("id"):x for x in xml.iter() if x.get("id")}
        columns=[x.findtext("mnemonic") for x in xml.find(".//schema").findall("col")]
        def resolve(x):return ids[x.get("ref")] if x.get("ref") else x
        return [{k:resolve(x) for k,x in zip(columns,row)} for row in xml.iter("row")]
    creations=actual_rows(by_schema["metal-application-command-buffer-submissions"])
    completions=actual_rows(by_schema["metal-command-buffer-completed"])
    done={int(x["cmdbuffer-id"].text):int(x["timestamp"].text)/1e9 for x in completions}
    index={k:i for i,k in enumerate(probe["columns"])};samples=probe["phases"][0]["samples"]
    starts=[x[index["cpuStart"]] for x in samples];captured={}
    for x in creations:
        if x["process"].get("fmt")!=("CloudMetalControl ("+str(pid)+")"):continue
        actual_creation=int(x["start"].text)/1e9+epoch_seconds
        i=bisect.bisect_right(starts,actual_creation)-1
        if i<0 or actual_creation>samples[i][index["cpuCommit"]]:continue
        cb=int(x["cmdbuffer-id"].text);completion=done.get(cb)
        row=samples[i]
        if completion is not None and row[index["gpuEnd"]]-epoch_seconds<=completion<=row[index["cpuCompleted"]]-epoch_seconds:
            captured[i]={"frame":row[index["frame"]],"actualCommandBufferID":hex(cb),
                "actualCreationTraceSeconds":actual_creation-epoch_seconds,"actualCompletionTraceSeconds":completion}
    slow=[i for i,x in enumerate(samples) if x[index["gpuEnd"]]-x[index["gpuStart"]]>1/30]
    result["actualFaultCoverage"]={"clockEpochTicks":epoch_ticks,"timebase":timebase,"epochSeconds":epoch_seconds,
        "actualMatchedCommandBuffers":len(captured),"allRawSlowGPUFrames":slow,
        "capturedSlowGPUCommands":[captured[i] for i in slow if i in captured],
        "uncapturedSlowGPUFrames":[i for i in slow if i not in captured],
        "notProductAcceptance":True}
    save()
    assert result["actualFaultCoverage"]["capturedSlowGPUCommands"],"No actual slow GPU command fully covered; trace is insufficient for slow-frame diagnosis"
    result["traceUsable"]=True;result["completed"]=True;save()
    print(json.dumps(result,indent=2))
    assert result["actualProbePhaseStrictPass"],"Actual traced phase missed original GPU/deadline gate; forensic trace never substitutes for product acceptance"
except BaseException as e:
    result["error"]=repr(e);save();print(json.dumps(result,indent=2));raise
finally:
    if notify_lib is not None and notify_token is not None:
        result["actualStartedNotificationFinalCancelStatus"]=notify_lib.notify_cancel(notify_token)
        notify_token=None
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
