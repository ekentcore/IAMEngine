# Agent app-URL change modal, honest migration status, restart gate + in-app PR merge

Date: 2026-07-17. Approved by Evan in-session.

## Problem

1. The agent app-URL migration machinery (PR #82) exists, but its target-URL editor only
   renders on the v1 `/settings` page — the v2 page never got it, so the feature is
   invisible. The per-agent Migrate button says "set the target in Settings first" and
   there is nothing in Settings (v2) to set.
2. The migration status label vanishes 5 minutes after delivery even when the agent never
   reports in on the new URL — the exact window where an operator needs to see "moved,
   not communicating yet".
3. "Restart server" requires the launchd supervisor (`IAM_SUPERVISED=1`); the host runs
   the dev server from a terminal, so the button is inert. The gate must also admit Azure
   App Service after the move (platform relaunches an exited process).
4. The merge-then-restart loop (prs.sh at a terminal, then restart) should be drivable
   from Settings.

## Design

### 1. Change app URL modal (Agents page)

- Toolbar button **Change app URL** opens a modal: URL input (prefilled with the current
  `agent_migration` target, absolute http(s) validated server-side as today), scope:
  - **Prove it on one agent first** — dropdown of enabled agents; on confirm the setting
    is saved with `proofAgentId=<agent>` and `enabled=false`, and a migrate is queued for
    that agent.
  - **Migrate the whole fleet** — setting saved with `enabled=true`, `proofAgentId=null`;
    every agent migrates on its next heartbeat.
- Implemented as a server action `changeAppUrl` (guard `settings.manage`) so the setting
  write + proof queue + audit happen in one place.
- `AgentMigrationSetting` gains `proofAgentId?: string | null`. Stored server-side so the
  proof flow survives reloads and is visible to any admin.

### 2. Proof completion / failure

- Success: agents page live-poll sees the proof agent converged (`migratedAt` set,
  `currentAppUrl` == target, fleet off, `proofAgentId` set) → success modal:
  "<runner name> has successfully migrated to <new url> — would you like to move all the
  other agents now?" **Move all** → `enabled=true`, clear `proofAgentId`. **Not now** →
  clear `proofAgentId` only. Both are server actions, both audited.
- Failure: when the migrate-failed writeback lands (runner-service), if the failing agent
  is the proof agent, the server clears `proofAgentId` (audited
  `agent.migration.proof_failed`) — no stale waiting state; the row shows the existing
  ⚠ failed label.
- Audit events: `agent.migration.configure` (existing, reused with a `via` detail),
  `agent.migration.proof_failed`, plus the existing per-agent migrate request audit.

### 3. Honest migration status

- `migrateStatus` moves to `web/lib/agents/migrate-status.ts` (pure, `tsx --test`able —
  the test glob only covers `lib/`). New behavior, in precedence order:
  1. `migrateError` → ⚠ failed (unchanged).
  2. `migratedAt` → ✓ migrated (unchanged).
  3. queued → unchanged.
  4. delivered, then seen again on the OLD URL with no error → "⚠ came back on the old
     URL — migration didn't stick".
  5. delivered < 5 min, silent → "↻ moving URL — verifying + rewriting…" (info).
  6. delivered ≥ 5 min, silent → "↻ moving URL — switched away, not communicating on the
     new URL yet (Xm)" (warn). Shown indefinitely, never vanishes.
- Needs `targetUrl` in the agent view-model → loader passes the `agent_migration` setting
  (shared `_lib/loader.ts`, so v1/v2 both get it). Live-poll predicate extended so rows
  in states 4–6 (and a pending proof) keep polling.

### 4. Settings v2 drift fix

- Render `AgentMigrationSettings` on `/settings/v2` (same props as v1).

### 5. Restart gate

- `supervised` becomes `IAM_SUPERVISED === "1" || !!WEBSITE_SITE_NAME` (Azure App
  Service always relaunches an exited process). Shared helper `isSupervised()` in
  `web/lib/supervised.ts`; route + both settings pages use it. Button note mentions Azure.
- Host setup (outside the PR): run `web/scripts/install-web-supervisor.sh`, hand off port
  3000 from the terminal dev server to the launchd instance.

### 6. Merge PRs (Settings, beside Restart)

- **Merge PRs** button → modal.
- `GET /api/admin/prs` (guard `settings.manage`): availability = repo root above `web/`
  has `scripts/prs.sh` + `gh` on PATH; lists open PRs via
  `gh pr list --json number,title,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup`.
  `{ available: false }` hides the button (Azure has no repo/gh — section disappears
  naturally).
- `POST /api/admin/prs/merge { number }`: runs `scripts/prs.sh <n> --yes` (execFile, cwd
  repo root, 10-min timeout), returns exit code + combined output; modal shows the output
  in a scrollable pre. Audited before (`pr.merge.requested`) and after
  (`pr.merge.finished` with ok/exit). Non-tty conflict handling is prs.sh's own: it rolls
  back and prints the file list.
- No streaming in v1 of this — the button shows "Merging…" until the response lands.

## Testing

- `web/lib/agents/migrate-status.test.ts` — the six states + precedence + minutes label.
- Existing `agent-migration.test.ts` still passes (setting type widened only).
- Manual drive after merge: /agents modal, /settings/v2 blocks, restart round-trip under
  the supervisor, Merge PRs list rendering.

## Out of scope

- Per-agent (non-global) target URLs; streaming merge output; migrating the database to
  Azure (this is UI/host plumbing only).
