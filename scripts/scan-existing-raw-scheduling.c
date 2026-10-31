/* Cloud-only immutable RAWv3 event extraction. Not live capture or performance acceptance.
 * ABI sources, read before implementation:
 * xnu f6217f891ac0bb64f3d375211650a4c1ff8ca1ea
 * bsd/sys/kdebug_private.h:259-274; tools/lldbmacros/ktrace.py:746-855.
 */
#define _POSIX_C_SOURCE 200809L
#include <stdint.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/mman.h>
#if defined(__APPLE__) || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "This metadata reader is built only on authorized little-endian Linux cloud"
#endif
typedef struct {
    uint64_t timestamp, arg1, arg2, arg3, arg4, tid;
    uint32_t debugid, cpuid;
    uint64_t unused;
} RawEvent;
_Static_assert(sizeof(RawEvent)==64 && offsetof(RawEvent,debugid)==48,"Actual source ABI mismatch");
/* Kernel thread IDs 386/389 are verified against the immutable original stackshot
 * by the Python inspector before invoking this scanner. No private driver event
 * codes or opaque wait tokens are interpreted here. scopeFlags 8=all events in
 * the actual fault window, 16=verified kernel completion thread transitions. */
static uint64_t prior_cpu[65536];
static unsigned char seen_cpu[65536];
static int parse_u64(const char *s,uint64_t *value) {
    char *end=NULL;
    errno=0;
    unsigned long long v=strtoull(s,&end,10);
    if(errno || !s[0] || s[0]=='-' || !end || *end) { return 0; }
    *value=(uint64_t)v; return 1;
}
static int wanted(uint64_t tid,const uint64_t *ids,size_t n) {
    for(size_t i=0;i<n;i++) { if(ids[i]==tid) { return 1; } }
    return 0;
}
static uint64_t get64(const unsigned char *p) { uint64_t v;memcpy(&v,p,8);return v; }
static uint32_t get32(const unsigned char *p) { uint32_t v;memcpy(&v,p,4);return v; }
static uint16_t get16(const unsigned char *p) { uint16_t v;memcpy(&v,p,2);return v; }
int main(int argc,char **argv) {
    const char *cloud=getenv("GITHUB_ACTIONS");
    if(!cloud || strcmp(cloud,"true") || argc!=7) { fprintf(stderr,"Cloud evidence reader arguments required\n");return 2; }
    uint64_t lo=0,hi=0,owned_pid=0,ids[128];size_t nids=0;
    if(!parse_u64(argv[3],&lo) || !parse_u64(argv[4],&hi) || lo>hi || !parse_u64(argv[6],&owned_pid) || !owned_pid) { return 2; }
    char *list=strdup(argv[5]);if(!list) { return 2; }
    char *state=NULL;
    for(char *s=strtok_r(list,",",&state);s;s=strtok_r(NULL,",",&state)) {
        if(nids==128 || !parse_u64(s,&ids[nids]) || !ids[nids]) { free(list);return 2; }
        nids++;
    }
    free(list);if(!nids) { return 2; }
    int fd=open(argv[1],O_RDONLY);struct stat st;
    if(fd<0 || fstat(fd,&st) || st.st_size<56) { perror("original raw file");if(fd>=0) { close(fd); }return 2; }
    size_t size=(size_t)st.st_size;
    const unsigned char *map=mmap(NULL,size,PROT_READ,MAP_PRIVATE,fd,0);
    if(map==MAP_FAILED) { perror("mmap readonly");close(fd);return 2; }
    FILE *output=fopen(argv[2],"wb");
    if(!output) { perror("metadata output");munmap((void *)map,size);close(fd);return 2; }
    int rc=0;uint64_t total=0,selected=0,window_rows=0,metadata_rows=0,lost=0;
    uint64_t reversals=0,cpu_reversals=0,unknown_cpu=0,prior=0,min_tick=UINT64_MAX,max_tick=0,event_chunks=0,dynamic_owned=0,excluded_globals=0;
    if(get32(map)!=0x55aa0300) { fprintf(stderr,"Unknown actual container, no guessed decoder\n");rc=2;goto done; }
    for(size_t off=0;off<size;) {
        if(size-off<16) { rc=2;break; }
        uint32_t tag=get32(map+off);uint16_t major=get16(map+off+4),minor=get16(map+off+6);
        uint64_t len=get64(map+off+8);
        if(len>size-off-16) { fprintf(stderr,"Chunk beyond actual EOF\n");rc=2;break; }
        size_t end=off+16+(size_t)len;
        if(tag==0x1e00) {
            if(major || minor || len<8 || (len-8)%64) { fprintf(stderr,"Unsupported actual event layout\n");rc=2;break; }
            event_chunks++;
            size_t count=(size_t)((len-8)/64);
            const RawEvent *events=(const RawEvent *)(map+off+24);
            for(size_t i=0;i<count;i++) {
                const RawEvent *e=&events[i];uint32_t base=e->debugid & UINT32_C(0xfffffffc);
                total++;
                if(total>1 && e->timestamp<prior) { reversals++; }
                prior=e->timestamp;
                if(e->timestamp<min_tick) { min_tick=e->timestamp; }
                if(e->timestamp>max_tick) { max_tick=e->timestamp; }
                if(e->cpuid<65536) {
                    if(seen_cpu[e->cpuid] && e->timestamp<prior_cpu[e->cpuid]) { cpu_reversals++; }
                    prior_cpu[e->cpuid]=e->timestamp;seen_cpu[e->cpuid]=1;
                } else { unknown_cpu++; }
                int inside=e->timestamp>=lo && e->timestamp<=hi;
                int scheduler=(e->debugid & UINT32_C(0xffff0000))==UINT32_C(0x01400000);
                if(base==UINT32_C(0x07000004) && e->arg2==owned_pid && e->arg3==0 && !wanted(e->arg1,ids,nids)) {
                    if(nids==128) { fprintf(stderr,"Actual owned thread bound exceeded\n");rc=2;break; }
                    ids[nids++]=e->arg1;dynamic_owned++;
                }
                if(base==UINT32_C(0x07010000)) { excluded_globals++; }
                int trace_metadata=(base>=UINT32_C(0x07000004) && base<=UINT32_C(0x07000010)) ||
                    (base>=UINT32_C(0x07010004) && base<=UINT32_C(0x07010014)) ||
                    base==UINT32_C(0x07020008);
                if(base==UINT32_C(0x07020008)) { lost++; }
                unsigned flags=(inside && wanted(e->tid,ids,nids)?1U:0U) |
                    (inside && scheduler?2U:0U) | (trace_metadata?4U:0U) |
                    (inside?8U:0U) |
                    ((e->tid==386 || e->tid==389 || (scheduler &&
                       ((base==UINT32_C(0x01400018) && (e->arg1==386 || e->arg1==389)) ||
                        ((base==UINT32_C(0x01400000) || base==UINT32_C(0x01400008)) &&
                         (e->arg2==386 || e->arg2==389)))))?16U:0U);
                if(!flags) { continue; }
                if(++selected>1000000) { fprintf(stderr,"Explicit metadata row bound exceeded, not silently truncated\n");rc=2;break; }
                if(inside) { window_rows++; }
                if(trace_metadata) { metadata_rows++; }
                fprintf(output,"{\"timestampTicks\":\"%" PRIu64 "\",\"threadID\":\"%" PRIu64 "\",\"debugIDHex\":\"0x%08" PRIx32 "\",\"cpuID\":%" PRIu32 ",\"arg1\":\"%" PRIu64 "\",\"arg2\":\"%" PRIu64 "\",\"arg3\":\"%" PRIu64 "\",\"arg4\":\"%" PRIu64 "\",\"scopeFlags\":%u}\n",
                    e->timestamp,e->tid,e->debugid,e->cpuid,e->arg1,e->arg2,e->arg3,e->arg4,flags);
            }
            if(rc) { break; }
        }
        if(end>SIZE_MAX-7) { rc=2;break; }
        off=(end+7)&~(size_t)7;
        if(off>size) { rc=2;break; }
    }
done:
    if(ferror(output) || fflush(output)) { rc=2; }
    fclose(output);
    printf("{\"completed\":%s,\"notProductAcceptance\":true,\"actualEventChunks\":%" PRIu64 ",\"actualRecords\":%" PRIu64 ",\"selectedRows\":%" PRIu64 ",\"selectedWindowRows\":%" PRIu64 ",\"traceMetadataRows\":%" PRIu64 ",\"traceLostMarkers\":%" PRIu64 ",\"globalTimestampReversals\":%" PRIu64 ",\"perCPUTimestampReversals\":%" PRIu64 ",\"CPUOutOfIndexedRange\":%" PRIu64 ",\"minimumTimestampTicks\":\"%" PRIu64 "\",\"maximumTimestampTicks\":\"%" PRIu64 "\",\"dynamicOwnedThreadAdds\":%" PRIu64 ",\"excludedUnrelatedGlobalStringEvents\":%" PRIu64 ",\"windowBeginTicks\":\"%" PRIu64 "\",\"windowEndTicks\":\"%" PRIu64 "\"}\n",
        rc?"false":"true",event_chunks,total,selected,window_rows,metadata_rows,lost,reversals,cpu_reversals,unknown_cpu,min_tick,max_tick,dynamic_owned,excluded_globals,lo,hi);
    munmap((void *)map,size);close(fd);return rc;
}
