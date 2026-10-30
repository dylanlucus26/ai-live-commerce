// GitHub-only relative/absolute CPU wake control. Never a substitute for OBS/RTMP acceptance.
import Foundation
import Darwin

struct WaitFailure: Error { let message: String }
struct MachClock {
    let origin: UInt64
    let numer: UInt64
    let denom: UInt64
    init() throws {
        var info = mach_timebase_info_data_t()
        let status = mach_timebase_info(&info)
        guard status == KERN_SUCCESS && info.numer > 0 && info.denom > 0 else {
            throw WaitFailure(message: "Actual mach_timebase_info failed: \(status)")
        }
        numer = UInt64(info.numer); denom = UInt64(info.denom)
        origin = mach_absolute_time()
    }
    func nowNS() -> UInt64 { (mach_absolute_time() - origin) * numer / denom }
    func deadlineTicks(_ offsetNS: UInt64) throws -> UInt64 {
        let product = offsetNS.multipliedReportingOverflow(by: denom)
        guard !product.overflow && product.partialValue <= UInt64.max - (numer - 1) else {
            throw WaitFailure(message: "Mach deadline conversion overflow")
        }
        let ticks = (product.partialValue + numer - 1) / numer
        let result = origin.addingReportingOverflow(ticks)
        guard !result.overflow else { throw WaitFailure(message: "Mach absolute deadline overflow") }
        return result.partialValue
    }
}
struct WaitCounts {
    var calls = 0
    var interruptions = 0
    var successfulEarlyReturns = 0
}
func waitUntil(_ offsetNS: UInt64, absolute: Bool, clock: MachClock, counts: inout WaitCounts) throws {
    if absolute {
        let deadline = try clock.deadlineTicks(offsetNS)
        while mach_absolute_time() < deadline {
            counts.calls += 1
            let status = mach_wait_until(deadline)
            if status == KERN_ABORTED { counts.interruptions += 1 }
            else if status != KERN_SUCCESS { throw WaitFailure(message: "mach_wait_until status=\(status)") }
            else if mach_absolute_time() < deadline { counts.successfulEarlyReturns += 1 }
        }
    } else {
        while clock.nowNS() < offsetNS {
            let now = clock.nowNS()
            if now >= offsetNS { return }
            let remaining = offsetNS - now
            var request = timespec(tv_sec: Int(remaining / 1_000_000_000), tv_nsec: Int(remaining % 1_000_000_000))
            var remain = timespec()
            while true {
                counts.calls += 1
                if nanosleep(&request, &remain) == 0 { break }
                guard errno == EINTR else { throw WaitFailure(message: "nanosleep errno=\(errno)") }
                counts.interruptions += 1
                request = remain; remain = timespec()
            }
        }
    }
}
func policy(_ flavor: task_policy_flavor_t, fields: Int) throws -> [String: Any] {
    var values = [integer_t](repeating: 0, count: fields)
    var count = mach_msg_type_number_t(fields)
    var defaults: boolean_t = 0
    let status = values.withUnsafeMutableBufferPointer {
        task_policy_get(mach_task_self_, flavor, $0.baseAddress, &count, &defaults)
    }
    guard status == KERN_SUCCESS && count == mach_msg_type_number_t(fields) else {
        throw WaitFailure(message: "Actual task_policy_get failed: \(flavor), status=\(status), count=\(count)")
    }
    return ["flavor": flavor, "status": status, "getDefaultReturned": defaults, "rawFields": values]
}

