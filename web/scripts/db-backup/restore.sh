#!/usr/bin/env bash
#
# restore.sh — restore an iam-engine database dump made by backup.sh.
#
# SAFE BY DEFAULT: restores into a NEW scratch database
# (<db>_restore_<timestamp>) so you can inspect the data before touching the
# real database. Full disaster recovery over the live database requires the
# explicit --replace flag (and interactive confirmation unless --yes).
#
# Usage:
#   restore.sh [DUMP_FILE]               # restore latest.dump (or given file) into a scratch DB
#   restore.sh DUMP_FILE --target-db X   # restore into database X (created if missing)
#   restore.sh DUMP_FILE --replace --yes # DROP the live DB and restore over it
#
# Options:
#   [--env-file PATH] [--database-url URL] [--backup-dir DIR]
#   [--target-db NAME] [--replace] [--yes] [--drop-target]
#
# Connection resolution matches backup.sh. The connection user must be able to
# create databases (or own the target for --replace).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="${ENV_FILE:-}"
DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/iam-engine}"
DUMP_FILE=""
TARGET_DB=""
REPLACE=0
ASSUME_YES=0
DROP_TARGET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --backup-dir)   BACKUP_DIR="$2"; shift 2 ;;
    --target-db)    TARGET_DB="$2"; shift 2 ;;
    --replace)      REPLACE=1; shift ;;
    --yes)          ASSUME_YES=1; shift ;;
    --drop-target)  DROP_TARGET=1; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "restore.sh: unknown argument: $1" >&2; exit 2 ;;
    *)  DUMP_FILE="$1"; shift ;;
  esac
done

log() { echo "[db-restore] $*"; }
fail() { echo "[db-restore] ERROR: $*" >&2; exit 1; }

# --- locate DATABASE_URL ----------------------------------------------------
if [[ -z "$DATABASE_URL" ]]; then
  if [[ -z "$ENV_FILE" ]]; then
    ENV_FILE="$SCRIPT_DIR/../../.env"
  fi
  [[ -f "$ENV_FILE" ]] || fail "no --database-url given and env file not found: $ENV_FILE"
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  [[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL not set in $ENV_FILE"
fi

CLEAN_URL="${DATABASE_URL%%\?*}"
LIVE_DB="$(basename "$CLEAN_URL")"
BASE_URL="$(dirname "$CLEAN_URL")"   # postgresql://user:pass@host:port

# --- locate client tools ------------------------------------------------------
find_pg_bin() {
  local candidates=(
    "${PG_BIN_DIR:-}"
    "/opt/homebrew/opt/libpq/bin"
    "/usr/local/opt/libpq/bin"
    "/opt/homebrew/opt/postgresql@17/bin"
    "/usr/local/opt/postgresql@17/bin"
  )
  local d
  for d in "${candidates[@]}"; do
    [[ -n "$d" && -x "$d/pg_restore" ]] && { echo "$d"; return 0; }
  done
  command -v pg_restore >/dev/null 2>&1 && { dirname "$(command -v pg_restore)"; return 0; }
  return 1
}
PG_BIN="$(find_pg_bin)" || fail "pg_restore not found. Install with: brew install libpq (or set PG_BIN_DIR)"

# --- resolve dump file --------------------------------------------------------
if [[ -z "$DUMP_FILE" || "$DUMP_FILE" == "latest" ]]; then
  DUMP_FILE="$BACKUP_DIR/latest.dump"
fi
[[ -f "$DUMP_FILE" ]] || fail "dump file not found: $DUMP_FILE"
"$PG_BIN/pg_restore" --list "$DUMP_FILE" > /dev/null || fail "not a readable pg_dump archive: $DUMP_FILE"

# --- pick target ---------------------------------------------------------------
if [[ $REPLACE -eq 1 ]]; then
  [[ -z "$TARGET_DB" ]] || fail "--replace and --target-db are mutually exclusive"
  TARGET_DB="$LIVE_DB"
elif [[ -z "$TARGET_DB" ]]; then
  TARGET_DB="${LIVE_DB}_restore_$(date +%Y%m%d_%H%M%S)"
fi

MAINT_URL="$BASE_URL/postgres"
TARGET_URL="$BASE_URL/$TARGET_DB"
# password-masked variants for anything we print
mask() { echo "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#'; }

psql_maint() { "$PG_BIN/psql" "$MAINT_URL" --no-password -v ON_ERROR_STOP=1 -qAt -c "$1"; }

if [[ $REPLACE -eq 1 ]]; then
  echo ""
  echo "  !!! You are about to DROP the live database '$LIVE_DB' on"
  echo "  !!! $(mask "$BASE_URL") and restore it from:"
  echo "  !!!   $DUMP_FILE"
  echo ""
  if [[ $ASSUME_YES -ne 1 ]]; then
    read -r -p "  Type the database name ('$LIVE_DB') to confirm: " CONFIRM
    [[ "$CONFIRM" == "$LIVE_DB" ]] || fail "confirmation did not match; aborting"
  fi
  log "terminating connections to $LIVE_DB"
  psql_maint "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$LIVE_DB' AND pid <> pg_backend_pid();" > /dev/null
  log "dropping and recreating $LIVE_DB"
  psql_maint "DROP DATABASE IF EXISTS \"$LIVE_DB\";"
  psql_maint "CREATE DATABASE \"$LIVE_DB\";"
else
  EXISTS="$(psql_maint "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB';")"
  if [[ "$EXISTS" == "1" && $DROP_TARGET -eq 1 ]]; then
    log "dropping existing target $TARGET_DB"
    psql_maint "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$TARGET_DB' AND pid <> pg_backend_pid();" > /dev/null
    psql_maint "DROP DATABASE \"$TARGET_DB\";"
    EXISTS=""
  fi
  [[ "$EXISTS" == "1" ]] && fail "target database $TARGET_DB already exists (use --drop-target to replace it)"
  log "creating database $TARGET_DB"
  psql_maint "CREATE DATABASE \"$TARGET_DB\";"
fi

log "restoring $DUMP_FILE → $TARGET_DB"
# --no-owner/--no-privileges: restore as the connecting user, ignoring original
# role ownership (dump may reference roles that don't exist on a new server).
"$PG_BIN/pg_restore" --no-password --no-owner --no-privileges \
  --dbname="$TARGET_URL" "$DUMP_FILE"

TABLE_COUNT="$("$PG_BIN/psql" "$TARGET_URL" --no-password -qAt -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
log "done: $TARGET_DB has $TABLE_COUNT tables"

if [[ $REPLACE -ne 1 ]]; then
  log "inspect with: psql \"$(mask "$TARGET_URL")\""
  log "when finished: psql \"$(mask "$MAINT_URL")\" -c 'DROP DATABASE \"$TARGET_DB\";'"
fi
