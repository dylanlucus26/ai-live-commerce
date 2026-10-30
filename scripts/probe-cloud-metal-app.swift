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
        throw ProbeFailure( "Actual THREAD_EXTENDED_INFO failed: status=\(status), count=\(count)")
    }
    return ["policyInEffect": info.pth_policy, "currentPriority": info.pth_curpri,
        "basePriority": info.pth_priority, "maxPriority": info.pth_maxpriority,
        "runState": info.pth_run_state, "flags": info.pth_flags,
        "userNS": info.pth_user_time, "systemNS": info.pth_system_time]
}
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
        "gpuStart", "gpuEnd", "kernelStart", "kernelEnd", "status", "errorCode", "pixelsChecked", "deadlineMet"]
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
    report["timerControlPurpose"] = "Explicit utility -> user-interactive -> utility requested pthread QoS, same nanosleep/Metal resources/30FPS deadlines. No OBS process scheduler is changed. Requested QoS does not expose temporary kernel overrides."
    var originalRequestedQoS = qos_class_self()
    var originalRelativePriority: Int32 = 0
    let inspected = pthread_get_qos_class_np(pthread_self(), &originalRequestedQoS, &originalRelativePriority)
    guard inspected == 0 else { throw ProbeFailure("Cannot inspect actual requested pthread QoS: \(inspected)") }
    report["originalRequestedPthreadQoS"] = requestedQoSName()
    report["originalRequestedRelativePriority"] = originalRelativePriority
    defer {
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
    for method in ["qos-utility-first", "qos-user-interactive", "qos-utility-restored"] {
      currentWaitMethod = method
      let requested = method == "qos-user-interactive" ? QOS_CLASS_USER_INTERACTIVE : QOS_CLASS_UTILITY
      let status = pthread_set_qos_class_self_np(requested, 0)
      guard status == 0 && qos_class_self() == requested else {
          throw ProbeFailure("Actual requested QoS change failed for \(method): \(status)")
      }
      var changes = report["actualPthreadQoSChanges"] as? [[String: Any]] ?? []
      changes.append(["phaseGroup": method, "setterStatus": status,
          "readBackRequestedClass": requestedQoSName(), "foundationQoS": Thread.current.qualityOfService.rawValue])
      report["actualPthreadQoSChanges"] = changes
      for readback in [false, true] {
        currentPhase = method + (readback ? "-clear-plus-full-readback" : "-clear-only")
        partialRows = []
        var gpuErrors = 0, missingTimestamps = 0, missedDeadlines = 0, pixelMismatches = 0
        var maximumGPUSeconds = 0.0, maximumCompletionSeconds = 0.0
        var actualSchedulingSamples: [[String: Any]] = []
        let actualSchedulingBefore = try actualOwnThreadInfo()
        let expectedPriority: Int32 = requested == QOS_CLASS_USER_INTERACTIVE ? 47 : 20
        guard actualSchedulingBefore["basePriority"] as? Int32 == expectedPriority,
            actualSchedulingBefore["maxPriority"] as? Int32 == 63 else {
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
                let commit = DispatchTime.now().uptimeNanoseconds
                buffer.commit()
                buffer.waitUntilCompleted()
                let complete = DispatchTime.now().uptimeNanoseconds
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
        let timingPassed = healthy && missedDeadlines == 0
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
            "actualSchedulingSamples": actualSchedulingSamples,
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