struct OwnThreadPolicy {
    let fields: [integer_t]
    let returnedDefault: boolean_t
    var json: [String: Any] { ["rawFields": fields, "getDefaultReturned": returnedDefault] }
}
func ownThreadPolicy(_ flavor: thread_policy_flavor_t, count expectedCount: Int) throws -> OwnThreadPolicy {
    let thread = mach_thread_self()
    defer { mach_port_deallocate(mach_task_self_, thread) }
    var fields = [integer_t](repeating: 0, count: expectedCount)
    var count = mach_msg_type_number_t(expectedCount)
    var defaults: boolean_t = 0
    let status = fields.withUnsafeMutableBufferPointer {
        thread_policy_get(thread, flavor, $0.baseAddress, &count, &defaults)
    }
    guard status == KERN_SUCCESS && count == mach_msg_type_number_t(expectedCount) else {
        throw WaitFailure(message: "Actual own thread_policy_get failed: \(flavor), status=\(status), count=\(count)")
    }
    return OwnThreadPolicy(fields: fields, returnedDefault: defaults)
}
func setOwnThreadPolicy(_ flavor: thread_policy_flavor_t, fields: [integer_t]) -> kern_return_t {
    let thread = mach_thread_self()
    defer { mach_port_deallocate(mach_task_self_, thread) }
    var copy = fields
    let count = mach_msg_type_number_t(copy.count)
    return copy.withUnsafeMutableBufferPointer {
        thread_policy_set(thread, flavor, $0.baseAddress, count)
    }
}
func actualOwnThreadInfo() throws -> [String: Any] {
    let thread = mach_thread_self()
    defer { mach_port_deallocate(mach_task_self_, thread) }
    var info = thread_extended_info_data_t()
    let expectedCount = MemoryLayout<thread_extended_info_data_t>.stride / MemoryLayout<integer_t>.stride
    var count = mach_msg_type_number_t(expectedCount)
    let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: expectedCount) {
            thread_info(thread, thread_flavor_t(THREAD_EXTENDED_INFO), $0, &count)
        }
    }
    guard status == KERN_SUCCESS && count == mach_msg_type_number_t(expectedCount) else {
        throw WaitFailure(message: "Actual THREAD_EXTENDED_INFO failed: status=\(status), count=\(count)")
    }
    return ["policyInEffect": info.pth_policy, "currentPriority": info.pth_curpri,
        "basePriority": info.pth_priority, "maxPriority": info.pth_maxpriority,
        "runState": info.pth_run_state, "flags": info.pth_flags,
        "userNS": info.pth_user_time, "systemNS": info.pth_system_time]
}
func schedulingSnapshot() throws -> [String: Any] {
    ["timeConstraint": try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4).json,
     "extended": try ownThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), count: 1).json,
     "actualOwnThreadInfo": try actualOwnThreadInfo()]
}
func restoreOwnTimeshare(_ fields: [integer_t]) throws -> [String: Any] {
    let status = setOwnThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), fields: fields)
    guard status == KERN_SUCCESS else { throw WaitFailure(message: "Original timeshare restore failed: \(status)") }
    let qosStatus = pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)
    guard qosStatus == 0 else { throw WaitFailure(message: "Original interactive request restore failed: \(qosStatus)") }
    let actual = try ownThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), count: 1)
    let rt = try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4)
    guard actual.returnedDefault == 0 && actual.fields == fields && rt.returnedDefault != 0,
        qos_class_self() == QOS_CLASS_USER_INTERACTIVE else {
        throw WaitFailure(message: "Actual original timeshare and QoS restoration not confirmed")
    }
    return ["setterStatus": status, "qosSetterStatus": qosStatus, "actual": try schedulingSnapshot()]
}

