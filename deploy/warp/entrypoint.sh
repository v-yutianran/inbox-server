#!/bin/sh
set -eu

case "${WARP_PROXY_PORT:-40000}" in
  ''|*[!0-9]*)
    echo '{"event":"warp_configuration_invalid","field":"WARP_PROXY_PORT"}' >&2
    exit 1
    ;;
esac

if [ "$WARP_PROXY_PORT" -lt 1 ] || [ "$WARP_PROXY_PORT" -gt 65535 ]; then
  echo '{"event":"warp_configuration_invalid","field":"WARP_PROXY_PORT"}' >&2
  exit 1
fi

/bin/warp-svc &
warp_pid=$!

cleanup() {
  kill -TERM "$warp_pid" 2>/dev/null || true
  wait "$warp_pid" 2>/dev/null || true
}

terminate() {
  trap - EXIT INT TERM
  cleanup
  exit 0
}

trap cleanup EXIT
trap terminate INT TERM

attempt=0
until /bin/warp-cli --accept-tos --no-ansi status >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo '{"event":"warp_daemon_unavailable"}' >&2
    exit 1
  fi
  sleep 1
done

if ! /bin/warp-cli --accept-tos --no-ansi registration show >/dev/null 2>&1; then
  /bin/warp-cli --accept-tos --no-ansi registration new >/dev/null
fi

/bin/warp-cli --accept-tos --no-ansi mode proxy >/dev/null
/bin/warp-cli --accept-tos --no-ansi proxy port "$WARP_PROXY_PORT" >/dev/null
/bin/warp-cli --accept-tos --no-ansi connect >/dev/null

attempt=0
until /bin/warp-cli --accept-tos --no-ansi status 2>/dev/null | grep -q '^Status update: Connected$'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo '{"event":"warp_connection_timeout"}' >&2
    exit 1
  fi
  sleep 1
done

echo "{\"event\":\"warp_ready\",\"proxyPort\":${WARP_PROXY_PORT}}"
wait "$warp_pid"
