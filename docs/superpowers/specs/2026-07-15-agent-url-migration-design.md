# Agent app-URL self-migration

**Date:** 2026-07-15
**Status:** Design approved (pending written-spec review)
**Author:** Evan Kent + Claude

## Problem

The IAM app is moving from a `kentassociates.org` host to a Coretelligent-owned
domain. Every agent — the on-prem AD agents in client networks and the central cloud
runner — polls the app at a base URL (`-AppUrl`) that is **frozen into its supervisor
definition at install time** (Windows Scheduled Task args, macOS launchd plist, Linux
systemd unit). The in-app self-update (`Update-CtgRunner`) pulls new *files* from that
URL but always relaunches with the *same* URL — it cannot move an agent to a new
hostname. Today the only way to re-point an agent is to re-run the platform installer on
each host, which does not scale across on-prem networks we cannot touch.

We want agents to **learn their new base URL over their existing heartbeat, verify it,
rewrite their own supervisor entry, and switch** — with the old URL removed once the
switch is confirmed.

## Constraints and assumptions

- **Overlap window (confirmed):** during the cutover the old `kentassociates.org` host
  stays reachable for hours/days while agents check in and migrate themselves. The old
  host is torn down only after the fleet reports in on the new URL.
- **Same backend, two hostnames (assumption — confirm before build):** during the
  overlap, the old and new hostnames front the **same backend and database**. This is
  required so the agent's existing `RUNNER_API_TOKEN` validates against the new host and
  the app sees each agent converge onto the new URL. If the new host is a *separate*
  deployment with its own DB, this design does not apply as written.
- **Scope:** the app-poll URL only. This is **not** an Active Directory / email domain
  rename — the AD domain is resolved live (`Get-ADDomain`) or brokered per-job via the
  `ad-dc` secret and needs no agent-side change.
- **Clean cutover, no permanent fallback:** the verify-probe de-risks the switch up
  front; the supervisor rewrite then *replaces* the old URL (does not append a fallback).
  Migration is marked complete only after the app observes a heartbeat on the new URL.

## Approaches considered

1. **Self-migration over the heartbeat (chosen).** App pushes the new URL; agent
   verifies reachability, rewrites its supervisor entry, relaunches on the new URL.
   Scales to networks we cannot reach; matches the ask.
2. **DNS / reverse-proxy keep-alive of the old name.** Zero agent code, but carries the
   old domain forever and fails if `kentassociates.org` is fully retired. Kept only as
   the *transition* safety net (old host stays up until the fleet converges).
3. **Manual reinstall per agent.** Today's state; does not scale.

## Design

### Component 1 — Agent reports its current URL (visibility)

The heartbeat POST body (`POST /api/agents/heartbeat`, `Start-IamRunner.ps1` ~line 2474)
gains an `appUrl` field carrying the agent's current `$AppUrl`.

- **What it does:** lets the app know each agent's *current* base host.
- **Interface:** additive request field; older runners simply omit it (app treats absent
  as "unknown / not yet reporting").
- **Consumers:** the heartbeat handler (to decide whether to send `migrate`) and the
  Agents UI (to show old vs new and detect convergence).

### Component 2 — App-side migration control (global target + canary)

- **Global setting:** an `AppSetting` `agentMigration = { enabled: boolean, targetUrl:
  string }` (the new base URL), authored from Settings. Reuse the existing
  `claimAppSetting` pattern.
- **Per-agent canary:** a per-agent "Migrate now" flag on the `Agent` row, following the
  exact pattern of the existing per-agent `update` / `restart` flags (operator sets it;
  the heartbeat handler consumes and clears it). Lets you prove the switch on one agent
  before flipping the fleet.
- **Heartbeat handler logic:** return `migrate: { appUrl: targetUrl }` when the agent's
  *reported* `appUrl` ≠ `targetUrl` **and** ( the agent's canary flag is set **or**
  `agentMigration.enabled` is true ). Never send `migrate` when the reported URL already
  equals the target (this is how the agent stops being told to migrate = convergence).
- **What it does:** decides, per heartbeat, whether this agent should move and to where.
- **Depends on:** Component 1 (needs the reported URL) and the `AppSetting` +
  `Agent`-flag storage.

### Component 3 — Runner migrate path (`Invoke-CtgMigrate -NewAppUrl`)

Called from the heartbeat block alongside `update` / `restart` (`Start-IamRunner.ps1`
~lines 2476-2478): `if ($hb.migrate.appUrl) { Invoke-CtgMigrate -NewAppUrl $hb.migrate.appUrl }`.

1. **Guard:** if `NewAppUrl` equals the current `$AppUrl`, no-op (idempotent).
2. **Verify:** `GET {NewAppUrl}/api/runner/manifest` with the bearer token; require HTTP
   `200`. On any failure (unreachable / non-200 / auth): **stay on the old URL**, post a
   `migrate-failed` status to the app, and retry on the next heartbeat. This is the
   blast-radius guard — a wrong or dead target never strands an agent.
