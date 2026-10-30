#!/usr/bin/env python3
"""Exact-binary same-host cold A/B/A window storage diagnostic. All original failures remain failures."""
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
cases=[("window-b-private",2)] if single_private else [("window-a-default",1),("window-b-private",2),("window-a2-default",1)]
try:
    for label,mode in cases:
        if mode==2:flag.write_text("Only this isolated cloud diagnostic selects private GPU-only display targets.\n")
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
        strict=media_exit==0 and report.get("completed") is True and report.get("finalExitCode")==0
        strict=strict and len(phases)==2 and all(x["delta"]["renderSkippedFrames"]==0 and x["delta"]["outputSkippedFrames"]==0 for x in phases)
        result={"label":label,"expectedWindowStorage":mode,"mediaExit":media_exit,"allOriginalMediaAndZeroLossGatesPassed":strict,
                "actualOwnedOBSProcessExited":ended,"actualComponentHashesBefore":before,"actualComponentHashesAfter":hashes(),
                "actualPhaseDeltas":[{"label":x["label"],"elapsedMs":x["elapsedMs"],"delta":x["delta"]} for x in phases],
                "note":("Isolated first cold start only; not paired causality or shipping/default activation." if single_private else "Paired diagnostic only; independent cold verification and default activation remain required.")}
        (directory/"variant-verdict.json").write_text(json.dumps(result,indent=2))
        results.append(result);(root/"window-storage-comparison.json").write_text(json.dumps({"singlePrivateColdVerification":single_private,"sameExactBinarySameHostComparison":not single_private,"results":results},indent=2))
        print("ACTUAL WINDOW STORAGE VARIANT:",json.dumps(result),flush=True)
finally:
    flag.unlink(missing_ok=True)
assert len(results)==len(cases)
assert all(x["allOriginalMediaAndZeroLossGatesPassed"] for x in results),"Actual media, copy, queue or full-phase render/output failure remains a failed run"
