#!/usr/bin/env bash
# Free port 3000, then start the web dev server on the LAN.
#
# Kills only processes *listening* on the port. Clients with an open connection
# to it (the pwsh runner polls the app) are left alone -- matching them too
# would kill the runner.
set -euo pipefail

PORT="${PORT:-3000}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

listeners() { lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }

reap() {
  local pids signal
  pids="$(listeners)"
  [ -z "$pids" ] && { echo "port $PORT is free"; return 0; }

  local my_pgid pgid
  my_pgid="$(ps -o pgid= -p $$ | tr -d ' ')"

  for signal in TERM KILL; do
    echo "port $PORT held by: $(echo "$pids" | tr '\n' ' ')-- sending SIG$signal"
    for pid in $pids; do
      # Kill the whole group: `next dev` supervises a next-server child, and killing
      # the child alone lets the parent respawn it straight back onto the port.
      pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
      if [ -n "$pgid" ] && [ "$pgid" != "$my_pgid" ]; then
        kill "-$signal" -- "-$pgid" 2>/dev/null || true
      else
        # Same group as us (or gone) -- signal the pid alone so we don't kill ourselves.
        kill "-$signal" "$pid" 2>/dev/null || true
      fi
    done
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.5
      pids="$(listeners)"
      [ -z "$pids" ] && { echo "port $PORT is free"; return 0; }
    done
  done

  echo "error: could not free port $PORT; still held by: $(echo "$pids" | tr '\n' ' ')" >&2
  echo "inspect with: lsof -nP -iTCP:$PORT -sTCP:LISTEN" >&2
  return 1
}

reap
cd "$REPO_ROOT/web"
echo "starting: npm run dev:lan (in $(pwd))"
exec npm run dev:lan
