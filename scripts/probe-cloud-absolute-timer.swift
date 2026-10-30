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
func snapshot() throws -> [String: Any] {
    ["category": try policy(task_policy_flavor_t(TASK_CATEGORY_POLICY), fields: 1),
     "base": try policy(task_policy_flavor_t(TASK_BASE_QOS_POLICY), fields: 2),
     "override": try policy(task_policy_flavor_t(TASK_OVERRIDE_QOS_POLICY), fields: 2),
     "requestedPthreadClassIsUserInteractive": qos_class_self() == QOS_CLASS_USER_INTERACTIVE,
     "foundationQoS": Thread.current.qualityOfService.rawValue]
}
func measure(_ label: String, absolute: Bool, clock: MachClock) throws -> [String: Any] {
    let before = try snapshot()
    let start = clock.nowNS()
    var rows: [[Double]] = []
    rows.reserveCapacity(1800)
    var counts = WaitCounts()
    var misses = 0
    for frame in 0..<1800 {
        let due = start + UInt64(frame) * 1_000_000_000 / 30
        let deadline = start + UInt64(frame+1) * 1_000_000_000 / 30
        try waitUntil(due, absolute: absolute, clock: clock, counts: &counts)
        let actual = clock.nowNS()
        if actual > deadline { misses += 1 }
        rows.append([Double(frame), Double(due)/1e9, Double(actual)/1e9,
            Double(deadline)/1e9, actual <= deadline ? 1 : 0])
    }
    try waitUntil(start + 60_000_000_000, absolute: absolute, clock: clock, counts: &counts)
    guard qos_class_self() == QOS_CLASS_USER_INTERACTIVE else {
        throw WaitFailure(message: "Requested interactive pthread QoS changed")
    }
    return ["label": label, "mechanism": absolute ? "mach_wait_until-absolute" : "nanosleep-relative",
        "elapsedSeconds": Double(clock.nowNS() - start)/1e9, "frames": rows.count,
        "missedCPUWakeDeadlines": misses, "allCPUWakeDeadlinesPassed": misses == 0,
        "waitCalls": counts.calls, "interruptions": counts.interruptions,
        "successfulEarlyReturns": counts.successfulEarlyReturns,
        "policiesBefore": before, "policiesAfter": try snapshot(), "samples": rows]
}
var report: [String: Any] = [
    "purpose": "Relative nanosleep -> public absolute mach_wait_until -> relative nanosleep on one actual interactive cloud pthread, one monotonic Mach clock and unchanged 30FPS deadlines. No spin, early wake, priority change between phases, GPU or OBS acceptance.",
    "completed": false, "allCPUWakeDeadlinesPassed": false, "targetFPS": 30,
    "columns": ["frame", "targetStart", "actualCPUStart", "deadline", "deadlineMet"],
    "policyEvidenceBoundary": "Public getters show requested task policies, not effective kernel scheduling priority."]
var phases: [[String: Any]] = []
var output = ""
var passed = false
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
    for (label, absolute) in [("relative-first", false), ("absolute-middle", true), ("relative-restored", false)] {
        let phase = try measure(label, absolute: absolute, clock: clock)
        phases.append(phase)
        print("ACTUAL WAIT CONTROL: \(label) frames=\(phase["frames"]!) misses=\(phase["missedCPUWakeDeadlines"]!) elapsed=\(phase["elapsedSeconds"]!)")
    }
    report["completed"] = true
    passed = phases.allSatisfy { $0["allCPUWakeDeadlinesPassed"] as? Bool == true }
} catch { report["error"] = String(describing: error) }
report["phases"] = phases
report["allCPUWakeDeadlinesPassed"] = passed
if !output.isEmpty {
    do {
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: output), options: .atomic)
    } catch { print("ACTUAL WAIT REPORT WRITE FAILED: \(error)"); passed = false }
}
exit(passed ? 0 : 1)
