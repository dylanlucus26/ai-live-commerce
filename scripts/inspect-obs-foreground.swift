import AppKit
import Foundation
import Darwin

// Cloud diagnosis only. Inspect or activate this job's existing OBS PID; never launch an app.
guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
      CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      ["status", "activate"].contains(CommandLine.arguments[2]),
      let obsApp = NSRunningApplication(processIdentifier: pid),
      obsApp.bundleIdentifier == "com.obsproject.obs-studio" else {
    FileHandle.standardError.write(Data("Expected the isolated cloud job's existing OBS process\n".utf8))
    exit(2)
}
let activate = CommandLine.arguments[2] == "activate"
var accepted = false
if activate {
    accepted = obsApp.activate(options: [.activateIgnoringOtherApps])
    for _ in 0..<20 {
        if NSWorkspace.shared.frontmostApplication?.isEqual(obsApp) == true { break }
        Thread.sleep(forTimeInterval: 0.1)
    }
}
let front = NSWorkspace.shared.frontmostApplication
let actual = front?.isEqual(obsApp) == true
let state: [String: Any] = [
    "targetPID": Int(pid),
    "targetBundle": obsApp.bundleIdentifier ?? "",
    "frontmostPID": Int(front?.processIdentifier ?? -1),
    "frontmostBundle": front?.bundleIdentifier ?? "",
    "activationRequested": activate,
    "activationAccepted": accepted,
    "targetIsFrontmost": actual
]
let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
if activate && !actual { exit(1) }
