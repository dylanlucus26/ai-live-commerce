// GitHub-only CPU wake timing control. Never substitutes for OBS/GPU/RTMP acceptance.
import Foundation
import Dispatch
import Darwin

struct TimerFailure: Error { let message: String }
func requestedTaskPolicy(_ flavor: task_policy_flavor_t, fields: Int) throws -> [String: Any] {
    var values = [integer_t](repeating: 0, count: fields)
    var count = mach_msg_type_number_t(fields)
    var defaults: boolean_t = 0
    let status = values.withUnsafeMutableBufferPointer {
        task_policy_get(mach_task_self_, flavor, $0.baseAddress, &count, &defaults)
    }
    guard status == KERN_SUCCESS && count == mach_msg_type_number_t(fields) else {
        throw TimerFailure(message: "Actual task_policy_get failed: flavor=\(flavor) status=\(status) count=\(count)")
    }
    return ["flavor": flavor, "status": status, "getDefaultReturned": defaults, "rawFields": values]
}
func taskSnapshot() throws -> [String: Any] {
    return ["category": try requestedTaskPolicy(task_policy_flavor_t(TASK_CATEGORY_POLICY), fields: 1),
        "baseLatencyAndThroughput": try requestedTaskPolicy(task_policy_flavor_t(TASK_BASE_QOS_POLICY), fields: 2),
        "overrideLatencyAndThroughput": try requestedTaskPolicy(task_policy_flavor_t(TASK_OVERRIDE_QOS_POLICY), fields: 2),
        "requestedPthreadClassIsUserInteractive": qos_class_self() == QOS_CLASS_USER_INTERACTIVE,
        "foundationQoS": Thread.current.qualityOfService.rawValue]
}
func waitUntil(_ target: UInt64) throws {
    while DispatchTime.now().uptimeNanoseconds < target {
        let now = DispatchTime.now().uptimeNanoseconds
        if now >= target { return }
        let remainingNS = target - now
        var request = timespec(tv_sec: Int(remainingNS / 1_000_000_000),
            tv_nsec: Int(remainingNS % 1_000_000_000))
        var remain = timespec()
        while nanosleep(&request, &remain) != 0 {
            guard errno == EINTR else { throw TimerFailure(message: "nanosleep errno=\(errno)") }
            request = remain; remain = timespec()
        }
    }
}
func measure(_ label: String, latencyCritical: Bool) throws -> [String: Any] {
    let options: ProcessInfo.ActivityOptions = latencyCritical ? [.userInitiated, .latencyCritical] : [.userInitiated]
    let token = ProcessInfo.processInfo.beginActivity(options: options, reason: "Isolated authorized cloud timer precision control")
    defer { ProcessInfo.processInfo.endActivity(token) }
    let snapshot = try taskSnapshot()
    let start = DispatchTime.now().uptimeNanoseconds
    var rows: [[Double]] = []
    var missed = 0
    for frame in 0..<1800 {
        let due = start + UInt64(frame) * 1_000_000_000 / 30
        let deadline = start + UInt64(frame+1) * 1_000_000_000 / 30
        try waitUntil(due)
        let actual = DispatchTime.now().uptimeNanoseconds
        if actual > deadline { missed += 1 }
        rows.append([Double(frame), Double(due)/1e9, Double(actual)/1e9,
            Double(deadline)/1e9, actual <= deadline ? 1 : 0])
    }
    try waitUntil(start + 60_000_000_000)
    guard qos_class_self() == QOS_CLASS_USER_INTERACTIVE else {
        throw TimerFailure(message: "Requested pthread QoS unexpectedly changed during phase")
    }
    return ["label": label, "activityOptionsRaw": options.rawValue,
        "userInitiatedActivity": true, "latencyCriticalActivity": latencyCritical,
        "requestedTaskPoliciesDuringActivity": snapshot,
        "frames": rows.count, "elapsedSeconds": Double(DispatchTime.now().uptimeNanoseconds-start)/1e9,
        "missedCPUWakeDeadlines": missed, "allCPUWakeDeadlinesPassed": missed == 0, "samples": rows]
}
var report: [String: Any] = ["purpose": "Isolate requested task timer policy with userInitiated -> userInitiated+latencyCritical -> userInitiated. Same interactive pthread and relative nanosleep. CPU wake-only; no GPU or OBS acceptance claim.",
    "completed": false, "targetFPS": 30,
    "columns": ["frame", "targetStart", "actualCPUStart", "deadline", "deadlineMet"],
    "policyEvidenceBoundary": "Public getters expose requested task base/override tiers and role, not effective kernel scheduling priority."]
var phases: [[String: Any]] = []
var output = ""
var passed = false
do {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        throw TimerFailure(message: "Refuse local execution")
    }
    #if !arch(arm64)
    throw TimerFailure(message: "Actual ARM64 required")
    #endif
    guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 26,
        CommandLine.arguments.count == 2 else { throw TimerFailure(message: "Actual macOS26 and output path required") }
    output = CommandLine.arguments[1]
    report["actualOS"] = ProcessInfo.processInfo.operatingSystemVersionString
    report["actualPID"] = ProcessInfo.processInfo.processIdentifier
    report["initialRequestedTaskPolicies"] = try taskSnapshot()
    let qosStatus = pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)
    guard qosStatus == 0 && qos_class_self() == QOS_CLASS_USER_INTERACTIVE else {
        throw TimerFailure(message: "Requested interactive pthread QoS setter failed: \(qosStatus)")
    }
    report["pthreadQoSSetterStatus"] = qosStatus
    for (label, critical) in [("initiated-first", false), ("initiated-latency-critical", true), ("initiated-restored", false)] {
        let before = try taskSnapshot()
        var phase = try measure(label, latencyCritical: critical)
        phase["requestedTaskPoliciesBeforeActivity"] = before
        phase["requestedTaskPoliciesAfterActivityEnded"] = try taskSnapshot()
        phases.append(phase)
        print("ACTUAL CPU TIMER CONTROL: \(label) frames=\(phase["frames"]!) missed=\(phase["missedCPUWakeDeadlines"]!) policy=\(phase["requestedTaskPoliciesDuringActivity"]!)")
    }
    report["completed"] = true
    passed = phases.allSatisfy { $0["allCPUWakeDeadlinesPassed"] as? Bool == true }
} catch {
    report["error"] = String(describing: error)
}
report["phases"] = phases
report["allCPUWakeDeadlinesPassed"] = passed
if !output.isEmpty {
    do {
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: output), options: .atomic)
    } catch { print("ACTUAL TIMER REPORT WRITE FAILED: \(error)"); passed = false }
}
exit(passed ? 0 : 1)
