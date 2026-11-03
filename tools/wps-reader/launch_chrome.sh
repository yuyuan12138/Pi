#!/usr/bin/env bash
# Launch (or reuse) the dedicated CDP Chrome for WPS cloud sheet reading.
# Uses a separate profile so it never disturbs your main Chrome; the WPS
# login persists in this profile across runs (the long-term solution).
set -euo pipefail
PROFILE="${WPS_CDP_PROFILE:-$HOME/.chrome-wps-cdp}"
PORT="${CDP_PORT:-9222}"
URL="${1:-about:blank}"
if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  echo "CDP Chrome already running on :$PORT"
else
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
    --no-first-run --no-default-browser-check "$URL" >/tmp/chrome-cdp.log 2>&1 &
  echo "launched CDP Chrome (pid $!) profile=$PROFILE url=$URL"
  sleep 4
fi
curl -s "http://localhost:$PORT/json/version" | python3 -c "import json,sys;print('Browser:',json.load(sys.stdin)['Browser'])"