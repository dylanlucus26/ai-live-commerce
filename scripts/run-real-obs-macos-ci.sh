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

# Launch through macOS LaunchServices so the GUI/CEF plugin host initializes
# in the runner's graphical login session. Directly exec'ing Contents/MacOS/OBS
# can appear alive without ever starting OBS WebSocket or Browser Source.
echo "OS: $(sw_vers -productVersion), architecture: $(uname -m)"
echo "Dispatching OBS.app through LaunchServices (non-blocking)..."
printf 'OBS launch via macOS LaunchServices requested at %s\n' "$(date -u)" > "$LOG_DIR/obs.log"
# /usr/bin/open may block indefinitely in a headless hosted GUI session even
# when -W was not requested. Never let that consume the entire CI timeout.
# It is only the launch request; the OBS WebSocket port is the real readiness gate.
/usr/bin/open -na /Applications/OBS.app --args \
  --multi --disable-updater --disable-missing-files-check \
  --profile AI-Live-CI --collection AI-Live-CI \
  --websocket_port 4455 --websocket_password obs-local-ci-only \
  --websocket_ipv4_only < /dev/null > "$LOG_DIR/launchservices.log" 2>&1 &
launch_pid=$!
echo "LaunchServices request PID=$launch_pid (not the OBS GUI PID)"
ready=false
for attempt in $(seq 1 45); do
  if nc -z 127.0.0.1 4455 2>/dev/null; then
    ready=true
    break
  fi
  running_obs_pid=$(pgrep -n -f '/Applications/OBS.app/Contents/MacOS/OBS' || true)
  if [[ -n "$running_obs_pid" ]]; then
    state=$(ps -p "$running_obs_pid" -o stat= | tr -d ' ' || true)
    # The hosted macOS runner launched OBS with process state T (stopped).
    # An ordinary SIGCONT is safe process-control and does not grant any
    # TCC permissions; if the OS still refuses to run OBS, fail visibly.
    if [[ "${state:0:1}" == "T" ]]; then
      if (( attempt == 1 || attempt % 5 == 0 )); then
        echo "OBS PID=$running_obs_pid is stopped (state=$state), sending SIGCONT..."
      fi
      kill -CONT "$running_obs_pid" 2>/dev/null || true
    fi
  fi
  if (( attempt % 10 == 0 )); then
    echo "Waiting for real OBS WebSocket 127.0.0.1:4455 ($attempt/45 seconds)..."
    echo "OBS processes: $(pgrep -fl 'OBS.app/Contents/MacOS/OBS' | head -n 3 || true)"
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "FAIL: official OBS.app did not listen on port 4455 within 45 seconds." >&2
  echo "=== LaunchServices log ==="
  cat "$LOG_DIR/launchservices.log" || true
  echo "=== OBS and LaunchServices processes ==="
  ps -axo pid,ppid,state,command | grep -E 'OBS.app|obs-websocket|LaunchServices|/usr/bin/open' | grep -v grep | head -n 45 || true
  echo "=== OBS log files ==="
  find "$HOME/Library/Application Support/obs-studio" -maxdepth 3 -type f -name '*.txt' -print 2>/dev/null | head -n 25 || true
  exit 1
fi
obs_pid=$(pgrep -n -f '/Applications/OBS.app/Contents/MacOS/OBS' || true)
echo "PASS: official Mac OBS WebSocket is listening; app PID=${obs_pid:-unavailable}"
lsof -nP -iTCP:4455 -sTCP:LISTEN || true

pnpm exec tsx scripts/test-real-obs-rtmp.mjs
echo "PASS official macOS OBS.app -> real FFmpeg RTMP listener -> FFprobe A/V"
