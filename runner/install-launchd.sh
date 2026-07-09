#!/usr/bin/env bash
# One-time supervisor setup for the macOS central runner: install a launchd LaunchAgent that keeps
# Start-IamRunner.ps1 running (RunAtLoad + KeepAlive) and relaunches it within seconds on ANY exit —
# a crash, the stall watchdog's restart, or a self-update. This replaces the bare `nohup` launch and
# is the macOS stand-in for the way Azure Container Apps will supervise the containerized runner later
# (KeepAlive ≈ the container's restart policy; the runner's -HealthCheck ≈ the liveness probe).
#
# Run it once (re-run any time to update the settings). Override defaults via env — same names as
# update-mac-runner.sh:
#   APP_URL  AGENT_ID  RUNNER_DIR  PWSH  RUNNER_API_TOKEN  STALL_TIMEOUT  RUNNER_LOG
set -euo pipefail

APP="${APP_URL:-http://192.168.0.81:3000}"
AGENT="${AGENT_ID:-cmq585c0n0001cc3fbry3z33g}"
DIR="${RUNNER_DIR:-$HOME/iam-runner}"
PWSH="${PWSH:-$HOME/.local/pwsh/pwsh}"
TOKEN="${RUNNER_API_TOKEN:-}"
STALL="${STALL_TIMEOUT:-600}"
LOG="${RUNNER_LOG:-$HOME/iam-runner.log}"
LABEL="com.coretelligent.iam-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

[ -x "$PWSH" ] || command -v "$PWSH" >/dev/null 2>&1 || { echo "pwsh not found at '$PWSH' — set PWSH=/path/to/pwsh"; exit 1; }
[ -f "$DIR/Start-IamRunner.ps1" ] || { echo "runner not found at $DIR/Start-IamRunner.ps1 — run update-mac-runner.sh first"; exit 1; }

echo "==> stopping any hand-started (nohup) runner so launchd is the sole owner"
pkill -f Start-IamRunner 2>/dev/null || true
sleep 1

# Optional token line for the EnvironmentVariables dict (kept out of argv so it's not visible in `ps`).
TOKEN_LINE=""
[ -n "$TOKEN" ] && TOKEN_LINE="    <key>RUNNER_API_TOKEN</key><string>$TOKEN</string>"

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PWSH</string>
    <string>-NoProfile</string>
    <string>-ExecutionPolicy</string><string>Bypass</string>
    <string>-File</string><string>$DIR/Start-IamRunner.ps1</string>
    <string>-AppUrl</string><string>$APP</string>
    <string>-AgentId</string><string>$AGENT</string>
    <string>-StallTimeoutSeconds</string><string>$STALL</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RUNNER_SUPERVISED</key><string>1</string>
$TOKEN_LINE
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST_EOF
chmod 600 "$PLIST"   # the plist may carry the API token — keep it owner-only
echo "==> wrote $PLIST"

# Reload cleanly: bootout the old instance (ignore if absent), then bootstrap the new plist. Fall
# back to the legacy load/unload verbs on older launchctl.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true

echo "==> launchd is now supervising the runner ($LABEL)."
echo "    status:  launchctl print $DOMAIN/$LABEL | grep -iE 'state|pid'"
echo "    restart: launchctl kickstart -k $DOMAIN/$LABEL"
echo "    stop:    launchctl bootout $DOMAIN/$LABEL"
echo "    log:     tail -f $LOG"
