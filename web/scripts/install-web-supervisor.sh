#!/bin/bash
# Install a launchd supervisor for the iam-engine web server (macOS).
#
# Why: the dev server has historically been started ad-hoc from terminals (or orphaned by
# background sessions) — nothing restarts it when it dies, and "restart" means hunting PIDs.
# This puts it under a launchd LaunchAgent with KeepAlive, so:
#   - it starts at login and relaunches automatically if it exits or crashes
#   - "Restart server" in /settings works: the app exits itself and launchd brings it back
#   - logs land in ~/Library/Logs/iam-web.log
#
# Usage:  web/scripts/install-web-supervisor.sh [start-command]
#         default start-command: npm run dev:lan   (next dev -H 0.0.0.0 -p 3000)
#         production would be:   npm run start     (after next build)
# Remove: launchctl bootout gui/$UID/com.iam-engine.web && rm ~/Library/LaunchAgents/com.iam-engine.web.plist
set -euo pipefail

LABEL="com.iam-engine.web"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/iam-web.log"
CMD="${1:-dev:lan}"
NPM="$(command -v npm)"

if [ -z "$NPM" ]; then echo "npm not found on PATH" >&2; exit 1; fi

# Stop any prior instance of the agent (ignore errors if not loaded).
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$WEB_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPM</string>
    <string>run</string>
    <string>$CMD</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Throttle relaunch so a crash-loop doesn't spin hot. -->
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- The app checks this to know a supervisor will bring it back after exit —
         the /settings "Restart server" button refuses to run without it. -->
    <key>IAM_SUPERVISED</key><string>1</string>
    <key>PATH</key><string>$(dirname "$NPM"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST

echo "Note: stop any manually-started dev server on the same port first (lsof -nP -iTCP:3000 -sTCP:LISTEN)."
launchctl bootstrap "gui/$UID" "$PLIST"
echo "Installed + started $LABEL (command: npm run $CMD, dir: $WEB_DIR)"
echo "Logs: tail -f $LOG"
