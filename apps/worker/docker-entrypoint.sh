#!/usr/bin/env sh
set -eu

display="${DISPLAY:-:99}"
lock_number="${display#:}"
lock_number="${lock_number%%.*}"
rm -f "/tmp/.X${lock_number}-lock"

Xvfb "$display" -screen 0 1920x1080x24 -ac -nolisten tcp &
xvfb_pid=$!

ready=0
attempt=0
while [ "$attempt" -lt 50 ]; do
  if kill -0 "$xvfb_pid" 2>/dev/null && [ -S "/tmp/.X11-unix/X${lock_number}" ]; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done

if [ "$ready" -ne 1 ]; then
  echo '{"event":"xvfb_failed"}' >&2
  exit 1
fi

export DISPLAY="$display"
exec node apps/worker/dist/main.js
