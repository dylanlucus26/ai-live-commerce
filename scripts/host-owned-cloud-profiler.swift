import AppKit
import Foundation
import Darwin
#if !arch(arm64)
#error("Authorized cloud ARM64 only")
#endif

final class CloudProfilerHost: NSObject, NSApplicationDelegate {
    var child: Process?
    var window: NSWindow?
    var state: [String: Any] = [:]
    let output = URL(fileURLWithPath: "/tmp/ai-live-cloud-timer-policy/actual-profiler-host.json")
    func save() throws {
        let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: output, options: .atomic)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let env = ProcessInfo.processInfo.environment
            guard env["GITHUB_ACTIONS"] == "true",
                ProcessInfo.processInfo.operatingSystemVersion.majorVersion == 26,
                let runID = env["GITHUB_RUN_ID"], !runID.isEmpty else {
                throw NSError(domain: "CloudOnlyProfilerHost", code: 1)
            }
            let args = CommandLine.arguments
            let expectedBundle = URL(fileURLWithPath: "/tmp/ai-live-cloud-timer-policy/CloudProfilerHost.app")
            guard args.count == 4, args[1].hasPrefix("/"), args[2].hasPrefix("/"),
                args[3].hasPrefix("/"), args[2].hasSuffix("/scripts/profile-owned-cloud-metal-app.py"),
                Bundle.main.bundleIdentifier == "org.ai-live-commerce.cloud-profiler-host",
                Bundle.main.bundleURL.resolvingSymlinksInPath() == expectedBundle.resolvingSymlinksInPath() else {
                throw NSError(domain: "ActualProfilerHostArguments", code: 2)
            }
            let control = NSWindow(contentRect: NSRect(x: 80, y: 240, width: 480, height: 100),
                styleMask: [.titled], backing: .buffered, defer: false)
            control.title = "Owned cloud profiler collector"
            control.makeKeyAndOrderFront(nil); window = control
            NSApplication.shared.activate(ignoringOtherApps: true)
            state = ["purpose": "FORENSIC collector launch context only; never product performance acceptance",
                "completed": false, "actualHostPID": ProcessInfo.processInfo.processIdentifier,
                "actualHostParentPID": getppid(), "uid": getuid(), "runID": runID,
                "at": Date().timeIntervalSince1970, "actualBundleIdentifier": Bundle.main.bundleIdentifier ?? "",
                "actualBundlePath": Bundle.main.bundleURL.path,
                "actualHostExecutable": Bundle.main.executableURL?.path ?? "",
                "actualPythonPath": args[1], "actualScript": args[2], "actualWorkingDirectory": args[3]]
            try save()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: args[1])
            process.arguments = [args[2]]
            process.currentDirectoryURL = URL(fileURLWithPath: args[3])
            process.environment = env
            process.standardOutput = FileHandle.standardOutput
            process.standardError = FileHandle.standardError
            child = process
            try process.run()
            state["actualPythonPID"] = process.processIdentifier
            try save()
            DispatchQueue.global(qos: .userInitiated).async {
                process.waitUntilExit()
                DispatchQueue.main.async {
                    self.state["actualPythonExit"] = process.terminationStatus
                    self.state["actualPythonTerminationReason"] = String(describing: process.terminationReason)
                    self.state["actualPythonExitedNormally"] = process.terminationReason == .exit
                    self.state["completed"] = true
                    self.state["finishedAt"] = Date().timeIntervalSince1970
                    do { try self.save() }
                    catch { print("Actual profiler-host exit report failed: \(error)") }
                    NSApplication.shared.terminate(nil)
                }
            }
        } catch {
            state["error"] = String(describing: error)
            state["completed"] = false
            try? save()
            print("Actual profiler-host launch failed: \(error)")
            NSApplication.shared.terminate(nil)
        }
    }
}
let app = NSApplication.shared
let delegate = CloudProfilerHost()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
