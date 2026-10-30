// Isolated GitHub macOS 26 diagnostic; never a product acceptance substitute.
import Foundation
import AppKit
import Dispatch
import Metal
import Darwin

struct ProbeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ value: String) { description = value }
}
var report: [String: Any] = ["purpose": "Independent LaunchServices AppKit Metal clear/readback control at actual sampled GUI thread priorities; never OBS, CEF or RTMP acceptance",
    "completed": false, "targetFPS": 30, "width": 1280, "height": 720]
var phases: [[String: Any]] = []
var partialRows: [[Double]] = []
var currentPhase = ""
var outputPath = ""
var passed = false
func seconds(_ value: UInt64) -> Double { Double(value)/1e9 }
func requestedQoSName() -> String {
    let value = qos_class_self()
    if value == QOS_CLASS_USER_INTERACTIVE { return "user-interactive" }
    if value == QOS_CLASS_USER_INITIATED { return "user-initiated" }
    if value == QOS_CLASS_DEFAULT { return "default" }
    if value == QOS_CLASS_UTILITY { return "utility" }
    if value == QOS_CLASS_BACKGROUND { return "background" }
    if value == QOS_CLASS_UNSPECIFIED { return "unspecified" }
    return "unrecognized"
}
func readActualOwnThreadInfo() throws -> thread_extended_info_data_t {
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
        throw ProbeFailure( "Actual THREAD_EXTENDED_INFO failed: status=\(status), count=\(count)")
    }
    return info
}
func actualOwnSchedulingVector() throws -> [Double] {
    let info = try readActualOwnThreadInfo()
    return [Double(info.pth_curpri), Double(info.pth_priority), Double(info.pth_maxpriority),
        Double(info.pth_policy), Double(info.pth_user_time), Double(info.pth_system_time)]
}
func actualOwnThreadInfo() throws -> [String: Any] {
    let info = try readActualOwnThreadInfo()
    return ["policyInEffect": info.pth_policy, "currentPriority": info.pth_curpri,
        "basePriority": info.pth_priority, "maxPriority": info.pth_maxpriority,
        "runState": info.pth_run_state, "flags": info.pth_flags,
        "userNS": info.pth_user_time, "systemNS": info.pth_system_time]
}
struct MachClock {
    let origin: UInt64
    let numer: UInt64
    let denom: UInt64
    init() throws {
        var info = mach_timebase_info_data_t()
        let status = mach_timebase_info(&info)
        guard status == KERN_SUCCESS && info.numer > 0 && info.denom > 0 else {
            throw ProbeFailure( "Actual mach_timebase_info failed: \(status)")
        }
        numer = UInt64(info.numer); denom = UInt64(info.denom)
        origin = mach_absolute_time()
    }
    func nowNS() -> UInt64 { (mach_absolute_time() - origin) * numer / denom }
    func deadlineTicks(_ offsetNS: UInt64) throws -> UInt64 {
        let product = offsetNS.multipliedReportingOverflow(by: denom)
        guard !product.overflow && product.partialValue <= UInt64.max - (numer - 1) else {
            throw ProbeFailure( "Mach deadline conversion overflow")
        }
        let ticks = (product.partialValue + numer - 1) / numer
        let result = origin.addingReportingOverflow(ticks)
        guard !result.overflow else { throw ProbeFailure( "Mach absolute deadline overflow") }
        return result.partialValue
    }
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
        throw ProbeFailure( "Actual own thread_policy_get failed: \(flavor), status=\(status), count=\(count)")
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
func schedulingSnapshot() throws -> [String: Any] {
    ["timeConstraint": try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4).json,
     "extended": try ownThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), count: 1).json,
     "precedence": try ownThreadPolicy(thread_policy_flavor_t(THREAD_PRECEDENCE_POLICY), count: 1).json,
     "actualOwnThreadInfo": try actualOwnThreadInfo()]
}
func restoreOwnTimeshare(_ fields: [integer_t], expected: [String: Any]) throws -> [String: Any] {
    let status = setOwnThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), fields: fields)
    guard status == KERN_SUCCESS else { throw ProbeFailure( "Original timeshare restore failed: \(status)") }
    // Mach policy changes permanently opt a pthread out of the QoS API.
    // All three legs now start in explicit ordinary Mach mode; never mix in a pthread QoS restore.
    let actual = try ownThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), count: 1)
    let rt = try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4)
    guard actual.returnedDefault == 0 && actual.fields == fields && rt.returnedDefault != 0,
        qos_class_self() == QOS_CLASS_UNSPECIFIED else {
        throw ProbeFailure( "Actual ordinary Mach baseline restoration not confirmed")
    }
    let info = try actualOwnThreadInfo()
    for key in ["policyInEffect", "basePriority", "maxPriority"] {
        guard let before = expected[key] as? Int32, let after = info[key] as? Int32, before == after else {
            throw ProbeFailure( "Original sampled scheduling field not restored: \(key)")
        }
    }
    return ["setterStatus": status, "actual": try schedulingSnapshot(),
        "requestedQoSIsUnspecifiedAsInMachBaseline": true]
}


