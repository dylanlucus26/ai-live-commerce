#!/usr/bin/env python3
"""Cloud byte inspection only of immutable failed ATRC. Unknown formats fail explicitly."""
import os,pathlib,json,hashlib,struct,collections,subprocess,math
assert os.environ.get("GITHUB_ACTIONS")=="true","Cloud evidence only"
root=pathlib.Path("/tmp/ai-live-raw-trace-chunks")
source=root/"source";out=root/"metadata";out.mkdir(parents=True,exist_ok=False)
r={"purpose":"Read immutable raw trace bytes only; no capture, target launch or media decoding",
   "sourceRun":41142373996,"sourceArtifact":13019051796,"completed":False,
   "notProductAcceptance":True,"chunks":[],"sourceABI":{
   "writer":"https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/tools/lldbmacros/ktrace.py#L746",
   "event":"https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/kdebug_private.h#L259"}}
def save():(out/"actual-raw-container.json").write_text(json.dumps(r,indent=2))
try:
    original=json.loads((source/"owned-gpu-profile/actual-profile-result.json").read_text())
    assert original["actualOwnedTarget"]["runID"]==str(r["sourceRun"])
    assert original["completed"] is False and original["traceUsable"] is False and original["recordTimedOut"] is True
    r["originalFailurePreserved"]={k:original[k] for k in ["completed","traceUsable","recordReturnCode","recordTimedOut","actualProbePhaseStrictPass","error"]}
    raw=source/"owned-gpu-profile/actual-owned-gui-metal.trace/Trace1.run/Attachments/trace-data.atrc"
    assert raw.is_file() and not raw.is_symlink()
    r["actualBytes"]=raw.stat().st_size
    digest=hashlib.sha256()
    with raw.open("rb") as f:
        for block in iter(lambda:f.read(4*1024*1024),b""):digest.update(block)
    r["actualSHA256"]=digest.hexdigest()
    assert r["actualBytes"]==6543936664 and r["actualSHA256"]=="9653bb2dff460e493b292242e4f2e1422987bfb8fd3c85f0e810cb75a0f47c43"
    with raw.open("rb") as f:
        header=f.read(256);r["actualFirst256BytesHex"]=header.hex();save()
        magic=struct.unpack_from("<I",header)[0]
        r["actualLittleEndianFirstWord"]=hex(magic);save()
        assert magic==0x55aa0300,"Actual bytes are not documented RAWv3; information insufficient, no guessed decoder"
        offset=0;counts=collections.Counter()
        while offset<r["actualBytes"]:
            assert len(r["chunks"])<10000,"Container inventory exceeds explicit bound; not silently truncated"
            f.seek(offset);h=f.read(16)
            assert len(h)==16,("Incomplete actual chunk header",offset)
            tag,major,minor,length=struct.unpack("<IHHQ",h)
            end=offset+16+length
            item={"offset":offset,"tagHex":hex(tag),"major":major,"minor":minor,"payloadBytes":length,
                "payloadPrefixHex":f.read(min(64,length)).hex()}
            r["chunks"].append(item);counts[hex(tag)]+=1
            assert end<=r["actualBytes"],("Actual chunk extends past EOF; unsupported/incomplete container",item)
            if offset==0:
                assert length>=40
                fields=struct.unpack_from("<IIQQIIII",header,16)
                r["actualHeaderFields"]={"timebaseNumer":fields[0],"timebaseDenom":fields[1],
                    "wallAbsoluteTicks":fields[2],"wallSeconds":fields[3],"wallUsec":fields[4],
                    "remainingRawUInt32":list(fields[5:])}
                assert min(fields[:2])>0
            if tag==0x1e00:
                item["knownRaw64RecordLayoutCandidate"]=major==0 and minor==0 and length>=8 and (length-8)%64==0
                if item["knownRaw64RecordLayoutCandidate"]:
                    item["actualRecordCount"]=(length-8)//64
                    f.seek(offset+16);item["actualFutureTimestamp"]=struct.unpack("<Q",f.read(8))[0]
                    item["actualFirstRecordsRaw"]=[]
                    for _ in range(min(3,item["actualRecordCount"])):
                        v=struct.unpack("<6QIIQ",f.read(64))
                        item["actualFirstRecordsRaw"].append({"timestampTicks":v[0],"arg1":v[1],"arg2":v[2],"arg3":v[3],"arg4":v[4],"threadID":v[5],"debugIDHex":hex(v[6]),"cpuID":v[7],"unused":v[8]})
            aligned=(end+7)&~7
            assert aligned<=r["actualBytes"],("Final padding incomplete",end,aligned)
            if aligned>end:
                f.seek(end);padding=f.read(aligned-end);item["actualPaddingHex"]=padding.hex()
            offset=aligned
        assert offset==r["actualBytes"]
        r["actualTagCounts"]=dict(counts);r["containerValidated"]=True;save()
        maps=[x for x in r["chunks"] if x["tagHex"]=="0x1d00"]
        assert len(maps)==1 and maps[0]["major"]==0 and maps[0]["minor"]==0 and maps[0]["payloadBytes"]%32==0
        f.seek(maps[0]["offset"]+16)
        threadmap=[]
        for _ in range(maps[0]["payloadBytes"]//32):
            tid,pid,name=struct.unpack("<Qi20s",f.read(32))
            threadmap.append({"threadID":str(tid),"pid":pid,"processName":name.split(bytes([0]),1)[0].decode("ascii",errors="replace"),"rawNameHex":name.hex()})
        (out/"actual-initial-thread-map.json").write_text(json.dumps(threadmap,indent=2))
        pid=original["actualOwnedTarget"]["actualPID"]
        target=[x for x in threadmap if x["pid"]==pid]
        assert target and all(x["processName"]=="CloudMetalControl" for x in target),"Actual initial owned PID/thread map mismatch"
        probe=json.loads((source/"gui-metal-comparison.json").read_text())
        assert probe["actualCloudPreflight"]["runID"]==str(r["sourceRun"]) and probe["actualProbePID"]==pid
        cols=probe["columns"];idx={k:i for i,k in enumerate(cols)}
        samples=probe["phases"][0]["samples"]
        assert len(samples)==1800 and all(len(x)==len(cols) and all(math.isfinite(y) for y in x) for x in samples)
        slow=[x for x in samples if x[idx["gpuEnd"]]-x[idx["gpuStart"]]>1/30 or x[idx["deadlineMet"]]!=1]
        assert slow,"No actual original fault rows"
        begin=min(x[idx["cpuStart"]] for x in slow)-0.05
        end=max(max(x[idx["gpuEnd"]],x[idx["cpuCompleted"]]) for x in slow)+0.05
        numer=r["actualHeaderFields"]["timebaseNumer"];denom=r["actualHeaderFields"]["timebaseDenom"]
        lo=math.floor(begin*denom*1e9/numer);hi=math.ceil(end*denom*1e9/numer)
        r["actualOwnedInitialThreads"]=target
        r["actualOriginalFaultWindow"]={"sourceColumns":cols,"originalFaultRows":slow,
            "rawSecondsBegin":begin,"rawSecondsEnd":end,"beginTicks":str(lo),"endTicks":str(hi),
            "boundary":"Raw counter conversion uses actual file timebase, not fitted waveform. Thread state interpretation remains a separate evidence check."}
        args=["/tmp/ai-live-scan-raw-scheduling",str(raw),str(out/"actual-window-events.jsonl"),
            str(lo),str(hi),",".join(x["threadID"] for x in target)]
        r["actualScannerArgs"]=args;save()
        p=subprocess.run(args,capture_output=True,text=True,timeout=180)
        (out/"actual-scanner.stdout").write_text(p.stdout);(out/"actual-scanner.stderr").write_text(p.stderr)
        r["actualScannerExit"]=p.returncode
        assert p.returncode==0,("Raw event reader failed; preserve actual errors",p.stderr)
        r["actualSchedulingScan"]=json.loads(p.stdout)
        assert r["actualSchedulingScan"]["completed"] is True
        assert r["actualSchedulingScan"]["actualRecords"]==sum(x.get("actualRecordCount",0) for x in r["chunks"])
        assert r["actualSchedulingScan"]["selectedWindowRows"]>0
        r["completed"]=True;save()
except BaseException as e:
    r["completed"]=False;r["error"]=repr(e);save();raise
finally:
    print(json.dumps({k:v for k,v in r.items() if k!="chunks"},indent=2))
    print("ACTUAL CHUNK INDEX",json.dumps(r["chunks"],indent=2))
