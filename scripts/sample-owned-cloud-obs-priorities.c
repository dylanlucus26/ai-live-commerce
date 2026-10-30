/* Read-only observations of ONE owned cloud OBS process. No scheduling setters. */
#if !defined(__APPLE__) || !(defined(__arm64__) || defined(__aarch64__))
#error Authorized cloud macOS ARM64 only
#endif
#define _DARWIN_C_SOURCE 1
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/utsname.h>
#include <unistd.h>
#include <time.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <inttypes.h>
#include <limits.h>
#include <string.h>

static int fail(const char *operation, int code, int result) {
    printf("{\"event\":\"error\",\"operation\":\"%s\",\"errno\":%d,\"result\":%d}\n",
           operation, code, result);
    fflush(stdout);
    return 1;
}
static double wall_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_REALTIME, &value) != 0) return -1;
    return (double)value.tv_sec * 1000.0 + (double)value.tv_nsec / 1000000.0;
}
static void name_bytes(const char *value, size_t length) {
    int ascii = 1;
    for (size_t i = 0; i < length; i++) if ((unsigned char)value[i] >= 128) ascii = 0;
    printf("\"nameAscii\":");
    if (ascii) {
        putchar('"');
        for (size_t i = 0; i < length; i++) {
            unsigned char ch = (unsigned char)value[i];
            if (ch == '"' || ch == '\\') { putchar('\\'); putchar(ch); }
            else if (ch < 32) printf("\\u%04x", (unsigned int)ch);
            else putchar(ch);
        }
        putchar('"');
    } else printf("null");
    printf(",\"nameBytesHex\":\"");
    for (size_t i = 0; i < length; i++) printf("%02x", (unsigned char)value[i]);
    putchar('"');
}
int main(int argc, char **argv) {
    if (!getenv("GITHUB_ACTIONS") || strcmp(getenv("GITHUB_ACTIONS"), "true") != 0 || argc != 2)
        return fail("cloud-only-owned-pid-required", 0, argc);
    char *end = NULL;
    errno = 0;
    long parsed = strtol(argv[1], &end, 10);
    if (errno || !end || *end || parsed <= 1 || parsed > INT_MAX)
        return fail("parse-owned-pid", errno, 0);
    int pid = (int)parsed;
    const char *expected_path = "/Applications/OBS.app/Contents/MacOS/OBS";
    uint64_t start_sec = 0, start_usec = 0;
    int observed = 0, graphics_seen = 0;
    setvbuf(stdout, NULL, _IOLBF, 0);
    struct utsname system;
    if (uname(&system) != 0) return fail("uname", errno, -1);
    printf("{\"event\":\"observer-start\",\"ownedPID\":%d,\"observerPID\":%d,"
           "\"readOnly\":true,\"darwinRelease\":\"%s\",\"machine\":\"%s\"}\n",
           pid, getpid(), system.release, system.machine);
    for (int sample = 0; sample < 180; sample++) {
        struct proc_bsdinfo bsd;
        memset(&bsd, 0, sizeof(bsd));
        errno = 0;
        int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, (int)sizeof(bsd));
        int saved_errno = errno;
        if (size != (int)sizeof(bsd)) {
            if (size == 0 && saved_errno == ESRCH && observed > 0) {
                printf("{\"event\":\"owner-exited\",\"ownedPID\":%d,\"atMs\":%.6f,"
                       "\"samples\":%d,\"graphicsThreadSeen\":%s}\n",
                       pid, wall_ms(), observed, graphics_seen ? "true" : "false");
                return graphics_seen ? 0 : 1;
            }
            return fail("PROC_PIDTBSDINFO", saved_errno, size);
        }
        if (bsd.pbi_pid != (uint32_t)pid || bsd.pbi_uid != getuid())
            return fail("owned-pid-uid-mismatch", 0, size);
        char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
        errno = 0;
        size = proc_pidpath(pid, path, (uint32_t)sizeof(path));
        if (size <= 0) {
            saved_errno = errno;
            if (saved_errno == ESRCH && observed > 0) {
                printf("{\"event\":\"owner-exited\",\"ownedPID\":%d,\"atMs\":%.6f,"
                       "\"samples\":%d,\"graphicsThreadSeen\":%s}\n",
                       pid, wall_ms(), observed, graphics_seen ? "true" : "false");
                return graphics_seen ? 0 : 1;
            }
            return fail("proc_pidpath", saved_errno, size);
        }
        path[sizeof(path)-1] = 0;
        if (strcmp(path, expected_path) != 0) return fail("owned-executable-mismatch", 0, size);
        if (observed == 0) {
            start_sec = bsd.pbi_start_tvsec; start_usec = bsd.pbi_start_tvusec;
        } else if (start_sec != bsd.pbi_start_tvsec || start_usec != bsd.pbi_start_tvusec) {
            return fail("owned-pid-start-time-changed", 0, 0);
        }
        struct proc_taskinfo task;
        memset(&task, 0, sizeof(task));
        errno = 0;
        size = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, (int)sizeof(task));
        if (size != (int)sizeof(task)) return fail("PROC_PIDTASKINFO", errno, size);
        uint64_t handles[16384];
        errno = 0;
        int bytes = proc_pidinfo(pid, PROC_PIDLISTTHREADS, 0, handles, (int)sizeof(handles));
        if (bytes <= 0 || bytes % (int)sizeof(uint64_t) != 0 || bytes >= (int)sizeof(handles))
            return fail("PROC_PIDLISTTHREADS-no-complete-list", errno, bytes);
        double at = wall_ms();
        if (at < 0) return fail("clock_gettime", errno, -1);
        printf("{\"event\":\"thread-sample\",\"ownedPID\":%d,\"atMs\":%.6f,\"sample\":%d,"
               "\"uid\":%u,\"nice\":%d,\"processFlags\":%u,\"startSec\":%" PRIu64 ","
               "\"startUsec\":%" PRIu64 ",\"taskPolicy\":%d,\"taskPriority\":%d,"
               "\"reportedThreadCount\":%d,\"threads\":[",
               pid, at, sample, (unsigned int)bsd.pbi_uid, bsd.pbi_nice, bsd.pbi_flags,
               start_sec, start_usec, task.pti_policy, task.pti_priority, task.pti_threadnum);
        int count = bytes / (int)sizeof(uint64_t);
        int errors = 0;
        for (int i = 0; i < count; i++) {
            if (i) putchar(',');
            struct proc_threadinfo thread;
            memset(&thread, 0, sizeof(thread));
            errno = 0;
            int result = proc_pidinfo(pid, PROC_PIDTHREADINFO, handles[i], &thread, (int)sizeof(thread));
            saved_errno = errno;
            if (result != (int)sizeof(thread)) {
                printf("{\"threadHandleHex\":\"%016" PRIx64 "\",\"queryError\":%d,\"result\":%d}",
                       handles[i], saved_errno, result);
                /* A listed thread can exit before the read. Retain each exact failure; other errors fail the observer. */
                if (saved_errno != ESRCH) errors++;
                continue;
            }
            size_t length = strnlen(thread.pth_name, sizeof(thread.pth_name));
            if (length == strlen("libobs: graphics thread") &&
                memcmp(thread.pth_name, "libobs: graphics thread", length) == 0) graphics_seen = 1;
            printf("{\"threadHandleHex\":\"%016" PRIx64 "\",", handles[i]);
            name_bytes(thread.pth_name, length);
            printf(",\"policyInEffect\":%d,\"currentPriority\":%d,\"basePriority\":%d,"
                   "\"maxPriority\":%d,\"runState\":%d,\"flags\":%d,\"cpuUsage\":%d,"
                   "\"userNS\":%" PRIu64 ",\"systemNS\":%" PRIu64 "}",
                   thread.pth_policy, thread.pth_curpri, thread.pth_priority, thread.pth_maxpriority,
                   thread.pth_run_state, thread.pth_flags, thread.pth_cpu_usage,
                   thread.pth_user_time, thread.pth_system_time);
        }
        printf("],\"unexpectedThreadQueryErrors\":%d}\n", errors);
        observed++;
        if (errors) return 1;
        struct timespec request = {.tv_sec = 5, .tv_nsec = 0}, remaining;
        while (nanosleep(&request, &remaining) != 0) {
            if (errno != EINTR) return fail("observer-sleep", errno, -1);
            request = remaining;
        }
    }
    return fail("observer-bounded-limit-owner-still-alive", 0, observed);
}
