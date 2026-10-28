#!/usr/bin/env bash
set -euo pipefail

# Real official macOS OBS Studio with real loopback FFmpeg RTMP listener.
# No OBS account, Douyin account, remote stream destination or paid API needed.
LOG_DIR=/tmp/ai-live-real-obs
mkdir -p "$LOG_DIR/recordings"
export AI_LIVE_RTMP_RECORD_DIR="$LOG_DIR/recordings"
export AI_LIVE_OBS_LOG_DIR="$LOG_DIR"
export AI_LIVE_OBS_TEST_PASSWORD=obs-local-ci-only

obs_pid=
receiver_pid=
cleanup() {
  echo "=== OBS diagnostic lines ==="
  if [[ -f "$LOG_DIR/obs-native.log" ]]; then
    cp "$LOG_DIR/obs-native.log" "$LOG_DIR/obs.log" || true
  elif [[ -f "$LOG_DIR/obs-offscreen.log" ]]; then
    cp "$LOG_DIR/obs-offscreen.log" "$LOG_DIR/obs.log" || true
  fi
  if [[ -f "$LOG_DIR/obs.log" ]]; then
    grep -E -i 'websocket|browser|CEF|plugin|error|warning|scene|stream' "$LOG_DIR/obs.log" | tail -n 120 || true
    tail -n 25 "$LOG_DIR/obs.log" || true
  fi
  # OBS GUI logs plugin loading (including obs-websocket) in its own logs directory.
  obs_logs="$HOME/Library/Application Support/obs-studio/logs"
  if [[ -d "$obs_logs" ]]; then
    recent=$(ls -t "$obs_logs"/*.txt 2>/dev/null | head -n1 || true)
    if [[ -n "$recent" ]]; then
      cp "$recent" "$LOG_DIR/obs-internal.log" || true
      echo "=== OBS internal plugin diagnostics ==="
      grep -Ei 'obs-websocket|websocket|browser|plugin|fatal|error|warning' "$recent" | tail -n 120 || true
    fi
  fi
  lsof -nP -iTCP:4455 -sTCP:LISTEN || true
  echo "=== FFmpeg RTMP listener tail ==="
  tail -n 75 "$LOG_DIR/rtmp-listener.log" 2>/dev/null || true
  if [[ -z "$obs_pid" ]]; then
    obs_pid=$(pgrep -n -f '/Applications/OBS.app/Contents/MacOS/OBS' || true)
  fi
  if [[ -n "$obs_pid" ]]; then kill -CONT "$obs_pid" 2>/dev/null || true; kill "$obs_pid" 2>/dev/null || true; fi
  if [[ -n "${launch_pid:-}" ]]; then kill "$launch_pid" 2>/dev/null || true; fi
  if [[ -n "$receiver_pid" ]]; then kill "$receiver_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

command -v ffmpeg
OBS_BINARY="/Applications/OBS.app/Contents/MacOS/OBS"
if [[ ! -x "$OBS_BINARY" ]]; then
  echo "Official OBS.app was not installed at expected macOS path" >&2
  exit 1
fi

# Initialize CI-only OBS profile with scene collection before launching the app.
node scripts/prepare-obs-ci-profile.mjs

# FFmpeg is a real RTMP listening receiver: it remuxes the incoming OBS stream
# to FLV without changing tracks. The Node verifier later uses FFprobe on this file.
ffmpeg -nostdin -hide_banner -loglevel info \
  -listen 1 -i rtmp://127.0.0.1:1935/live/ci-validation-only \
  -c copy -f flv -y "$LOG_DIR/recordings/actual-obs.flv" \
  > "$LOG_DIR/rtmp-listener.log" 2>&1 &
receiver_pid=$!

sleep 2
kill -0 "$receiver_pid" 2>/dev/null || {
  echo "FFmpeg failed to start its localhost RTMP listener" >&2
  exit 1
}

# GitHub-hosted macOS may have no permission-granted GUI session. We use
# real OBS + real CEF Browser Source and do NOT request desktop/camera capture.
# First try Qt's offscreen platform backend; fall back to a bounded GUI attempt.
echo "macOS: $(sw_vers -productVersion), arch: $(uname -m), uid: $(id -u)"
echo "Runner session: XPC_SERVICE_NAME=$(printenv XPC_SERVICE_NAME || true)"
echo "WindowServer: $(pgrep -fl WindowServer | head -n 4 || true)"
echo "Qt platform plugins bundled in OBS:"
find /Applications/OBS.app/Contents \( -iname '*offscreen*' -o -iname '*qcocoa*' \) | head -n 24 || true
echo "OBS code signature:"
codesign -dv --verbose=2 /Applications/OBS.app 2>&1 | tail -n 12 || true

obs_args=(
  --multi --disable-updater --disable-missing-files-check
  --profile AI-Live-CI --collection AI-Live-CI
  --websocket_port 4455 --websocket_password obs-local-ci-only
  --websocket_ipv4_only
)
launch_mode="$(printenv AI_LIVE_MAC_OBS_LAUNCH || printf native)"
ready=false
wait_for_websocket() {
  local mode="$1" max_attempts="$2" proc_pid="$3" attempt state
  for attempt in $(seq 1 "$max_attempts"); do
    if nc -z 127.0.0.1 4455 2>/dev/null; then
      ready=true
      echo "OBS WebSocket 4455 listening after $attempt attempts ($mode)"
      return 0
    fi
    if [[ -n "$proc_pid" ]]; then
      if ! kill -0 "$proc_pid" 2>/dev/null; then
        echo "$mode process $proc_pid exited before OBS WebSocket was ready"
        return 1
      fi
      state=$(ps -p "$proc_pid" -o stat= | tr -d ' ' || true)
      if [[ "$state" == T* ]]; then
        echo "$mode OBS PID=$proc_pid stopped ($state), sending SIGCONT (no TCC changes)"
        kill -CONT "$proc_pid" 2>/dev/null || true
      fi
    fi
    if (( attempt % 10 == 0 )); then
      echo "Waiting $mode official OBS WebSocket (attempt $attempt/$max_attempts)"
      ps -axo pid,ppid,state,command | grep -E '/OBS.app/Contents/MacOS/OBS|/usr/bin/open -na' | grep -v grep | head -n 12 || true
    fi
    sleep 1
  done
  return 1
}

# Start the official signed OBS.app binary in the current user's existing
# Cocoa/WindowServer session. Qt offscreen crashes with SIGSEGV 11 after OBS
# initializes WebSocket and scenes on macOS 15/26 CI, so do not use it as
# the primary launch strategy. This does not alter any TCC permission.
if [[ "$launch_mode" == "native" || "$launch_mode" == "auto" ]]; then
  echo "Starting official OBS via native Qt Cocoa (no QT offscreen)"
  (
    cd /Applications/OBS.app/Contents/MacOS
    exec env QT_QPA_PLATFORM=cocoa QT_DEBUG_PLUGINS=1 \
      "$OBS_BINARY" "${obs_args[@]}"
  ) > "$LOG_DIR/obs-native.log" 2>&1 &
  obs_pid=$!
  wait_for_websocket "Qt-cocoa-native" 45 "$obs_pid" || true
  if [[ "$ready" != true ]]; then
    echo "Native Qt Cocoa OBS was not ready. Last 85 diagnostic lines:"
    tail -n 85 "$LOG_DIR/obs-native.log" || true
    if kill -0 "$obs_pid" 2>/dev/null; then
      kill -CONT "$obs_pid" 2>/dev/null || true
      kill "$obs_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$obs_pid" 2>/dev/null || true
    fi
    wait "$obs_pid" 2>/dev/null || true
    obs_pid=
  fi
fi

if [[ "$launch_mode" == "offscreen" || "$launch_mode" == "auto" ]]; then
  echo "Starting actual OBS.app executable with Qt offscreen QPA"
  (
    cd /Applications/OBS.app/Contents/MacOS
    exec env QT_QPA_PLATFORM=offscreen QT_DEBUG_PLUGINS=1 \
      "$OBS_BINARY" "${obs_args[@]}"
  ) > "$LOG_DIR/obs-offscreen.log" 2>&1 &
  obs_pid=$!
  wait_for_websocket "Qt-offscreen" 35 "$obs_pid" || true
  if [[ "$ready" != true ]]; then
    echo "Qt-offscreen did not expose OBS WebSocket. Last 75 diagnostics:"
    tail -n 75 "$LOG_DIR/obs-offscreen.log" || true
    if kill -0 "$obs_pid" 2>/dev/null; then
      kill "$obs_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$obs_pid" 2>/dev/null || true
    fi
    wait "$obs_pid" 2>/dev/null || true
    obs_pid=
  fi
fi
if [[ "$ready" != true && "$launch_mode" != "offscreen-only" ]]; then
  echo "Trying official OBS through LaunchServices GUI"
  /usr/bin/open -na /Applications/OBS.app --args "${obs_args[@]}" \
    < /dev/null > "$LOG_DIR/launchservices.log" 2>&1 &
  launch_pid=$!
  wait_for_websocket "LaunchServices" 50 "" || true
  if [[ "$ready" == true ]]; then
    obs_pid=$(pgrep -n -f '/Applications/OBS.app/Contents/MacOS/OBS' || true)
  fi
fi
if [[ "$ready" != true ]]; then
  echo "FAIL: real OBS did not expose authenticated WebSocket in either launch mode" >&2
  echo "=== macOS GUI process state ==="
  ps -axo pid,ppid,state,command | grep -E 'OBS.app|WindowServer|/usr/bin/open -na' | grep -v grep | head -n 55 || true
  echo "=== LaunchServices stderr ==="
  cat "$LOG_DIR/launchservices.log" 2>/dev/null || true
  echo "=== Qt native Cocoa output ==="
  tail -n 100 "$LOG_DIR/obs-native.log" 2>/dev/null || true
  echo "=== Qt offscreen output ==="
  tail -n 100 "$LOG_DIR/obs-offscreen.log" 2>/dev/null || true
  echo "=== OBS diagnostic crash reports ==="
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -iname 'OBS*' -print 2>/dev/null | tail -n 15 || true
  echo "=== macOS TCC and UI log ==="
  /usr/bin/log show --last 90s --style compact --predicate 'process == "OBS" && (eventMessage CONTAINS[c] "TCC" || eventMessage CONTAINS[c] "permission" || eventMessage CONTAINS[c] "window")' 2>/dev/null | tail -n 30 || true
  exit 1
fi

echo "PASS: official Mac OBS WebSocket is listening; app PID=${obs_pid:-unavailable}"
lsof -nP -iTCP:4455 -sTCP:LISTEN || true

pnpm exec tsx scripts/test-real-obs-rtmp.mjs
echo "PASS official macOS OBS.app -> real FFmpeg RTMP listener -> FFprobe A/V"
