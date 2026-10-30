#!/usr/bin/env python3
"""Same-binary native minimal color discriminator; every original acceptance failure remains a failure."""
import os,sys,pathlib,json,platform,hashlib,subprocess,time,re
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin" and platform.machine()=="arm64"
root=pathlib.Path("/tmp/ai-live-real-obs");root.mkdir(parents=True,exist_ok=True)
flag=pathlib.Path("/tmp/ai-live-ci-private-window-target")
provenance=json.loads((pathlib.Path(os.environ["AI_LIVE_OBS_COPY_EVIDENCE"])/"module-provenance.json").read_text())
components={"experimentalExecutableSHA256":"Contents/MacOS/OBS",
            "experimentalModuleSHA256":"Contents/PlugIns/obs-browser.plugin/Contents/MacOS/obs-browser",
            "experimentalMetalSHA256":"Contents/Frameworks/libobs-metal.dylib",
            "experimentalQtGuiSHA256":"Contents/Frameworks/QtGui.framework/Versions/A/QtGui"}
def hashes():
    actual={key:hashlib.sha256((pathlib.Path("/Applications/OBS.app")/path).read_bytes()).hexdigest() for key,path in components.items()}
    for key,value in actual.items():assert value==provenance[key],key
    return actual
results=[]
single_private=os.environ.get("AI_LIVE_OBS_SINGLE_PRIVATE")=="true"
default_policy=os.environ.get("AI_LIVE_OBS_DEFAULT_SOURCE_POLICY")=="true"
cases=[("window-b-private",2)] if single_private else [("window-a-default",1),("window-b-private",2),("window-a2-default",1)]
try:
    for label,mode in cases:
        if default_policy:
            assert mode==2
            assert not flag.exists(),"Default private target still relies on test selector"
            assert not pathlib.Path('/tmp/ai-live-ci-unoptimized-cpu-upload').exists()
        elif mode==2:flag.write_text("Only this isolated cloud diagnostic selects private GPU-only display targets.\n")
        else:flag.unlink(missing_ok=True)
        directory=root/label;directory.mkdir(exist_ok=True)
        env=os.environ.copy();env["AI_LIVE_OBS_LOG_DIR"]=str(directory);env["AI_LIVE_OBS_EXPECT_WINDOW_STORAGE"]=str(mode)
        before=hashes();owned_pid=None
        proc=subprocess.Popen(["bash","scripts/run-real-obs-macos-ci.sh"],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        with (directory/"actual-run.log").open("w") as output:
            capture_pending=False
            for line in proc.stdout:
                output.write(line);output.flush();sys.stdout.write(line);sys.stdout.flush()
                if "Waiting LaunchServices official OBS WebSocket (attempt 30/50)" in line:capture_pending=True
                observed=re.search(r"^\s*(\d+)\s+\d+\s+\S+\s+/Applications/OBS[.]app/Contents/MacOS/OBS .*--profile AI-Live-CI --collection AI-Live-CI(?: |$)",line)
                if capture_pending and observed:
                    capture_pending=False
                    observed_pid=int(observed.group(1))
                    status=subprocess.run(["/tmp/ai-live-inspect-owned-obs",str(observed_pid),"status"],capture_output=True,text=True,timeout=10)
                    screenshot=subprocess.run(["/usr/sbin/screencapture","-x",str(directory/"actual-startup-stall.png")],capture_output=True,text=True,timeout=10)
                    sample=subprocess.run(["/usr/bin/sample",str(observed_pid),"3","1","-file",str(directory/"actual-startup-stall-threads.txt")],capture_output=True,text=True,timeout=15)
                    (directory/"actual-startup-stall-status.json").write_text(json.dumps({
                        "observedExactTestProfilePID":observed_pid,"appStatusExit":status.returncode,"appStatus":status.stdout,"appStatusError":status.stderr,
                        "screenshotExit":screenshot.returncode,"screenshotError":screenshot.stderr,
                        "sampleExit":sample.returncode,"sampleOutput":sample.stdout,"sampleError":sample.stderr},indent=2))

                found=re.search(r"PASS: official Mac OBS WebSocket is listening; app PID=(\d+)",line)
                if found:owned_pid=int(found.group(1))
        media_exit=proc.wait()
        report_path=directory/"render-comparison.json"
        report=json.loads(report_path.read_text()) if report_path.exists() else {}
        if report.get("ownedObsPID"):
            assert report["ownedObsPID"]==owned_pid,"Actual owned process identity disagrees"
        assert report.get("gracefulCloudExit",{}).get("normalQuitAccepted") is True,"Previous OBS was not normally quit; do not start another ambiguous comparison"
        assert report.get("gracefulCloudExit",{}).get("actualTerminated") is True
        # Never overlap two owned OBS/CEF sessions. The existing runner already stopped its exact PID.
        assert owned_pid and owned_pid>1,"No actual owned OBS PID; refuse ambiguous next cold comparison"
        ended=False
        for _ in range(60):
            try:os.kill(owned_pid,0)
            except ProcessLookupError:ended=True;break
            time.sleep(0.25)
        assert ended,"Owned OBS did not actually exit; no further variant started"
        phases=report.get("phases",[])
        qos_ok=True
        if os.environ.get("AI_LIVE_OBS_THREAD_QOS_TRACE")=="true":
            qos={"purpose":"Read-only requested QoS captured on the actual OBS GPU submitting thread; not effective kernel override priority",
                 "actualOwnedOBSPID":owned_pid,"phases":[],"valid":False}
            try:
                assert len(phases)==6,"Actual original six phases missing"
                for phase in phases:
                    trace=json.loads((directory/(phase["label"]+"-readback-timings.json")).read_text())
                    records=trace["submissions"]["records"]
                    assert records,"No real submitting-thread observations"
                    counts={}
                    for row in records:
                        assert row["submittingRequestedQoSClass"] in ["user-interactive","user-initiated","default","utility","background","unspecified"],"Unknown actual requested QoS"
                        assert type(row["submittingFoundationQoS"]) is int
                        assert type(row["submittingIsMainThread"]) is bool
                        key=row["kind"]+" / "+row["submittingRequestedQoSClass"]+" / Foundation="+str(row["submittingFoundationQoS"])+" / main="+str(row["submittingIsMainThread"])
                        counts[key]=counts.get(key,0)+1
                    qos["phases"].append({"label":phase["label"],"actualSubmissions":len(records),"classesByKind":counts})
                qos["valid"]=True
            except Exception as e:
                qos_ok=False;qos["error"]=str(e)
            (directory/"actual-submitting-thread-qos.json").write_text(json.dumps(qos,indent=2))
            print("ACTUAL OBS SUBMITTING THREAD QOS:",json.dumps(qos),flush=True)
        strict=media_exit==0 and report.get("completed") is True and report.get("finalExitCode")==0 and qos_ok
        expected_labels=["fixed-pipeline-prime5","fixed-pipeline-static-carousel","minimal-color-control",
                         "native-numbered-control","restored-fixed-pipeline-prime5","restored-fixed-pipeline-static-carousel"]
        if os.environ.get("AI_LIVE_OBS_SUBMISSION_OBSERVER_ABA")=="true":
            expected_labels[2:2]=["counter-only-fixed-pipeline-prime5","counter-only-fixed-pipeline-static-carousel"]
            study=report.get("submissionObserverComparison",{})
            observed_cases=study.get("cases",[])
            assert [x["detailedSubmissionTrace"] for x in observed_cases]==[True,False,True],"Real observer A/B/A mode missing"
            assert [x["label"] for x in observed_cases]==["product-cef-first","product-cef-counter-only","product-cef-restored"]
            for case in observed_cases:
                for motion in case["motion"]:
                    observer=motion.get("gpuObserver")
                    assert observer and observer["detailed"]==case["detailedSubmissionTrace"]
                    assert observer["gpuErrors"]==0,"Actual GPU error remains failure in both observer modes"
        strict=strict and [x["label"] for x in phases]==expected_labels
        strict=strict and all(x["delta"]["renderSkippedFrames"]==0 and x["delta"]["outputSkippedFrames"]==0 for x in phases)
        result={"label":label,"expectedWindowStorage":mode,"mediaExit":media_exit,"allOriginalMediaAndZeroLossGatesPassed":strict,
                "actualOwnedOBSProcessExited":ended,"actualComponentHashesBefore":before,"actualComponentHashesAfter":hashes(),
                "actualPhaseDeltas":[{"label":x["label"],"elapsedMs":x["elapsedMs"],"delta":x["delta"]} for x in phases],
                "defaultSourcePolicyVerification":default_policy,
                "note":"Same process product CEF, native media, restored CEF retain every original gate. Native control cannot replace a failed product test."}
        (directory/"variant-verdict.json").write_text(json.dumps(result,indent=2))
        results.append(result);(root/"window-storage-comparison.json").write_text(json.dumps({"singlePrivateColdVerification":single_private,"sameExactBinarySameHostComparison":not single_private,"results":results},indent=2))
        print("ACTUAL WINDOW STORAGE VARIANT:",json.dumps(result),flush=True)
finally:
    flag.unlink(missing_ok=True)
    pathlib.Path('/tmp/ai-live-ci-unoptimized-cpu-upload').unlink(missing_ok=True)
assert len(results)==len(cases)
assert all(x["allOriginalMediaAndZeroLossGatesPassed"] for x in results),"Actual media, copy, queue or full-phase render/output failure remains a failed run"
