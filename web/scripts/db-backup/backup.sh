#!/usr/bin/env bash
#
# backup.sh — nightly (or on-demand) PostgreSQL backup for iam-engine.
#
# Produces a compressed custom-format dump (pg_dump -Fc), verifies it is
# readable (pg_restore --list), maintains a `latest.dump` symlink, and prunes
# dumps older than the retention window. Custom format is used (not plain SQL)
# so restores can be parallel, selective, and reordered by pg_restore.
#
# Usage:
#   backup.sh [--env-file PATH] [--database-url URL] [--backup-dir DIR]
#             [--keep-days N] [--quiet]
#
# Connection resolution order: --database-url, $DATABASE_URL, DATABASE_URL in
# the env file (default: web/.env next to this script's repo checkout).
# Config can also come from the environment: BACKUP_DIR, KEEP_DAYS, PG_BIN_DIR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="${ENV_FILE:-}"
DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/iam-engine}"
KEEP_DAYS="${KEEP_DAYS:-30}"
QUIET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)     ENV_FILE="$2"; shift 2 ;;
    --database-url) DATABASE_URL="$2"; shift 2 ;;
    --backup-dir)   BACKUP_DIR="$2"; shift 2 ;;
    --keep-days)    KEEP_DAYS="$2"; shift 2 ;;
    --quiet)        QUIET=1; shift ;;
    -h|--help)      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "backup.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { [[ $QUIET -eq 1 ]] || echo "[db-backup] $*"; }
fail() { echo "[db-backup] ERROR: $*" >&2; exit 1; }

# --- locate DATABASE_URL ----------------------------------------------------
if [[ -z "$DATABASE_URL" ]]; then
  if [[ -z "$ENV_FILE" ]]; then
    # default: web/.env two levels up from this script (web/scripts/db-backup/)
    ENV_FILE="$SCRIPT_DIR/../../.env"
  fi
  [[ -f "$ENV_FILE" ]] || fail "no --database-url given and env file not found: $ENV_FILE"
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  [[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL not set in $ENV_FILE"
fi

# pg_dump rejects Prisma's ?schema=... query param; strip the query string.
CLEAN_URL="${DATABASE_URL%%\?*}"
DB_NAME="$(basename "${CLEAN_URL}")"

# --- locate pg_dump/pg_restore (>= server major version) ---------------------
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
    [[ -n "$d" && -x "$d/pg_dump" ]] && { echo "$d"; return 0; }
  done
  command -v pg_dump >/dev/null 2>&1 && { dirname "$(command -v pg_dump)"; return 0; }
  return 1
}
PG_BIN="$(find_pg_bin)" || fail "pg_dump not found. Install with: brew install libpq (or set PG_BIN_DIR)"

# --- dump --------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP_FILE="$BACKUP_DIR/${DB_NAME}-${STAMP}.dump"
TMP_FILE="$DUMP_FILE.partial"

log "dumping $DB_NAME → $DUMP_FILE"
"$PG_BIN/pg_dump" --format=custom --compress=9 --no-password \
  --file="$TMP_FILE" "$CLEAN_URL" \
  || { rm -f "$TMP_FILE"; fail "pg_dump failed"; }

# verify the archive is readable before we trust it
"$PG_BIN/pg_restore" --list "$TMP_FILE" > /dev/null \
  || { rm -f "$TMP_FILE"; fail "dump verification failed (pg_restore --list)"; }

mv "$TMP_FILE" "$DUMP_FILE"
ln -sfn "$DUMP_FILE" "$BACKUP_DIR/latest.dump"

SIZE="$(du -h "$DUMP_FILE" | cut -f1 | tr -d ' ')"
TABLES="$("$PG_BIN/pg_restore" --list "$DUMP_FILE" | grep -c 'TABLE DATA' || true)"
log "ok: $SIZE, $TABLES tables with data, verified readable"

# --- rotate ------------------------------------------------------------------
if [[ "$KEEP_DAYS" -gt 0 ]]; then
  PRUNED=$(find "$BACKUP_DIR" -name "${DB_NAME}-*.dump" -type f -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
  [[ "$PRUNED" -gt 0 ]] && log "pruned $PRUNED dump(s) older than $KEEP_DAYS days"
fi

log "done: $DUMP_FILE"