func snapshot() throws -> [String: Any] {
    ["category": try policy(task_policy_flavor_t(TASK_CATEGORY_POLICY), fields: 1),
     "base": try policy(task_policy_flavor_t(TASK_BASE_QOS_POLICY), fields: 2),
     "override": try policy(task_policy_flavor_t(TASK_OVERRIDE_QOS_POLICY), fields: 2),
     "requestedPthreadClassIsUserInteractive": qos_class_self() == QOS_CLASS_USER_INTERACTIVE,
     "foundationQoS": Thread.current.qualityOfService.rawValue,
     "ownThreadScheduling": try schedulingSnapshot()]
}
func measure(_ label: String, absolute: Bool, clock: MachClock, expectedRealtime: Bool? = nil) throws -> [String: Any] {
    let before = try snapshot()
    let start = clock.nowNS()
    var rows: [[Double]] = []
    rows.reserveCapacity(1800)
    var counts = WaitCounts()
    var misses = 0
    var schedulingSamples: [[String: Any]] = []
    for frame in 0..<1800 {
        let due = start + UInt64(frame) * 1_000_000_000 / 30
        let deadline = start + UInt64(frame+1) * 1_000_000_000 / 30
        try waitUntil(due, absolute: absolute, clock: clock, counts: &counts)
        let actual = clock.nowNS()
        if actual > deadline { misses += 1 }
        rows.append([Double(frame), Double(due)/1e9, Double(actual)/1e9,
            Double(deadline)/1e9, actual <= deadline ? 1 : 0])
        if frame % 150 == 0 {
            schedulingSamples.append(["frame": frame, "at": Double(clock.nowNS())/1e9,
                "expectedRealtime": expectedRealtime.map { $0 as Any } ?? NSNull(), "actual": try schedulingSnapshot()])
        }
    }
    try waitUntil(start + 60_000_000_000, absolute: absolute, clock: clock, counts: &counts)
    guard expectedRealtime == true || qos_class_self() == QOS_CLASS_USER_INTERACTIVE else {
        throw WaitFailure(message: "Requested interactive pthread QoS changed")
    }
    return ["label": label, "mechanism": absolute ? "mach_wait_until-absolute" : "nanosleep-relative",
        "elapsedSeconds": Double(clock.nowNS() - start)/1e9, "frames": rows.count,
        "missedCPUWakeDeadlines": misses, "allCPUWakeDeadlinesPassed": misses == 0,
        "waitCalls": counts.calls, "interruptions": counts.interruptions,
        "successfulEarlyReturns": counts.successfulEarlyReturns,
        "policiesBefore": before, "policiesAfter": try snapshot(), "samples": rows,
        "schedulingSamples": schedulingSamples]
}
var report: [String: Any] = [
    "purpose": "Relative nanosleep -> public absolute mach_wait_until -> relative nanosleep on one actual interactive cloud pthread, one monotonic Mach clock and unchanged 30FPS deadlines. No spin, early wake, priority change between phases, GPU or OBS acceptance.",
    "completed": false, "allCPUWakeDeadlinesPassed": false, "targetFPS": 30,
    "columns": ["frame", "targetStart", "actualCPUStart", "deadline", "deadlineMet"],
    "policyEvidenceBoundary": "Public getters show requested task policies, not effective kernel scheduling priority."]
