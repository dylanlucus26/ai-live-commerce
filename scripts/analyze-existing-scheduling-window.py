#!/usr/bin/env python3
"""Cloud-only objective timing readout from the already-verified immutable RAWv3.

This does NOT interpret private GPU commands or prove a physical host/driver
root cause. Trace run must have already completed its full 102,205,235-record
scan; the original target execution/profiler failure stays failed.
"""
import json,os,pathlib,sys,math
assert os.environ.get("GITHUB_ACTIONS")=="true","Evidence-only, isolated cloud run"
assert len(sys.argv)==2,"Pass the already-created evidence metadata directory"
root=pathlib.Path(sys.argv[1]).resolve()
source=json.loads((root/"actual-raw-container.json").read_text())
actual=source["actualSchedulingScan"]
assert source["completed"] is True and actual["completed"] is True
assert actual["actualRecords"]==102205235 and actual["actualEventChunks"]==44
assert actual["traceLostMarkers"]==0
assert actual["globalTimestampReversals"]==0 and actual["perCPUTimestampReversals"]==0
assert source["originalFailurePreserved"]["completed"] is False
assert source["originalFailurePreserved"]["traceUsable"] is False
numer=source["actualHeaderFields"]["timebaseNumer"]
denom=source["actualHeaderFields"]["timebaseDenom"]
assert (numer,denom)==(125,3)
clock=lambda ticks:int(ticks)*numer/(denom*1_000_000_000)
columns=source["actualOriginalFaultWindow"]["sourceColumns"]
fault=source["actualOriginalFaultWindow"]["originalFaultRows"]
assert len(fault)==2 and fault[0][columns.index("frame")]==0
frame=dict(zip(columns,fault[0]))
assert frame["status"]==4 and frame["errorCode"]==0 and frame["deadlineMet"]==0
assert frame["gpuStart"]<frame["gpuEnd"]<frame["cpuCompleted"]
assert frame["gpuEnd"]-frame["gpuStart"]>1/30
owned=source["actualOwnedInitialThreads"]
assert any(x["threadID"]=="11081" and x["pid"]==2093 for x in owned)
kernel={x["threadID"]:x["name"] for x in source["actualKernelCompletionThreads"]}
assert kernel["386"]=="IOGPU Completion" and kernel["389"]=="AppleParavirtGPU"

# Stable documented XNU scheduler IDs:
# code 0x0f -> base 0x0140003c MACH_BLOCK
# code 0x06 -> base 0x01400018 MACH_MAKE_RUNNABLE, arg1=target thread
# code 0x20 -> base 0x01400080 MACH_DISPATCH, event tid=dispatched thread
observed={"targetBlock":[],"targetWake":[],"targetDispatch":[],"kernelCompletionDispatch":[]}
begin,end=map(int,(source["actualSchedulingScan"]["windowBeginTicks"],
                   source["actualSchedulingScan"]["windowEndTicks"]))
for line in (root/"actual-window-events.jsonl").open():
    item=json.loads(line)
    tick=int(item["timestampTicks"])
    if not(begin<=tick<=end):continue
    moment=clock(tick)
    tid=int(item["threadID"])
    base=int(item["debugIDHex"],16)&~3
    if base==0x0140003c and tid==11081 and frame["cpuCommit"]<moment<frame["gpuStart"]:
        observed["targetBlock"].append({"seconds":moment,"tick":str(tick),"threadID":str(tid)})
    elif base==0x01400018 and int(item["arg1"])==11081 and frame["gpuEnd"]<moment<frame["cpuCompleted"]:
        observed["targetWake"].append({"seconds":moment,"tick":str(tick),
                                        "wakerThreadID":str(tid),"wokenThreadID":item["arg1"]})
    elif base==0x01400080 and tid==11081 and frame["gpuEnd"]<moment<frame["cpuCompleted"]:
        observed["targetDispatch"].append({"seconds":moment,"tick":str(tick),"threadID":str(tid)})
    elif base==0x01400080 and tid==386 and frame["gpuEnd"]-0.005<moment<frame["cpuCompleted"]:
        observed["kernelCompletionDispatch"].append({"seconds":moment,"tick":str(tick),"threadID":str(tid)})
assert all(len(observed[key])==1 for key in
           ("targetBlock","targetWake","targetDispatch","kernelCompletionDispatch")),observed
blocked=observed["targetBlock"][0]["seconds"]
woken=observed["targetWake"][0]["seconds"]
dispatch=observed["targetDispatch"][0]["seconds"]
kernelAt=observed["kernelCompletionDispatch"][0]["seconds"]
assert blocked<frame["gpuStart"]<frame["gpuEnd"]<woken<dispatch<frame["cpuCompleted"]
assert kernelAt<=woken
metrics={
 "GPUCommandMilliseconds":(frame["gpuEnd"]-frame["gpuStart"])*1000,
 "targetBlockedUntilRunnableMilliseconds":(woken-blocked)*1000,
 "runnableToDispatchedMilliseconds":(dispatch-woken)*1000,
 "GPUCompletedToRunnableMilliseconds":(woken-frame["gpuEnd"])*1000,
 "CPUCompletedPastDeadlineMilliseconds":(frame["cpuCompleted"]-frame["deadline"])*1000,
}
assert all(math.isfinite(x) and x>=0 for x in metrics.values())
report={
 "completed":True,"sourceRun":41142373996,
 "verifiedReadRun":41149759377,
 "sourceArtifact":13022078494,
 "readOnly":True,"notProductAcceptance":True,
 "originalProfileFailurePreserved":True,"faultFrame":frame["frame"],
 "sourceTimebase":{"numerator":numer,"denominator":denom},
 "sourceEventsFullyScanned":actual["actualRecords"],
 "lostMarkers":actual["traceLostMarkers"],
 "observedEvents":observed,"elapsedMilliseconds":metrics,
 "limits":"Only a documented scheduler event order around this particular slow frame. This does not prove an opaque wait token's identity or the hardware/VM GPU root cause.",
 "sourceDocs":"https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/kdebug.h",
}
(root/"actual-fault-scheduling-timeline.json").write_text(json.dumps(report,indent=2)+"\n")
print("ACTUAL VERIFIED SCHEDULING WINDOW",json.dumps(report))
