#!/usr/bin/env bash
set -euo pipefail

LOG_DIR=/tmp/ai-live-real-obs
mkdir -p "$LOG_DIR/recordings" "$LOG_DIR/runtime"
export AI_LIVE_RTMP_RECORD_DIR="$LOG_DIR/recordings"
export AI_LIVE_OBS_LOG_DIR="$LOG_DIR"

cat > "$LOG_DIR/nginx.conf" <<CONFIG
pid $LOG_DIR/nginx.pid;
error_log $LOG_DIR/nginx-error.log info;
worker_processes 1;
events { worker_connections 512; }
rtmp {
  server {
    listen 127.0.0.1:1935;
    chunk_size 4096;
    application live {
      live on;
      allow publish 127.0.0.1;
      deny publish all;
      record all;
      record_path $LOG_DIR/recordings;
      record_unique on;
    }
  }
}
http {
  access_log off;
  server {
    listen 127.0.0.1:8089;
    location /health { return 200 "local test only"; }
  }
}
CONFIG

nginx -t -c "$LOG_DIR/nginx.conf"
nginx -c "$LOG_DIR/nginx.conf"

export DISPLAY=:98
Xvfb :98 -screen 0 1280x1024x24 -nolisten tcp > "$LOG_DIR/xvfb.log" 2>&1 &
xvfb_pid=$!
obs_pid=

pulseaudio --start --exit-idle-time=-1 >/dev/null 2>&1 || true
pactl load-module module-null-sink sink_name=ai_live_ci >/dev/null 2>&1 || true
export LIBGL_ALWAYS_SOFTWARE=1
export QT_QPA_PLATFORM=xcb
export XDG_RUNTIME_DIR="$LOG_DIR/runtime"
chmod 700 "$XDG_RUNTIME_DIR"

cleanup() {
  echo "=== OBS log tail ==="
  tail -n 120 "$LOG_DIR/obs.log" 2>/dev/null || true
  if [[ -n "$obs_pid" ]]; then kill "$obs_pid" 2>/dev/null || true; fi
  kill "$xvfb_pid" 2>/dev/null || true
  nginx -s stop -c "$LOG_DIR/nginx.conf" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8089/health >/dev/null; then break; fi
  sleep 0.25
done
curl -fsS http://127.0.0.1:8089/health
obs --version || true

# Local test instance only; OBS WebSocket is not exposed outside localhost.
obs --multi --disable-updater --disable-missing-files-check \
  --websocket_port 4455 --websocket_password obs-local-ci-only \
  --websocket_ipv4_only --verbose > "$LOG_DIR/obs.log" 2>&1 &
obs_pid=$!

sleep 3
kill -0 "$obs_pid" 2>/dev/null || { echo "OBS did not start"; exit 1; }

export AI_LIVE_OBS_TEST_PASSWORD=obs-local-ci-only
pnpm exec tsx scripts/test-real-obs-rtmp.mjs
echo "PASS: actual OBS Studio -> localhost RTMP recording -> FFprobe video/audio"