var phases: [[String: Any]] = []
var output = ""
var passed = false
let deadlineControl = ProcessInfo.processInfo.environment["AI_LIVE_THREAD_DEADLINE_CONTROL"] == "true"
var originalTimeshare: [integer_t]? = nil
var mustRestoreThread = false
do {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        throw WaitFailure(message: "Refuse local execution")
    }
    #if !arch(arm64)
    throw WaitFailure(message: "Actual ARM64 required")
    #endif
    guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 26 && CommandLine.arguments.count == 2 else {
        throw WaitFailure(message: "Actual macOS26 and output path required")
    }
    output = CommandLine.arguments[1]
    report["actualOS"] = ProcessInfo.processInfo.operatingSystemVersionString
    report["actualPID"] = ProcessInfo.processInfo.processIdentifier
    report["initialPolicies"] = try snapshot()
    let status = pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)
    guard status == 0 && qos_class_self() == QOS_CLASS_USER_INTERACTIVE else {
        throw WaitFailure(message: "Interactive pthread QoS request failed: \(status)")
    }
    report["pthreadQoSSetterStatus"] = status
    // Same activity token across all phases; this experiment changes only the wait mechanism.
    let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated],
        reason: "Authorized isolated cloud wait mechanism control")
    defer { ProcessInfo.processInfo.endActivity(activity) }
    let clock = try MachClock()
    report["machTimebase"] = ["numer": clock.numer, "denom": clock.denom, "originTicks": clock.origin]
    if deadlineControl {
        report["purpose"] = "One own cloud pthread: original interactive timeshare -> public bounded time-constraint request -> original timeshare. Same relative nanosleep, Mach clock, userInitiated activity and all 30FPS/60s deadlines. No busy wait or OBS changes."
        report["policyEvidenceBoundary"] = "THREAD_EXTENDED_INFO records actual current/base/max priority at sampled instants. TIME_CONSTRAINT getter can report active OR saved realtime policy; its values alone do not exclude demotion. Raw scheduling samples are retained."
        let baseline = try ownThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), count: 1)
        let originalRT = try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4)
        guard baseline.returnedDefault == 0 && baseline.fields == [1] && originalRT.returnedDefault != 0 else {
            throw WaitFailure(message: "Expected original own timeshare mode not confirmed")
        }
        originalTimeshare = baseline.fields
        report["originalThreadScheduling"] = try schedulingSnapshot()
        for (label, realtime) in [("timeshare-first", false), ("bounded-deadline-middle", true), ("timeshare-restored", false)] {
            if realtime {
                func ticks(_ ns: UInt64) throws -> integer_t {
                    let value = try clock.deadlineTicks(ns) - clock.origin
                    guard value <= UInt64(Int32.max) else { throw WaitFailure(message: "Thread policy ticks exceed public field") }
                    return integer_t(value)
                }
                // 1ms nominal CPU budget / 2ms constraint in each unchanged 33.333ms period.
                // Public header allows kernel budget adjustment; record and verify the actual fields.
                let requested: [integer_t] = [try ticks(33_333_333), try ticks(1_000_000), try ticks(2_000_000), 1]
                mustRestoreThread = true
                let status = setOwnThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), fields: requested)
                report["boundedDeadlineRequest"] = ["status": status, "rawFieldsRequested": requested,
                    "periodNS": 33_333_333, "computationNS": 1_000_000, "constraintNS": 2_000_000]
                guard status == KERN_SUCCESS else { throw WaitFailure(message: "Own time-constraint setter rejected: \(status)") }
                let actual = try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4)
                report["boundedDeadlineReadback"] = actual.json
                guard actual.returnedDefault == 0 && actual.fields == requested else {
                    throw WaitFailure(message: "Requested bounded time-constraint readback not confirmed")
                }
            } else if mustRestoreThread, let originalTimeshare {
                report["originalThreadRestored"] = try restoreOwnTimeshare(originalTimeshare)
                mustRestoreThread = false
            }
            let phase = try measure(label, absolute: false, clock: clock, expectedRealtime: realtime)
            phases.append(phase)
            print("ACTUAL THREAD DEADLINE CONTROL: \(label) frames=\(phase["frames"]!) misses=\(phase["missedCPUWakeDeadlines"]!) elapsed=\(phase["elapsedSeconds"]!)")
        }
    } else {
        for (label, absolute) in [("relative-first", false), ("absolute-middle", true), ("relative-restored", false)] {
            let phase = try measure(label, absolute: absolute, clock: clock)
            phases.append(phase)
            print("ACTUAL WAIT CONTROL: \(label) frames=\(phase["frames"]!) misses=\(phase["missedCPUWakeDeadlines"]!) elapsed=\(phase["elapsedSeconds"]!)")
        }
    }
    report["completed"] = true
    passed = phases.allSatisfy { $0["allCPUWakeDeadlinesPassed"] as? Bool == true }
} catch { report["error"] = String(describing: error) }
if mustRestoreThread, let originalTimeshare {
    do {
        report["originalThreadRestoredAfterFailure"] = try restoreOwnTimeshare(originalTimeshare)
        mustRestoreThread = false
    } catch { report["threadRestoreError"] = String(describing: error); passed = false }
}
report["phases"] = phases
report["allCPUWakeDeadlinesPassed"] = passed
if !output.isEmpty {
    do {
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: output), options: .atomic)
    } catch { print("ACTUAL WAIT REPORT WRITE FAILED: \(error)"); passed = false }
}
exit(passed ? 0 : 1)
