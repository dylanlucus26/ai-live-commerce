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

# A fresh GitHub Actions runner may show OBS's interactive first-launch wizard.
# Disable it through the disposable runner's OBS config only.
CONFIG_ROOT="$HOME/Library/Application Support/obs-studio"
mkdir -p "$CONFIG_ROOT"
cat > "$CONFIG_ROOT/global.ini" <<'CONFIG'
[General]
FirstRun=false
EnableAutoUpdates=false
[BasicWindow]
WarnBeforeStartingStream=false
CONFIG

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

"$OBS_BINARY" --multi --disable-updater --disable-missing-files-check \
  --websocket_port 4455 --websocket_password obs-local-ci-only \
  --websocket_ipv4_only > "$LOG_DIR/obs.log" 2>&1 &
obs_pid=$!
sleep 4
kill -0 "$obs_pid" 2>/dev/null || {
  echo "Official macOS OBS exited before test start" >&2
  exit 1
}

pnpm exec tsx scripts/test-real-obs-rtmp.mjs
echo "PASS official macOS OBS.app -> real FFmpeg RTMP listener -> FFprobe A/V"
