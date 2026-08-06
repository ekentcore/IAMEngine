#!/usr/bin/env bash
# ONE-TIME housekeeping for the 2026-08-06 feature-request batch.
#
# Everything shipped in PRs #41, #42 and #44 that still needs a WRITE to the production database —
# which the dev box that built them cannot reach (it is not allowlisted on the Azure Postgres
# firewall). Run this once from a host that can: the app container, a jump box, or any machine whose
# IP is on the firewall rule.
#
#   ./scripts/housekeeping-2026-08-06.sh            # DRY RUN — prints every change, writes nothing
#   ./scripts/housekeeping-2026-08-06.sh --apply    # do it
#
# Credentials come from the repo-root env file (POSTGRES_*), the same way every other script here
# resolves them. Nothing is passed on the command line.
#
# WHAT IT DOES, in order:
#   1. Six One (FR #82) — removes "Back Office Users" from the live active-directory onboard config.
#      The profile fix shipped in #41, but profiles are only the SEED source; without this the next
#      Six One onboard still adds the group to everyone.
#   2. FR #82 -> Implemented, with a resolution note.
#   3. FR #46 -> Implemented, with a resolution note.
#   4. Announces both change-log entries to the configured chat rooms.
#
# Every step is idempotent: re-running finds nothing to do rather than doing it twice. The one
# exception is step 4 — chat has no idea it has seen a message before, so a second run POSTS AGAIN.
# That is why the announcements come last and are the only part that asks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/web"

APPLY=""
[[ "${1:-}" == "--apply" ]] && APPLY="yes"

if [[ -z "$APPLY" ]]; then
  echo "DRY RUN — nothing will be written. Re-run with --apply to do it."
  echo
fi
DRY_FLAG=$([[ -n "$APPLY" ]] && echo "" || echo "--dry-run")

echo "════ 1/4  Six One: drop 'Back Office Users' from the live AD onboard config (FR #82) ════"
if [[ -n "$APPLY" ]]; then
  npx tsx scripts/backfill-six-one-back-office.ts --apply
else
  npx tsx scripts/backfill-six-one-back-office.ts
fi
echo

echo "════ 2/4  FR #0000082 -> Implemented ════"
# shellcheck disable=SC2086  # DRY_FLAG is intentionally word-split (empty = no flag)
npx tsx scripts/fr-status.ts 82 done $DRY_FLAG --note \
"Not hardcoded in PowerShell — 'Back Office Users' sat in Six One's AD onboard lane as an unconditional group, so every onboard added it. Removed from the profile and from the live client config; it is now added only when picked on the ticket, which already routes requested groups to AD. The conditional groups (61C-CORE_Users on avd, Perimeter 81 on perimeter) are unchanged. Shipped in PR #41."
echo

echo "════ 3/4  FR #0000046 -> Implemented ════"
# shellcheck disable=SC2086
npx tsx scripts/fr-status.ts 46 done $DRY_FLAG --note \
"Each action now gets its own line, and the runner's explanatory asides ('added by the Exchange step (Graph can't); not present yet') and raw vendor error blobs are trimmed off. Whole lines are never dropped and the full untrimmed text is retained in the run log and audit record — the note gets shorter by trimming, not by omitting. Verified against UM0030053, the case in the request. Shipped in PR #42."
echo

echo "════ 4/4  announce both to the chat rooms ════"
if [[ -z "$APPLY" ]]; then
  npx tsx scripts/announce-merged.ts --entry six-one-back-office-on-request --dry-run
  npx tsx scripts/announce-merged.ts --entry cleaner-case-resolution-notes --dry-run
  echo
  echo "dry run complete — nothing was written or posted."
  echo "Re-run with --apply to do it for real."
  exit 0
fi

# Chat is the one step a re-run would duplicate, so it asks even under --apply. Answer n and send it
# later by hand with the commands printed below.
echo "This POSTS TO REAL CUSTOMER CHAT ROOMS and cannot be undone."
GO=""
if [[ -t 1 && -r /dev/tty ]]; then
  read -r -p "Post both announcements now? [y/N] " GO < /dev/tty || GO=""
else
  echo "(no terminal to confirm at — not posting.)"
fi
if [[ "$GO" == "y" || "$GO" == "Y" ]]; then
  npx tsx scripts/announce-merged.ts --entry six-one-back-office-on-request
  npx tsx scripts/announce-merged.ts --entry cleaner-case-resolution-notes
else
  echo "skipped. Send them when you're ready:"
  echo "  cd \"$ROOT/web\""
  echo "  npx tsx scripts/announce-merged.ts --entry six-one-back-office-on-request"
  echo "  npx tsx scripts/announce-merged.ts --entry cleaner-case-resolution-notes"
fi

echo
echo "housekeeping done."