let guiProfileTarget = ProcessInfo.processInfo.environment["AI_LIVE_GUI_PROFILE_TARGET"] == "true"
let guiDeadlineControl = ProcessInfo.processInfo.environment["AI_LIVE_GUI_DEADLINE_CONTROL"] == "true"
var guiBaselineExtended: [integer_t]? = nil
var guiBaselineInfo: [String: Any]? = nil
var guiRealtimeOutstanding = false
var currentWaitMethod = "qos-utility-first"
func pauseUntil(_ deadline: UInt64) throws {
    while true {
        let now = DispatchTime.now().uptimeNanoseconds
        if now >= deadline { return }
        let remainingNS = deadline-now
        if currentWaitMethod == "foundation-default" {
            Thread.sleep(forTimeInterval: Double(remainingNS)/1e9)
        } else {
            // Same relative nanosleep operation as pinned OBS platform-nix.c.
            var requested = timespec(tv_sec: Int(remainingNS/1_000_000_000),
                tv_nsec: Int(remainingNS%1_000_000_000))
            var remaining = timespec()
            while nanosleep(&requested, &remaining) != 0 {
                guard errno == EINTR else { throw ProbeFailure("Actual nanosleep failed: \(errno)") }
                requested = remaining
                remaining = timespec()
            }
        }
    }
}
func runIndependentProbe() {

do {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        throw ProbeFailure("Cloud-only diagnostic")
    }
    #if !arch(arm64)
    throw ProbeFailure("Requires the authorized ARM64 cloud machine")
    #endif
    guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 26 else {
        throw ProbeFailure("Must actually execute on macOS 26")
    }
    guard CommandLine.arguments.count == 3 else {
        throw ProbeFailure("Expected independent actual cloud preflight and output JSON paths")
    }
    outputPath = CommandLine.arguments[2]
    guard Bundle.main.bundleIdentifier == "org.ai-live-commerce.cloud-metal-control",
        let preflight = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as? [String: Any],
        preflight["runID"] as? String == ProcessInfo.processInfo.environment["GITHUB_RUN_ID"],
        preflight["actualOS"] as? String == "\(ProcessInfo.processInfo.operatingSystemVersion.majorVersion).\(ProcessInfo.processInfo.operatingSystemVersion.minorVersion).\(ProcessInfo.processInfo.operatingSystemVersion.patchVersion)",
        preflight["actualArchitecture"] as? String == "arm64",
        let observedAt = preflight["observedAt"] as? Double,
        abs(Date().timeIntervalSince1970 - observedAt) < 600,
        let obs = preflight["ownedObsProcesses"] as? [String], obs.isEmpty else {
        throw ProbeFailure("Actual independent cloud preflight/bundle/freshness does not match this process")
    }
    report["actualCloudPreflight"] = preflight
    if guiProfileTarget {
        guard !guiDeadlineControl else { throw ProbeFailure("Forensic GUI target never combines Mach mutation with tracing") }
        let root = URL(fileURLWithPath: outputPath).deletingLastPathComponent()
        let announced = root.appendingPathComponent("actual-gui-probe-start.json")
        let release = root.appendingPathComponent("actual-profiler-begin-work.json")
        guard !FileManager.default.fileExists(atPath: announced.path),
            !FileManager.default.fileExists(atPath: release.path) else {
            throw ProbeFailure("Stale forensic coordination files")
        }
        let start: [String: Any] = ["actualPID": ProcessInfo.processInfo.processIdentifier,
            "uid": getuid(), "bundleIdentifier": Bundle.main.bundleIdentifier ?? "",
            "bundlePath": Bundle.main.bundleURL.path, "executablePath": Bundle.main.executablePath ?? "",
            "runID": ProcessInfo.processInfo.environment["GITHUB_RUN_ID"] ?? "",
            "at": Date().timeIntervalSince1970, "initialActualThread": try actualOwnThreadInfo()]
        try JSONSerialization.data(withJSONObject: start, options: [.prettyPrinted, .sortedKeys])
            .write(to: announced, options: .atomic)
        let coordinationEnd = DispatchTime.now().uptimeNanoseconds + 30_000_000_000
        while !FileManager.default.fileExists(atPath: release.path) {
            guard DispatchTime.now().uptimeNanoseconds < coordinationEnd else {
                throw ProbeFailure("No bounded profiling attempt announcement; no trace readiness fabricated")
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        report["purpose"] = "FORENSIC ONLY: one minimal GUI clear stage, attached xctrace attempt, then normal quit. Tracing changes timing; never full six-phase or product performance acceptance."
        report["notPerformanceAcceptance"] = true
        report["profilerCoordination"] = try JSONSerialization.jsonObject(with: Data(contentsOf: release))
    }
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
        throw ProbeFailure("Actual Metal device or queue unavailable")
    }
    let allDevices = MTLCopyAllDevices()
    report["actualMetalDeviceNames"] = allDevices.map { $0.name }
    guard allDevices.count == 1, allDevices[0].name == device.name else {
        throw ProbeFailure("Cannot confirm a single actual Metal GPU")
    }
    let width = 1280, height = 720, stride = width*4, bytes = stride*height
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: .bgra8Unorm_srgb, width: width, height: height, mipmapped: false)
    descriptor.storageMode = .private
    descriptor.usage = [.renderTarget]
    descriptor.hazardTrackingMode = .tracked
    descriptor.allowGPUOptimizedContents = true
    guard let target = device.makeTexture(descriptor: descriptor),
        let stage = device.makeBuffer(length: bytes, options: .storageModeShared) else {
        throw ProbeFailure("Actual benchmark resources unavailable")
    }
    report["actualOS"] = ProcessInfo.processInfo.operatingSystemVersionString
    report["actualDevice"] = device.name
    report["hasUnifiedMemory"] = device.hasUnifiedMemory
    report["actualTarget"] = ["width": target.width, "height": target.height,
        "pixelFormat": target.pixelFormat.rawValue, "storageMode": target.storageMode.rawValue,
        "allowGPUOptimizedContents": target.allowGPUOptimizedContents, "usage": target.usage.rawValue]
    report["actualStageBytes"] = stage.length
    report["columns"] = ["frame", "targetStart", "cpuStart", "cpuCommit", "cpuCompleted", "deadline",
        "gpuStart", "gpuEnd", "kernelStart", "kernelEnd", "status", "errorCode", "pixelsChecked", "deadlineMet",
        "commitCurrentPriority", "commitBasePriority", "commitMaxPriority", "commitPolicy", "commitUserNS", "commitSystemNS",
        "completionCurrentPriority", "completionBasePriority", "completionMaxPriority", "completionPolicy", "completionUserNS", "completionSystemNS"]
    passed = true
    report["actualProbePID"] = ProcessInfo.processInfo.processIdentifier
    report["actualBundleIdentifier"] = Bundle.main.bundleIdentifier ?? ""
    report["actualBundleURL"] = Bundle.main.bundleURL.path
    report["actualExecutablePath"] = Bundle.main.executablePath ?? ""
    errno = 0
    let actualNice = getpriority(PRIO_PROCESS, 0)
    guard errno == 0 else { throw ProbeFailure("Actual own getpriority failed: \\(errno)") }
    report["actualProcessNice"] = actualNice
    guard actualNice == 0 else { throw ProbeFailure("GUI process nice differs from actual observed OBS nice=0") }
    report["actualThreadQualityOfService"] = Thread.current.qualityOfService.rawValue
    report["foundationQoSWasUtility"] = Thread.current.qualityOfService == .utility
    report["foundationQoSWasUserInteractive"] = Thread.current.qualityOfService == .userInteractive
    report["timerControlPurpose"] = guiProfileTarget ? "Single interactive GUI stage for attached system profiling. No Mach mutation or QoS ABA, not a performance acceptance run." : "Explicit utility -> user-interactive -> utility requested pthread QoS, same nanosleep/Metal resources/30FPS deadlines. No OBS process scheduler is changed. Requested QoS does not expose temporary kernel overrides."
    var originalRequestedQoS = qos_class_self()
    var originalRelativePriority: Int32 = 0
    let inspected = pthread_get_qos_class_np(pthread_self(), &originalRequestedQoS, &originalRelativePriority)
    guard inspected == 0 else { throw ProbeFailure("Cannot inspect actual requested pthread QoS: \(inspected)") }
    report["originalRequestedPthreadQoS"] = requestedQoSName()
    report["originalRequestedRelativePriority"] = originalRelativePriority
    defer {
        if guiDeadlineControl {
            report["requestedQoSAtExit"] = requestedQoSName()
            report["originalRequestedQoSRestoreNote"] = "Explicit Mach control permanently opts this independent worker out of pthread QoS. Restore the same prepared ordinary Mach baseline, never claim original pthread QoS restoration; own app then terminates."
        } else {
        if originalRequestedQoS != QOS_CLASS_UNSPECIFIED {
            let restored = pthread_set_qos_class_self_np(originalRequestedQoS, originalRelativePriority)
            report["originalRequestedQoSRestoreStatus"] = restored
            report["requestedQoSAtExit"] = requestedQoSName()
            if restored != 0 { passed = false }
        } else {
            report["requestedQoSAtExit"] = requestedQoSName()
            report["originalRequestedQoSRestoreNote"] = "Original requested class was unspecified, which the public setter cannot request; only this independent probe process was changed and now exits. A2 is explicitly utility."
        }
        }
    }
    let machClock = try MachClock()
    if guiDeadlineControl {
        report["purpose"] = "Independent GUI Metal, one own worker: explicit ordinary Mach baseline actual priority47 -> bounded period33.333ms computation1ms constraint2ms -> same ordinary baseline47. Same GPU/resources/nanosleep/30FPS, all clear/readback deadlines and pixel gates; never OBS/RTMP acceptance."
        report["initialActualScheduling"] = try schedulingSnapshot()
        let initial = try actualOwnThreadInfo()
        guard initial["basePriority"] as? Int32 == 47 && initial["maxPriority"] as? Int32 == 63 else {
            throw ProbeFailure("Initial GUI worker does not match observed actual OBS 47/63")
        }
        let ordinary = setOwnThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), fields: [1])
        guard ordinary == KERN_SUCCESS && qos_class_self() == QOS_CLASS_UNSPECIFIED else {
            throw ProbeFailure("Explicit ordinary Mach baseline failed")
        }
        let precedence = try ownThreadPolicy(thread_policy_flavor_t(THREAD_PRECEDENCE_POLICY), count: 1)
        let info = try actualOwnThreadInfo()
        guard let base = info["basePriority"] as? Int32 else { throw ProbeFailure("Missing actual ordinary base") }
        let importance = precedence.fields[0] + (47 - base)
        let importanceStatus = setOwnThreadPolicy(thread_policy_flavor_t(THREAD_PRECEDENCE_POLICY), fields: [importance])
        guard importanceStatus == KERN_SUCCESS else { throw ProbeFailure("Own baseline precedence request failed") }
        let prepared = try actualOwnThreadInfo()
        let timeshare = try ownThreadPolicy(thread_policy_flavor_t(THREAD_EXTENDED_POLICY), count: 1)
        let inactiveRT = try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4)
        guard prepared["basePriority"] as? Int32 == 47, prepared["maxPriority"] as? Int32 == 63,
            timeshare.fields == [1] && timeshare.returnedDefault == 0 && inactiveRT.returnedDefault != 0 else {
            throw ProbeFailure("Actual prepared47/63 ordinary Mach context not confirmed")
        }
        guiBaselineExtended = timeshare.fields; guiBaselineInfo = prepared
        report["preparedOrdinaryMachBaseline"] = try schedulingSnapshot()
        report["ordinaryBaselineSetters"] = ["extended": ordinary, "precedence": importanceStatus,
            "actualRequestedImportance": importance]
        report["machTimebase"] = ["numer": machClock.numer, "denom": machClock.denom]
    }
    let methods = guiProfileTarget ? ["qos-user-interactive"] : guiDeadlineControl ?
        ["mach-ordinary-first", "mach-bounded-middle", "mach-ordinary-restored"] :
        ["qos-utility-first", "qos-user-interactive", "qos-utility-restored"]
    for method in methods {
      currentWaitMethod = method
      let requested = method == "qos-user-interactive" ? QOS_CLASS_USER_INTERACTIVE : QOS_CLASS_UTILITY
      if guiDeadlineControl {
          if method == "mach-bounded-middle" {
              func ticks(_ ns: UInt64) throws -> integer_t {
                  let value = try machClock.deadlineTicks(ns) - machClock.origin
                  guard value <= UInt64(Int32.max) else { throw ProbeFailure("Policy tick field overflow") }
                  return integer_t(value)
              }
              let fields: [integer_t] = [try ticks(33_333_333), try ticks(1_000_000), try ticks(2_000_000), 1]
              guiRealtimeOutstanding = true
              let status = setOwnThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), fields: fields)
              report["boundedDeadlineRequest"] = ["setterStatus": status, "rawRequestedFields": fields,
                  "periodNS": 33_333_333, "computationNS": 1_000_000, "constraintNS": 2_000_000]
              guard status == KERN_SUCCESS else { throw ProbeFailure("Own bounded deadline setter rejected") }
              let actual = try ownThreadPolicy(thread_policy_flavor_t(THREAD_TIME_CONSTRAINT_POLICY), count: 4)
              guard actual.returnedDefault == 0 && actual.fields == fields else {
                  throw ProbeFailure("Bounded deadline readback not confirmed")
              }
              report["boundedDeadlineReadback"] = actual.json
          } else if guiRealtimeOutstanding, let guiBaselineExtended, let guiBaselineInfo {
              report["originalMachBaselineRestored"] = try restoreOwnTimeshare(guiBaselineExtended, expected: guiBaselineInfo)
              guiRealtimeOutstanding = false
          }
          var changes = report["actualMachSchedulingChanges"] as? [[String: Any]] ?? []
          changes.append(["phaseGroup": method, "actual": try schedulingSnapshot()])
          report["actualMachSchedulingChanges"] = changes
      } else {
          let status = pthread_set_qos_class_self_np(requested, 0)
          guard status == 0 && qos_class_self() == requested else {
              throw ProbeFailure("Actual requested QoS change failed for \(method): \(status)")
          }
          var changes = report["actualPthreadQoSChanges"] as? [[String: Any]] ?? []
          changes.append(["phaseGroup": method, "setterStatus": status,
              "readBackRequestedClass": requestedQoSName(), "foundationQoS": Thread.current.qualityOfService.rawValue])
          report["actualPthreadQoSChanges"] = changes
      }
      for readback in (guiProfileTarget ? [false] : [false, true]) {
        currentPhase = method + (readback ? "-clear-plus-full-readback" : "-clear-only")
        partialRows = []
        var gpuErrors = 0, missingTimestamps = 0, missedDeadlines = 0, pixelMismatches = 0
        var maximumGPUSeconds = 0.0, maximumCompletionSeconds = 0.0
        var actualSchedulingSamples: [[String: Any]] = []
        let actualSchedulingBefore = try actualOwnThreadInfo()
        let expectedPriority: Int32 = guiDeadlineControl ? (method == "mach-bounded-middle" ? 97 : 47) : (requested == QOS_CLASS_USER_INTERACTIVE ? 47 : 20)
        report["currentPhaseSchedulingBefore"] = try schedulingSnapshot()
        guard actualSchedulingBefore["basePriority"] as? Int32 == expectedPriority,
            actualSchedulingBefore["maxPriority"] as? Int32 == 63,
            actualSchedulingBefore["policyInEffect"] as? Int32 == (method == "mach-bounded-middle" ? 2 : 1),
            !guiDeadlineControl || qos_class_self() == QOS_CLASS_UNSPECIFIED else {
            throw ProbeFailure("Actual GUI thread scheduling context does not match the observed GUI task; no substitute context accepted")
        }
        let started = DispatchTime.now().uptimeNanoseconds
        for frame in 0..<1800 {
            let due = started + UInt64(frame)*1_000_000_000/30
            let deadline = started + UInt64(frame+1)*1_000_000_000/30
            try pauseUntil(due)
            if frame % 150 == 0 {
                actualSchedulingSamples.append(["frame": frame, "at": seconds(DispatchTime.now().uptimeNanoseconds),
                    "actual": try actualOwnThreadInfo()])
            }
            try autoreleasepool {
                let cpuStart = DispatchTime.now().uptimeNanoseconds
                guard let buffer = queue.makeCommandBuffer() else {
                    throw ProbeFailure("Actual command buffer allocation failed")
                }
                let pass = MTLRenderPassDescriptor()
                pass.colorAttachments[0].texture = target
                pass.colorAttachments[0].loadAction = .clear
                pass.colorAttachments[0].storeAction = .store
                pass.colorAttachments[0].clearColor = frame%2 == 0 ?
                    MTLClearColor(red: 0, green: 1, blue: 0, alpha: 1) :
                    MTLClearColor(red: 0, green: 0, blue: 1, alpha: 1)
                guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else {
                    throw ProbeFailure("Actual render encoder allocation failed")
                }
                encoder.endEncoding()
                if readback {
                    guard let blit = buffer.makeBlitCommandEncoder() else {
                        throw ProbeFailure("Actual readback encoder allocation failed")
                    }
                    blit.copy(from: target, sourceSlice: 0, sourceLevel: 0,
                        sourceOrigin: .init(x: 0, y: 0, z: 0),
                        sourceSize: .init(width: width, height: height, depth: 1),
                        to: stage, destinationOffset: 0, destinationBytesPerRow: stride, destinationBytesPerImage: 0)
                    blit.endEncoding()
                }
                let actualAtCommit = try actualOwnSchedulingVector()
                let commit = DispatchTime.now().uptimeNanoseconds
                buffer.commit()
                buffer.waitUntilCompleted()
                let complete = DispatchTime.now().uptimeNanoseconds
                let actualAtCompletion = try actualOwnSchedulingVector()
                let healthy = buffer.status == .completed && buffer.error == nil
                if !healthy { gpuErrors += 1 }
                if buffer.gpuStartTime <= 0 || buffer.gpuEndTime < buffer.gpuStartTime { missingTimestamps += 1 }
                if complete > deadline { missedDeadlines += 1 }
                if readback && healthy {
                    let pixels = stage.contents().assumingMemoryBound(to: UInt8.self)
                    for offset in [0, (width-1)*4, (height-1)*stride, bytes-4] {
                        let green: UInt8 = frame%2 == 0 ? 255 : 0
                        let blue: UInt8 = frame%2 == 0 ? 0 : 255
                        if pixels[offset] != blue || pixels[offset+1] != green ||
                            pixels[offset+2] != 0 || pixels[offset+3] != 255 { pixelMismatches += 1 }
                    }
                }
                maximumGPUSeconds = max(maximumGPUSeconds, buffer.gpuEndTime-buffer.gpuStartTime)
                maximumCompletionSeconds = max(maximumCompletionSeconds, seconds(complete-cpuStart))
                var row: [Double] = []
                row.append(Double(frame)); row.append(seconds(due)); row.append(seconds(cpuStart))
                row.append(seconds(commit)); row.append(seconds(complete)); row.append(seconds(deadline))
                row.append(buffer.gpuStartTime); row.append(buffer.gpuEndTime)
                row.append(buffer.kernelStartTime); row.append(buffer.kernelEndTime)
                row.append(Double(buffer.status.rawValue))
                let errorCode: Double = buffer.error.map { Double(($0 as NSError).code) } ?? 0
                row.append(errorCode); row.append(readback && healthy ? 1 : 0)
                row.append(complete <= deadline ? 1 : 0)
                row.append(contentsOf: actualAtCommit)
                row.append(contentsOf: actualAtCompletion)
                partialRows.append(row)
            }
        }
        try pauseUntil(started + 60_000_000_000)
        var finalPixelsChecked = readback && gpuErrors == 0 && pixelMismatches == 0
        var tailVerification: [String: Any] = ["perFrameReadback": readback]
        if !readback {
            // Independent read of the final clear. Outside the timed phase, recorded explicitly.
            guard let copy = queue.makeCommandBuffer(), let blit = copy.makeBlitCommandEncoder() else {
                throw ProbeFailure("Final independent verification allocation failed")
            }
            blit.copy(from: target, sourceSlice: 0, sourceLevel: 0,
                sourceOrigin: .init(x: 0, y: 0, z: 0),
                sourceSize: .init(width: width, height: height, depth: 1),
                to: stage, destinationOffset: 0, destinationBytesPerRow: stride, destinationBytesPerImage: 0)
            blit.endEncoding()
            let copyBefore = DispatchTime.now().uptimeNanoseconds
            copy.commit(); copy.waitUntilCompleted()
            tailVerification["cpuBefore"] = seconds(copyBefore)
            tailVerification["cpuCompleted"] = seconds(DispatchTime.now().uptimeNanoseconds)
            tailVerification["gpuStart"] = copy.gpuStartTime
            tailVerification["gpuEnd"] = copy.gpuEndTime
            tailVerification["status"] = copy.status.rawValue
            tailVerification["errorCode"] = copy.error.map { ($0 as NSError).code } ?? 0
            if copy.status != .completed || copy.error != nil { gpuErrors += 1 }
            else {
                let p = stage.contents().assumingMemoryBound(to: UInt8.self)
                finalPixelsChecked = p[0] == 255 && p[1] == 0 && p[2] == 0 && p[3] == 255
                if !finalPixelsChecked { pixelMismatches += 1 }
            }
        }
        let healthy = gpuErrors == 0 && missingTimestamps == 0 && pixelMismatches == 0 && finalPixelsChecked
        let expectedPolicy = method == "mach-bounded-middle" ? 2.0 : 1.0
        let unexpectedPointContexts = partialRows.filter { row in
            row[15] != Double(expectedPriority) || row[16] != 63 || row[17] != expectedPolicy ||
            row[21] != Double(expectedPriority) || row[22] != 63 || row[23] != expectedPolicy
        }.count
        let timingPassed = healthy && missedDeadlines == 0 && unexpectedPointContexts == 0
        let actualSchedulingAfter = try actualOwnThreadInfo()
        guard actualSchedulingAfter["basePriority"] as? Int32 == expectedPriority,
            actualSchedulingAfter["maxPriority"] as? Int32 == 63,
            actualSchedulingSamples.allSatisfy({ item in
                guard let info = item["actual"] as? [String: Any] else { return false }
                return info["basePriority"] as? Int32 == expectedPriority && info["maxPriority"] as? Int32 == 63
            }) else { throw ProbeFailure("Actual GUI scheduling context changed during phase") }
        let cpuLateCount = partialRows.filter { (row: [Double]) -> Bool in row[2] > row[5] }.count
        let gpuOverBudgetCount = partialRows.filter { (row: [Double]) -> Bool in row[7]-row[6] > 1.0/30.0 }.count
        let maxCPUStartLateness: Double = partialRows.map { (row: [Double]) -> Double in row[2]-row[1] }.max() ?? 0
        let phase: [String: Any] = ["label": currentPhase, "waitMethod": method,
            "userInitiatedActivityRequested": false, "threadQoS": Thread.current.qualityOfService.rawValue,
            "requestedPthreadQoSClass": requestedQoSName(),
            "actualSchedulingBefore": actualSchedulingBefore, "actualSchedulingAfter": actualSchedulingAfter,
            "actualFullMachSchedulingAfter": try schedulingSnapshot(),
            "actualSchedulingSamples": actualSchedulingSamples,
            "unexpectedSchedulingAtGPUCommitOrCompletion": unexpectedPointContexts,
            "schedulingPointEvidenceBoundary": "Read-only THREAD_EXTENDED_INFO immediately before each actual commit and after wait returns. CPU deltas include this observer. These points cannot rule out a transient scheduling change entirely inside a GPU wait.",
            "frames": partialRows.count,
            "elapsedSeconds": seconds(DispatchTime.now().uptimeNanoseconds-started),
            "readbackEachFrame": readback, "finalPixelsVerified": finalPixelsChecked, "tailVerification": tailVerification,
            "gpuErrors": gpuErrors, "missingGPUTimestamps": missingTimestamps,
            "pixelMismatches": pixelMismatches, "missedFrameDeadlines": missedDeadlines,
            "cpuStartedAfterDeadline": cpuLateCount,
            "gpuExecutionOverFrameBudget": gpuOverBudgetCount,
            "maximumCPUStartLatenessSeconds": maxCPUStartLateness,
            "maximumGPUSeconds": maximumGPUSeconds, "maximumCompletionSeconds": maximumCompletionSeconds,
            "healthy": healthy, "timingPassed": timingPassed, "samples": partialRows]
        phases.append(phase)
        print("ACTUAL RAW METAL PHASE: \(currentPhase) frames=\(partialRows.count) gpuErrors=\(gpuErrors) missedDeadlines=\(missedDeadlines) maxGPUms=\(maximumGPUSeconds*1000)")
        if !timingPassed { passed = false }
        partialRows = []
      }
    }
    report["completed"] = true
} catch {
    report["error"] = String(describing: error)
    report["partialPhase"] = currentPhase
    report["partialSamples"] = partialRows
    passed = false
}
if guiRealtimeOutstanding, let guiBaselineExtended, let guiBaselineInfo {
    do {
        report["originalMachBaselineRestoredAfterFailure"] = try restoreOwnTimeshare(guiBaselineExtended, expected: guiBaselineInfo)
        guiRealtimeOutstanding = false
    } catch { report["machBaselineRestoreError"] = String(describing: error); passed = false }
}
report["phases"] = phases
report["allThirtyFPSDeadlinesAndGPUChecksPassed"] = passed
if !outputPath.isEmpty {
    do {
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    } catch { print("RAW METAL REPORT WRITE FAILED: \(error)"); passed = false }
}
}
final class CloudMetalDelegate: NSObject, NSApplicationDelegate {
    var worker: Thread?
    var window: NSWindow?
    func applicationDidFinishLaunching(_ notification: Notification) {
        let controlWindow = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 480, height: 120),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        controlWindow.title = "Isolated cloud Metal diagnostic"
        controlWindow.makeKeyAndOrderFront(nil)
        window = controlWindow
        NSApplication.shared.activate(ignoringOtherApps: true)
        let ownWorker = Thread {
            runIndependentProbe()
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        ownWorker.name = "cloud-metal-independent-control"
        ownWorker.qualityOfService = .userInteractive
        worker = ownWorker
        ownWorker.start()
    }
}
let application = NSApplication.shared
let cloudDelegate = CloudMetalDelegate()
application.setActivationPolicy(.regular)
application.delegate = cloudDelegate
application.run()
