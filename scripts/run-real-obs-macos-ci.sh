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
  if [[ -n "$obs_pid" ]]; then kill "$obs_pid" 2>/dev/null || true; fi
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
open -na /Applications/OBS.app --args \
  --multi --disable-updater --disable-missing-files-check \
  --profile AI-Live-CI --collection AI-Live-CI \
  --websocket_port 4455 --websocket_password obs-local-ci-only \
  --websocket_ipv4_only
sleep 5
obs_pid=$(pgrep -n -f '/Applications/OBS.app/Contents/MacOS/OBS' || true)
if [[ -z "$obs_pid" ]] || ! kill -0 "$obs_pid" 2>/dev/null; then
  echo "OBS GUI was not running after LaunchServices startup" >&2
  exit 1
fi
echo "OBS GUI pid=$obs_pid"
# Save the application log produced by OBS itself on this runner.
printf "Launched OBS via macOS LaunchServices, process pid=%s\n" "$obs_pid" > "$LOG_DIR/obs.log"

pnpm exec tsx scripts/test-real-obs-rtmp.mjs
echo "PASS official macOS OBS.app -> real FFmpeg RTMP listener -> FFprobe A/V"
