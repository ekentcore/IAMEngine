#!/bin/bash
# Switch the web server from a hand-run terminal process to the launchd supervisor — SAFELY.
#
# Why this exists: bootstrapping the supervisor while macOS still blocks its Local Network access
# leaves a server that binds :3000 but 500s every request (it can't reach the DB) — which stalls the
# entire runner fleet's heartbeats. That happened on 2026-07-17. This script verifies the supervised
# server can actually reach the database (via /api/health/probe, which proves route + DB) and ROLLS
# BACK to a working foreground-style server if it can't, printing exactly what to fix.
#
# Usage:  web/scripts/activate-web-supervisor.sh
# Before first use: click Allow for "node" in System Settings → Privacy & Security → Local Network
# (the grant is per launchd agent — a terminal server working proves nothing about launchd's).
set -uo pipefail

LABEL="com.iam-engine.web"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT=3000
PROBE="http://localhost:$PORT/api/health/probe"
FALLBACK_LOG="$HOME/Library/Logs/iam-web-fallback.log"

probe_db() { curl -s --max-time 4 "$PROBE" 2>/dev/null | grep -q '"db":true'; }

# 1. The plist must exist (install-web-supervisor.sh writes it; run it here if missing).
if [ ! -f "$PLIST" ]; then
  echo "supervisor plist missing — installing it first…"
  "$WEB_DIR/scripts/install-web-supervisor.sh" >/dev/null || { echo "install failed"; exit 1; }
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi

# 2. Hand over the port: stop whatever is listening (a terminal dev server, a stray nohup).
pids="$(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$pids" ]; then
  echo "stopping the current server on :$PORT (pids: $(echo "$pids" | tr '\n' ' '))…"
  for pid in $pids; do
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$pgid" ] && kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    [ -z "$(lsof -tnP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null || true)" ] && break
  done
fi

# 3. Start the supervised instance.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
echo "bootstrapping $LABEL…"
launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "bootstrap failed — check $PLIST"; exit 1; }

# 4. Verify it serves AND reaches the database (route + DB, not just a TCP accept).
echo "waiting for the supervised server to answer with a database connection (up to 90s)…"
ok=""
for _ in $(seq 1 45); do
  sleep 2
  if probe_db; then ok=1; break; fi
done

if [ -n "$ok" ]; then
  echo "✓ supervised server is up and talking to the database."
  echo "  Restart from Settings now works, crashes self-relaunch, and the self-heal watchdog is active."
  echo "  Logs: tail -f ~/Library/Logs/iam-web.log"
  exit 0
fi

# 5. Blocked (almost always the Local Network permission) — ROLL BACK so the fleet keeps running.
echo "✗ the supervised server did not reach the database — rolling back so heartbeats keep flowing."
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
( cd "$WEB_DIR" && nohup npm run dev:lan >> "$FALLBACK_LOG" 2>&1 & )
for _ in $(seq 1 30); do
  sleep 2
  if probe_db; then echo "✓ fallback server is up (log: $FALLBACK_LOG)."; break; fi
done
cat <<'FIX'

To fix: System Settings → Privacy & Security → Local Network → allow "node"
        (the grant is PER launchd agent — a working terminal server proves nothing about launchd's),
        then re-run web/scripts/activate-web-supervisor.sh
FIX
exit 1
