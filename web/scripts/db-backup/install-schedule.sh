#!/usr/bin/env bash
#
# install-schedule.sh — schedule the nightly iam-engine database backup on macOS.
#
# Installs a self-contained copy of backup.sh (plus its connection config) under
# ~/.local/share/iam-engine/db-backup/ and a launchd agent that runs it every
# night. The installed copy is independent of any repo checkout, so moving or
# deleting the repo does not break the schedule; re-run this installer after
# changing backup.sh or rotating the database password.
#
# launchd (unlike cron) fires a missed StartCalendarInterval once when the Mac
# wakes from sleep — the machine does not need to be awake at the scheduled
# time, only powered on at some point after it.
#
# macOS Local Network privacy: a NEW launchd agent is denied LAN access
# ("No route to host") until it is allowed once in System Settings >
# Privacy & Security > Local Network. The in-app nightly backup (see README)
# does not need this — it runs inside the already-granted web app. This agent
# is the app-independent second layer once the permission is granted.
#
# Usage:
#   install-schedule.sh [--hour H] [--minute M] [--backup-dir DIR]
#                       [--keep-days N] [--env-file PATH] [--run-now]
#   install-schedule.sh --uninstall
#
# Defaults: 02:00 nightly, backups in ~/Backups/iam-engine, keep 30 days.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LABEL="com.coretelligent.iam-db-backup"
INSTALL_DIR="$HOME/.local/share/iam-engine/db-backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

HOUR=2
MINUTE=0
BACKUP_DIR="$HOME/Backups/iam-engine"
KEEP_DAYS=30
ENV_FILE="$SCRIPT_DIR/../../.env"
RUN_NOW=0
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hour)       HOUR="$2"; shift 2 ;;
    --minute)     MINUTE="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --keep-days)  KEEP_DAYS="$2"; shift 2 ;;
    --env-file)   ENV_FILE="$2"; shift 2 ;;
    --run-now)    RUN_NOW=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install-schedule.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[db-backup-install] $*"; }
fail() { echo "[db-backup-install] ERROR: $*" >&2; exit 1; }

if [[ $UNINSTALL -eq 1 ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$INSTALL_DIR"
  log "uninstalled $LABEL (backups themselves were left in place)"
  exit 0
fi

[[ -f "$ENV_FILE" ]] || fail "env file not found: $ENV_FILE"
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
[[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL not set in $ENV_FILE"

# --- install a checkout-independent copy --------------------------------------
mkdir -p "$INSTALL_DIR" "$BACKUP_DIR"
cp "$SCRIPT_DIR/backup.sh" "$INSTALL_DIR/backup.sh"
chmod 755 "$INSTALL_DIR/backup.sh"

CONF="$INSTALL_DIR/backup.env"
umask 077
cat > "$CONF" <<EOF
# written by install-schedule.sh on $(date '+%Y-%m-%d %H:%M:%S'); chmod 600.
# Contains the database credential — re-run the installer after rotating it.
DATABASE_URL=$DATABASE_URL
BACKUP_DIR=$BACKUP_DIR
KEEP_DAYS=$KEEP_DAYS
EOF
chmod 600 "$CONF"

# --- launchd agent -------------------------------------------------------------
LOG_FILE="$BACKUP_DIR/backup.log"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>set -a; source "$CONF"; set +a; exec "$INSTALL_DIR/backup.sh"</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

log "installed: nightly backup at $(printf '%02d:%02d' "$HOUR" "$MINUTE") → $BACKUP_DIR (keep $KEEP_DAYS days)"
log "log file: $LOG_FILE"
log ""
log "NOTE: if runs fail with 'No route to host', allow this agent under"
log "System Settings > Privacy & Security > Local Network (one-time)."

if [[ $RUN_NOW -eq 1 ]]; then
  log "running an immediate backup via launchd..."
  launchctl kickstart "gui/$(id -u)/$LABEL"
fi
