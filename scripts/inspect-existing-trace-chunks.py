#!/usr/bin/env python3
"""Cloud byte inspection only of immutable failed ATRC. Unknown formats fail explicitly."""
import os,pathlib,json,hashlib,struct,collections
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
        r["actualTagCounts"]=dict(counts);r["completed"]=True;save()
except BaseException as e:
    r["error"]=repr(e);save();raise
finally:
    print(json.dumps({k:v for k,v in r.items() if k!="chunks"},indent=2))
    print("ACTUAL CHUNK INDEX",json.dumps(r["chunks"],indent=2))
