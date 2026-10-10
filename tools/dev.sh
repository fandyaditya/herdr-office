#!/usr/bin/env bash
# Start local dev servers: real herdr on :4747 and the mock building on :4748.
# Logs + pids live in $DEV_DIR (default: /tmp/herdr-office-dev).  Usage: tools/dev.sh [start|stop]
cd "$(dirname "$0")/.."
D=${DEV_DIR:-$PWD/.dev}; mkdir -p "$D"
stop() { for f in "$D"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done; }
case "${1:-start}" in
  stop) stop ;;
  start)
    stop
    nohup node server/index.js > "$D/real.log" 2>&1 & echo $! > "$D/real.pid"
    OFFICE_MOCK=1 OFFICE_MOCK_STATIC=${STATIC:-0} PORT=4748 nohup node server/index.js > "$D/mock.log" 2>&1 & echo $! > "$D/mock.pid"
    sleep 0.8; tail -n2 "$D"/*.log ;;
esac
