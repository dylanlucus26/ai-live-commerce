import AppKit
import Foundation
import Darwin

// Cloud-only normal Quit of the exact OBS PID owned by the current test runner.
guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
      CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]), pid > 1,
      let app = NSRunningApplication(processIdentifier: pid),
      app.bundleIdentifier == "com.obsproject.obs-studio",
      app.executableURL?.path == "/Applications/OBS.app/Contents/MacOS/OBS" else {
    FileHandle.standardError.write(Data("Expected this cloud runner's exact existing OBS process\n".utf8))
    exit(2)
}
let accepted = app.terminate()
let deadline = Date(timeIntervalSinceNow: 15)
while accepted && !app.isTerminated && Date() < deadline {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
}
let result: [String: Any] = ["targetPID":Int(pid), "targetBundle":"com.obsproject.obs-studio",
    "normalQuitAccepted":accepted, "actualTerminated":app.isTerminated]
let data = try JSONSerialization.data(withJSONObject: result,options:[.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
if !accepted || !app.isTerminated { exit(1) }
