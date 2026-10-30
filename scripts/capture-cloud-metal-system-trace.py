#!/usr/bin/env python3
"""Cloud-only observed xctrace capability check and system-level Metal evidence. Never acceptance."""
import os,sys,pathlib,subprocess,json,platform,time,threading,signal,xml.etree.ElementTree as ET
assert os.environ.get("GITHUB_ACTIONS")=="true" and platform.system()=="Darwin"
root=pathlib.Path(os.environ["AI_LIVE_OBS_LOG_DIR"]);root.mkdir(parents=True,exist_ok=True)
out=root/"system-trace";out.mkdir(exist_ok=True)
def command(args,name,timeout=30):
    # Persist output as it arrives, including xctrace first-launch or stopping failures.
    with (out/(name+".stdout")).open("wb") as stdout,(out/(name+".stderr")).open("wb") as stderr:
        p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
        timed_out=False
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out=True
            p.send_signal(signal.SIGINT)
            try: p.wait(timeout=15)
            except subprocess.TimeoutExpired: p.kill();p.wait(timeout=10)
    text=(out/(name+".stdout")).read_text(errors="replace")+(out/(name+".stderr")).read_text(errors="replace")
    (out/(name+".command.json")).write_text(json.dumps({"args":args,"returncode":p.returncode,"timedOut":timed_out},indent=2))
    p.ci_timed_out=timed_out
    if timed_out: text+="\\nActual diagnostic command exceeded its bound; this is not a product timeout or success."
    return p,text
def preflight():
    observations={}
    for args,name in [(["xcrun","xctrace","help"],"help"),(["xcrun","xctrace","help","record"],"record-help"),
                      (["xcrun","xctrace","help","export"],"export-help"),(["xcrun","xctrace","list","templates"],"templates")]:
        p,text=command(args,name);observations[name]={"returncode":p.returncode,"text":text}
    for args,name in [(["system_profiler","SPDisplaysDataType"],"actual-displays"),
                      (["vm_stat"],"actual-vm-before"),(["sysctl","vm.swapusage"],"actual-swap-before")]:
        p,text=command(args,name);observations[name]={"returncode":p.returncode,"text":text}
    (out/"preflight.json").write_text(json.dumps(observations,indent=2))
    print(json.dumps(observations))
    return observations
if sys.argv[1]=="preflight":
    observations=preflight()
    help_text=observations["record-help"]["text"]
    assert "Metal System Trace" in observations["templates"]["text"]
    for option in ["--template","--all-processes","--time-limit","--output"]:
        assert option in help_text
    warm=["xcrun","xctrace","record","--template","Metal System Trace","--all-processes",
          "--time-limit","1s","--output",str(out/"profiler-initialization.trace")]
    if "--no-prompt" in help_text:warm.append("--no-prompt")
    p,text=command(warm,"profiler-initialization",timeout=240)
    print(json.dumps({"profilerInitializationReturncode":p.returncode,"text":text}))
    assert p.returncode==0 and not p.ci_timed_out,"Actual profiler initialization failed before OBS launch; not a product regression"
    sys.exit(0)
assert sys.argv[1]=="record"
observations=json.loads((out/"preflight.json").read_text())
record_help=observations["record-help"]["text"]
export_help=observations["export-help"]["text"]
templates=observations["templates"]["text"]
assert "Metal System Trace" in templates,"Actual Xcode template inventory does not provide Metal System Trace"
for option in ["--template","--all-processes","--time-limit","--output"]:
    assert option in record_help,("Actual xctrace record contract missing",option)
label=sys.argv[2];assert label=="fixed-pipeline-prime5"
trigger=out/"actual-measure-trigger.json"
deadline=time.monotonic()+150
while not trigger.exists():
    assert time.monotonic()<deadline,"Actual owned measurement never started; no trace or acceptance fabricated"
    time.sleep(0.1)
actual_trigger=json.loads(trigger.read_text())
assert actual_trigger["label"]==label and actual_trigger["pid"]>0
trace=out/(label+".trace")
args=["xcrun","xctrace","record","--template","Metal System Trace","--all-processes",
      "--time-limit","45s","--output",str(trace)]
if "--no-prompt" in record_help:args.append("--no-prompt")
stopped=threading.Event()
def sample():
    with (out/"actual-process-vm-samples.jsonl").open("w") as f:
        while not stopped.is_set():
            item={"wallTime":time.time(),"monotonic":time.monotonic()}
            for key,args in [("processes",["ps","-axo","pid,ppid,%cpu,%mem,state,comm"]),
                             ("vm",["vm_stat"]),("swap",["sysctl","vm.swapusage"])]:
                p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                item[key]={"returncode":p.returncode,"stdout":p.stdout.decode(errors="replace"),"stderr":p.stderr.decode(errors="replace")}
            f.write(json.dumps(item)+"\n");f.flush()
            stopped.wait(1)
thread=threading.Thread(target=sample,daemon=True);thread.start()
start=time.time()
try:
    p,text=command(args,"record",timeout=90)
finally:
    stopped.set();thread.join(timeout=10)
result={"purpose":"system-profile-evidence-only-not-acceptance","args":args,"startedAt":start,"endedAt":time.time(),
        "returncode":p.returncode,"traceExists":trace.exists(),"recordText":text,"actualMeasurementTrigger":actual_trigger,"exports":[]}
(out/"result.json").write_text(json.dumps(result,indent=2))
print(json.dumps(result))
assert p.returncode==0 and not p.ci_timed_out and trace.exists(),"Actual Metal system trace failed; retain error, never fabricate a trace"
for option in ["--input","--toc","--xpath","--output"]:
    assert option in export_help,("Actual xctrace export contract missing",option)
toc=out/"toc.xml"
p,text=command(["xcrun","xctrace","export","--input",str(trace),"--toc","--output",str(toc)],"export-toc",timeout=45)
assert p.returncode==0 and toc.exists(),text
tree=ET.parse(toc)
schemas=sorted({x.attrib["schema"] for x in tree.iter("table") if "schema" in x.attrib})
result["actualSchemas"]=schemas
# Select only actual published schemas. Keep the full trace for any missing schema; do not invent field names.
selected=[s for s in schemas if any(word in s.lower() for word in ["gpu","metal","thread-state","process-info","system-load","scheduling"])]
for i,schema in enumerate(selected):
    assert "'" not in schema
    target=out/("table-"+str(i)+".xml")
    xpath="//run/data/table[@schema='"+schema+"']"
    p,text=command(["xcrun","xctrace","export","--input",str(trace),"--xpath",xpath,"--output",str(target)],"export-"+str(i),timeout=60)
    result["exports"].append({"actualSchema":schema,"xpath":xpath,"returncode":p.returncode,"file":str(target),"text":text})
(out/"result.json").write_text(json.dumps(result,indent=2));print(json.dumps(result))