3. **Rewrite the supervisor entry** to the new `-AppUrl`, *replacing* the old value:
   - **Windows Scheduled Task** (`iam-runner`): read the action's argument string,
     replace the `-AppUrl "<old>"` token with `-AppUrl "<new>"`, `Set-ScheduledTask`.
     The runner runs as SYSTEM/Highest, so it may re-register. Preserve all other args
     and settings (do not rebuild the trigger/principal from scratch).
   - **macOS launchd** (`~/Library/LaunchAgents/com.coretelligent.iam-runner.plist`):
     rewrite the `-AppUrl` `ProgramArguments` entry, `launchctl unload` + `load` (or
     `bootout` + `bootstrap`) to reload.
   - **Linux systemd** (`/etc/systemd/system/iam-runner.service`): rewrite `ExecStart`,
     `systemctl daemon-reload`.
   - If the rewrite fails (not elevated / file unwritable / task not found): **do not
     relaunch.** Stay on the old URL, post `migrate-failed`, and let the operator
     intervene. A half-migrated agent must never enter a relaunch loop.
4. **Relaunch on the new URL:** set the in-memory `$AppUrl` to the new value and call the
   existing relaunch path (supervised → `exit 0`; the just-rewritten supervisor entry
   brings it back on the new URL. Unsupervised → self-spawn with the new URL — the
   self-spawn command in `Invoke-CtgRelaunch` already interpolates `$AppUrl`, so it picks
   up the new value). The watchdog relaunch args are likewise rebuilt from `$AppUrl` on
   the fresh process, so the old URL is gone from every relaunch surface.

- **What it does:** the actual verify → rewrite → switch, self-contained and idempotent.
- **Depends on:** the platform supervisor being present (the normal supervised install).

### Component 4 — Confirmation and observability

- On the **first successful heartbeat on the new host**, the reported `appUrl` equals
  `targetUrl`; the handler stops sending `migrate` and the app records the agent as
  **migrated** (records the observed URL + a timestamp; clears any per-agent canary flag
  and `migrate-failed` state).
- The **Agents UI** shows each agent's current base URL and a migration state
  (`pending` / `verifying` / `migrated` / `failed`), so the operator can watch the fleet
  converge and know when it is safe to tear down the old host.
- A `migrate-failed` report surfaces on the row with the reason (unreachable / rewrite
  failed) so a stuck agent is visible rather than silent.

## Data flow (happy path)

1. Operator sets the canary agent's "Migrate now" (or flips `agentMigration.enabled`)
   with `targetUrl = https://<new-host>`.
2. Agent heartbeats to the **old** host, reporting its current `appUrl` (old).
3. Handler sees reported ≠ target + flag/enabled → returns `migrate: { appUrl: new }`.
4. Agent verifies `GET {new}/api/runner/manifest` == 200.
5. Agent rewrites its supervisor entry (old URL **removed**), relaunches.
6. Agent comes back polling the **new** host, reports `appUrl = new`.
7. Handler sees reported == target → no `migrate`; app marks the agent **migrated**.
8. Once every agent shows `migrated`, operator tears down the old host.

## Error handling

| Failure | Behavior |
|---|---|
| New URL unreachable / non-200 / auth fails at verify | Stay on old URL, post `migrate-failed`, retry next heartbeat. |
| Supervisor rewrite fails (not elevated / unwritable / task missing) | Do **not** relaunch; stay on old URL, post `migrate-failed` with reason. |
| Agent offline during the window | No effect; it migrates whenever it next checks in (old host still up). |
| Target set equal to current URL | Handler never sends `migrate`; runner no-ops if it ever receives it. |
| Old host torn down before an agent migrated | That agent goes dark (documented operational risk — wait for full convergence in the UI before teardown). |

## Testing

- **Runner Pester:**
  - verify-gate: unreachable/`404` new URL → no supervisor rewrite, no relaunch,
    `migrate-failed` posted (mock `Invoke-RestMethod` / `Invoke-WebRequest`).
  - Windows rewrite: `-AppUrl` token swapped in the task args; `Set-ScheduledTask`
    called with the new value (mock task cmdlets).
  - macOS plist / Linux unit rewrite: new URL written, reload invoked (mock file + reload
    calls).
  - rewrite-failure → **no** relaunch (mock the rewrite to throw; assert `exit`/relaunch
    not reached).
  - idempotency: `NewAppUrl == $AppUrl` → no-op.
- **Web:** heartbeat handler emits `migrate` only on reported ≠ target **and**
  (canary flag or enabled); clears canary + marks migrated on convergence; never emits
  when equal.
- **E2E (dev):** run a dev agent against an "old" dev URL, set the target to a second
  reachable dev URL, watch it verify → rewrite → relaunch → report the new URL → mark
  migrated.

## Out of scope / cleanup

- The enrollment one-liner (`web/app/api/runner/install.ps1/route.ts`) already derives
  the URL from the request host, so installs from the new host bake in the new URL
  automatically — no change needed there.
- Refresh the hard-coded `192.168.0.81:3000` / `kentassociates.org` defaults in the local
  helpers (`update-dc-runner.ps1`, `update-mac-runner.sh`, the `install-task.ps1`
  example comment) so a hand-run helper points at the new host by default.
- Bump `runner/VERSION` (minor — backward-compatible) and add a `/changelog` entry.

## Open question to confirm at spec review

Is the same-backend/two-hostnames assumption correct (old + new hostnames serve the same
app + DB during the overlap)? If the new host is a separate deployment with its own DB,
the token/convergence model changes and we need a different plan.
