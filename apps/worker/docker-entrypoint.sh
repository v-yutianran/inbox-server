#!/usr/bin/env sh
set -eu

display="${DISPLAY:-:99}"
lock_number="${display#:}"
lock_number="${lock_number%%.*}"
case "$lock_number" in
  ''|*[!0-9]*)
    echo '{"event":"invalid_display"}' >&2
    exit 1
    ;;
esac
ready=0
xvfb_attempt=0
while [ "$xvfb_attempt" -lt 5 ]; do
  rm -f "/tmp/.X${lock_number}-lock" "/tmp/.X11-unix/X${lock_number}"
  Xvfb "$display" -screen 0 1920x1080x24 -ac -nolisten tcp &
  xvfb_pid=$!

  readiness_attempt=0
  while [ "$readiness_attempt" -lt 300 ]; do
    if kill -0 "$xvfb_pid" 2>/dev/null && [ -S "/tmp/.X11-unix/X${lock_number}" ]; then
      ready=1
      break
    fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then
      break
    fi
    readiness_attempt=$((readiness_attempt + 1))
    sleep 0.1
  done

  if [ "$ready" -eq 1 ]; then
    break
  fi

  kill "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
  xvfb_attempt=$((xvfb_attempt + 1))
  if [ "$xvfb_attempt" -lt 5 ]; then
    sleep 1
  fi
done

if [ "$ready" -ne 1 ]; then
  echo '{"event":"xvfb_failed"}' >&2
  exit 1
fi

export DISPLAY="$display"
exec node apps/worker/dist/main.js
