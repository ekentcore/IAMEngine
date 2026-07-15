# Agent app-URL self-migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each agent learn a new app base URL over its heartbeat, verify it can reach it, rewrite its own supervisor entry (Windows Scheduled Task / macOS launchd / Linux systemd), and switch — removing the old URL once the new host is confirmed.

**Architecture:** The app already returns per-agent `update`/`restart` flags on the heartbeat and the runner acts on them. We add: (a) the agent reports its current `appUrl` on every heartbeat; (b) a global `AppSetting` migration target + a per-agent canary flag drive a returned `migrate: { appUrl }`; (c) the runner verifies the new URL, rewrites its supervisor entry (old URL replaced, not appended), and relaunches; (d) the app marks the agent `migrated` once it observes a heartbeat carrying the new URL. All new decision logic lives in pure functions (web: `node:test`; runner: Pester) because the repo has no DB-backed test harness.

**Tech Stack:** Next.js (App Router, TS) + Prisma + PostgreSQL (`web/`); PowerShell 7 runner (`runner/`); `node:test` via `tsx --test "lib/**/*.test.ts"`; Pester via `~/.local/pwsh/pwsh`.

## Global Constraints

- Migrations are **hand-written idempotent SQL** (`ADD COLUMN IF NOT EXISTS`) in `web/prisma/migrations/<timestamp>_<snake>/migration.sql`; **never** run `prisma migrate dev` (resets the shared DB). Deploy path is `npx prisma migrate deploy` + `npx prisma generate`, run by the operator after merge.
- Web tests live under `web/lib/**` (only those are collected) and use `node:test` + `node:assert/strict`. No vitest/jest, no test DB, no Prisma mock. TDD only pure functions.
- Runner Pester runs via `~/.local/pwsh/pwsh` (not on PATH). Pure runner logic must be dot-sourceable WITHOUT running `Start-IamRunner.ps1`'s `while($true)` loop — so it goes in a separate dot-sourced file.
- The consume-and-clear idiom for a per-agent flag is `db.agent.updateMany({ where: { id, <flag>: true }, data: { <flag>: false, <delivered>: new Date() } })` guarded by the flag in the WHERE.
- Changelog: prepend a new entry to the TOP of `CHANGELOG` in `web/lib/changelog/entries.ts`, with `time` on a `:00/:15/:30/:45` boundary (`entries.test.ts` enforces newest-first + shape).
- Runner version policy: bump `runner/VERSION` (minor — backward compatible). Current: `1.61.0` → `1.62.0`.
- URL comparison is normalized: trim, strip trailing slashes, lowercase.
- Same-backend assumption: old + new hostnames front the same app + DB during the overlap (so the agent's existing token validates on the new host and convergence is observable).

---

### Task 1: DB columns for migration state

**Files:**
- Modify: `web/prisma/schema.prisma` (`model Agent`, ~lines 240-284)
- Create: `web/prisma/migrations/20260715170000_agent_migrate/migration.sql`

**Interfaces:**
- Produces: new `Agent` columns `currentAppUrl String?`, `migrateRequested Boolean @default(false)`, `migrateRequestedAt DateTime?`, `migrateRequestedBy String?`, `migrateDeliveredAt DateTime?`, `migratedAt DateTime?`, `migrateError String?`.

- [ ] **Step 1: Add the columns to the Prisma model**

In `web/prisma/schema.prisma`, inside `model Agent`, after the `restartDeliveredAt DateTime?` line, add:

```prisma
  // Operator-driven app-URL migration. The agent reports its current base URL each heartbeat
  // (currentAppUrl); a global target (AppSetting agent_migration) + this per-agent canary flag make
  // the heartbeat return migrate:{appUrl}. migratedAt is stamped once the agent reports the new URL;
  // migrateError carries the last failure the agent reported (unreachable / rewrite failed).
  currentAppUrl      String?
  migrateRequested   Boolean    @default(false)
  migrateRequestedAt DateTime?
  migrateRequestedBy String?
  migrateDeliveredAt DateTime?
  migratedAt         DateTime?
  migrateError       String?
```

- [ ] **Step 2: Write the idempotent migration SQL**

Create `web/prisma/migrations/20260715170000_agent_migrate/migration.sql`:

```sql
-- Operator-driven app-URL self-migration: the agent reports its current base URL, gets a new target,
-- verifies it, rewrites its supervisor entry, and switches. All additive + idempotent.
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "currentAppUrl" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateRequestedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateRequestedBy" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateDeliveredAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migratedAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "migrateError" TEXT;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd web && npx prisma generate`
Expected: "Generated Prisma Client" with no error. (Do NOT run `migrate dev`.)

- [ ] **Step 4: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/20260715170000_agent_migrate
git commit -m "feat(db): Agent columns for app-URL self-migration"
```

---

### Task 2: Pure migration-decision logic (web)

**Files:**
- Create: `web/lib/jobs/agent-migration.ts`
- Test: `web/lib/jobs/agent-migration.test.ts`

**Interfaces:**
- Produces:
  - `AGENT_MIGRATION_KEY = "agent_migration"` (const)
  - `type AgentMigrationSetting = { enabled?: boolean; targetUrl?: string }`
  - `normalizeUrl(u: string | null | undefined): string`
  - `migrateDecision(args: { setting: AgentMigrationSetting | null; agentMigrateRequested: boolean; reportedUrl: string | null }): { migrate: boolean; targetUrl: string | null; converged: boolean }`

- [ ] **Step 1: Write the failing test**

Create `web/lib/jobs/agent-migration.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDecision, normalizeUrl } from "./agent-migration";

test("normalizeUrl strips trailing slash, trims, lowercases", () => {
  assert.equal(normalizeUrl(" https://Old.Example.org/ "), "https://old.example.org");
  assert.equal(normalizeUrl(null), "");
});

test("no target set → never migrate", () => {
  const d = migrateDecision({ setting: null, agentMigrateRequested: true, reportedUrl: "https://old" });
  assert.deepEqual(d, { migrate: false, targetUrl: null, converged: false });
});

test("canary flag migrates to target when not yet on it", () => {
  const d = migrateDecision({ setting: { targetUrl: "https://new" }, agentMigrateRequested: true, reportedUrl: "https://old" });
  assert.equal(d.migrate, true);
  assert.equal(d.targetUrl, "https://new");
  assert.equal(d.converged, false);
});

test("fleet-enabled migrates every agent not yet on target", () => {
  const d = migrateDecision({ setting: { enabled: true, targetUrl: "https://new" }, agentMigrateRequested: false, reportedUrl: "https://old" });
  assert.equal(d.migrate, true);
});

test("target set but neither canary nor enabled → wait, do not migrate", () => {
  const d = migrateDecision({ setting: { enabled: false, targetUrl: "https://new" }, agentMigrateRequested: false, reportedUrl: "https://old" });
  assert.equal(d.migrate, false);
  assert.equal(d.converged, false);
});

test("already on target (normalized) → converged, never migrate", () => {
  const d = migrateDecision({ setting: { enabled: true, targetUrl: "https://New/" }, agentMigrateRequested: true, reportedUrl: "https://new" });
  assert.equal(d.migrate, false);
  assert.equal(d.converged, true);
  assert.equal(d.targetUrl, "https://New/");
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd web && npx tsx --test lib/jobs/agent-migration.test.ts`
Expected: FAIL — cannot find module `./agent-migration`.

- [ ] **Step 3: Implement**

Create `web/lib/jobs/agent-migration.ts`:

```ts
// Operator-driven app-URL migration: decide whether to tell an agent to move to a new base URL.
// Pure so it is unit-testable (the repo has no DB-backed tests). Consumed by runner-service.heartbeat.
export const AGENT_MIGRATION_KEY = "agent_migration";

export type AgentMigrationSetting = { enabled?: boolean; targetUrl?: string };

// Compare base URLs forgivingly: trailing slash and case must not create a false mismatch that would
// make an already-migrated agent look un-converged (→ endless migrate instructions).
export function normalizeUrl(u: string | null | undefined): string {
  return (u ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

export function migrateDecision(args: {
  setting: AgentMigrationSetting | null;
  agentMigrateRequested: boolean;
  reportedUrl: string | null;
}): { migrate: boolean; targetUrl: string | null; converged: boolean } {
  const rawTarget = args.setting?.targetUrl?.trim() || null;
  const target = normalizeUrl(rawTarget);
  if (!target) return { migrate: false, targetUrl: null, converged: false };
  const current = normalizeUrl(args.reportedUrl);
  if (current && current === target) return { migrate: false, targetUrl: rawTarget, converged: true };
  const wants = args.agentMigrateRequested || args.setting?.enabled === true;
  return { migrate: wants, targetUrl: rawTarget, converged: false };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cd web && npx tsx --test lib/jobs/agent-migration.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/jobs/agent-migration.ts web/lib/jobs/agent-migration.test.ts
git commit -m "feat(web): pure migrateDecision + agent_migration setting key"
```

---

### Task 3: Wire the heartbeat (consume `appUrl`/`migrateError`, emit `migrate`)

**Files:**
- Modify: `web/app/api/agents/heartbeat/route.ts`
- Modify: `web/lib/jobs/runner-service.ts` (`heartbeat`, ~lines 308-379; add `requestMigrate` near `requestRestart` ~line 429)

**Interfaces:**
- Consumes: `migrateDecision`, `AGENT_MIGRATION_KEY`, `AgentMigrationSetting` (Task 2); `getAppSetting` (`@/lib/settings`).
- Produces:
  - `heartbeat(...)` return type gains `migrate: { appUrl: string } | null`; signature gains trailing `appUrl?: string | null, migrateError?: string | null`.
  - `requestMigrate(agentId: string, actor?: ActorInput): Promise<{ id: string }>`.

- [ ] **Step 1: Parse the new fields in the route**

In `web/app/api/agents/heartbeat/route.ts`, extend the body type and parsing. Change the body type to include `appUrl?: unknown; migrateError?: unknown;`, then after the `capabilities` line add:

```ts
  const appUrl = typeof body.appUrl === "string" ? body.appUrl : null;
  const migrateError = typeof body.migrateError === "string" ? body.migrateError : null;
```

and change the service call to:

```ts
    const out = await makeRunnerService(db).heartbeat(body.agentId, version, semver, startedAt, capabilities, appUrl, migrateError);
```

- [ ] **Step 2: Extend `heartbeat` in `runner-service.ts`**

Add imports at the top of `runner-service.ts` (near the other `@/lib` imports):

```ts
import { getAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY, migrateDecision, type AgentMigrationSetting } from "@/lib/jobs/agent-migration";
```

Change the method signature + return type:

```ts
  async heartbeat(agentId: string, version?: string | null, semver?: string | null, startedAt?: string | null, capabilities?: string[] | null, appUrl?: string | null, migrateError?: string | null): Promise<{ ok: true; enabled: boolean; update: boolean; restart: boolean; discover: boolean; migrate: { appUrl: string } | null }> {
```

Add `migrateRequested`, `currentAppUrl` to the `select` in the initial `findUnique` (alongside `updateRequested`/`restartRequested`):

```ts
      select: { id: true, version: true, semver: true, enabled: true, updateRequested: true, updateDeliveredAt: true, restartRequested: true, migrateRequested: true, currentAppUrl: true, clientId: true, client: { select: { adDiscoverRequestedAt: true } } },
```

After the `restart` consume-and-clear block (and before the `discover` block), add the migrate decision + consume:

```ts
    // App-URL migration: decide from the global target + this agent's canary flag, using the URL the
    // agent reports this heartbeat (fall back to its last-known). Only emit when it isn't already there.
    const migrateSetting = await getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY);
    const reportedUrl = appUrl ?? agent.currentAppUrl ?? null;
    const decision = migrateDecision({ setting: migrateSetting, agentMigrateRequested: agent.enabled && agent.migrateRequested, reportedUrl });
    let migrate: { appUrl: string } | null = null;
    if (decision.migrate && decision.targetUrl) {
      // Clear the one-shot canary flag on delivery (a fleet-enabled migration keeps re-emitting until
      // the agent converges); stamp delivery so the UI can show "migrating…".
      await db.agent.updateMany({ where: { id: agentId }, data: { migrateDeliveredAt: new Date(), ...(agent.migrateRequested ? { migrateRequested: false } : {}) } });
      migrate = { appUrl: decision.targetUrl };
    }
```

Then extend the FINAL `db.agent.update({ ... lastSeenAt ... })` data object to persist the reported URL, convergence, and error. Add to its `data`:

```ts
        ...(appUrl ? { currentAppUrl: appUrl } : {}),
        ...(decision.converged ? { migratedAt: new Date(), migrateError: null, migrateRequested: false } : (migrateError !== null ? { migrateError } : {})),
```

Finally, change the `return`:

```ts
    return { ok: true, enabled: agent.enabled, update, restart, discover, migrate };
```

- [ ] **Step 3: Add `requestMigrate` (operator canary trigger)**

In `runner-service.ts`, after `requestRestart` (~line 438), add (mirroring its shape; note the target-set precondition):

```ts
  async requestMigrate(agentId: string, actor: ActorInput = "ui"): Promise<{ id: string }> {
    const setting = await getAppSetting<AgentMigrationSetting>(db, AGENT_MIGRATION_KEY);
    if (!setting?.targetUrl || !setting.targetUrl.trim()) throw new HttpError(409, "set the migration target URL in Settings before migrating an agent");
    const agent = await db.agent.findUnique({ where: { id: agentId }, select: { id: true, enabled: true, deletedAt: true } });
    if (!agent) throw new HttpError(404, "unknown agent");
    if (agent.deletedAt) throw new HttpError(409, "agent is in the trash");
    if (!agent.enabled) throw new HttpError(409, "enable the runner before migrating it");
    const who = resolveActor(actor);
    await db.agent.update({ where: { id: agentId }, data: { migrateRequested: true, migrateRequestedAt: new Date(), migrateRequestedBy: displayActor(who.actor), migrateDeliveredAt: null, migratedAt: null, migrateError: null } });
    await db.auditLog.create({ data: { actor: who.actor, userId: who.userId, action: "agent.migrate_requested", detail: { agentId, targetUrl: setting.targetUrl } } });
    return { id: agentId };
  }
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (This is the verification gate — the repo has no DB test for this path; the pure decision is covered in Task 2 and the end-to-end path in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add web/app/api/agents/heartbeat/route.ts web/lib/jobs/runner-service.ts
git commit -m "feat(web): heartbeat emits migrate + records reported URL / convergence"
```

---

### Task 4: Global migration setting — API route + Settings UI

**Files:**
- Create: `web/app/api/admin/agent-migration/route.ts`
- Create: `web/app/settings/_components/agent-migration-settings.tsx`
- Modify: `web/app/settings/page.tsx`

**Interfaces:**
- Consumes: `AGENT_MIGRATION_KEY`, `AgentMigrationSetting` (Task 2); `setAppSetting`/`getAppSetting`, `guard`, `recordAudit`.
- Produces: `POST /api/admin/agent-migration` accepting `{ enabled?: boolean; targetUrl?: string }`; a `<AgentMigrationSettings initial={...} />` card.

- [ ] **Step 1: Write the save route**

Create `web/app/api/admin/agent-migration/route.ts` (mirrors `agent-auto-update/route.ts`):

```ts
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { setAppSetting } from "@/lib/settings";
import { AGENT_MIGRATION_KEY } from "@/lib/jobs/agent-migration";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guard("settings.manage"); if (g.res) return g.res;
  const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; targetUrl?: unknown };
  const enabled = Boolean(body.enabled);
  const targetUrl = typeof body.targetUrl === "string" ? body.targetUrl.trim() : "";
  // A non-empty target must be an absolute http(s) URL — a bad value would strand agents that trust it.
  if (targetUrl) {
    let ok = false;
    try { const u = new URL(targetUrl); ok = u.protocol === "http:" || u.protocol === "https:"; } catch { ok = false; }
    if (!ok) return NextResponse.json({ error: "targetUrl must be an absolute http(s) URL" }, { status: 422 });
  }
  if (enabled && !targetUrl) return NextResponse.json({ error: "set a target URL before enabling fleet migration" }, { status: 422 });
  await setAppSetting(db, AGENT_MIGRATION_KEY, { enabled, targetUrl });
  await recordAudit("agent.migration.configure", { user: g.user, detail: { enabled, targetUrl } });
  return NextResponse.json({ ok: true, enabled, targetUrl });
}
```

- [ ] **Step 2: Write the Settings card**

Create `web/app/settings/_components/agent-migration-settings.tsx` (client component; mirrors `agent-auto-update-toggle.tsx`, but with a URL field + a guarded enable toggle):

```tsx
"use client";
import { useState } from "react";

export function AgentMigrationSettings({ initial }: { initial: { enabled: boolean; targetUrl: string } }) {
  const [targetUrl, setTargetUrl] = useState(initial.targetUrl);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(next: { enabled: boolean; targetUrl: string }) {
    setSaving(true); setErr(null); setOk(false);
    try {
      const r = await fetch("/api/admin/agent-migration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      if (!r.ok) { const d = (await r.json().catch(() => ({}))) as { error?: string }; setErr(d.error ?? `failed (${r.status})`); return; }
      setEnabled(next.enabled); setTargetUrl(next.targetUrl); setOk(true);
    } catch { setErr("request failed"); } finally { setSaving(false); }
  }

  return (
    <section>
      <h3>Agent domain migration</h3>
      <p className="note">Point agents at a new app URL. Each agent verifies it can reach the new URL, rewrites its own scheduled task, and switches — the old URL is removed once it reports in on the new one. Set the target, prove it on one agent from the Agents page (Migrate), then enable fleet-wide.</p>
      <label>New app base URL
        <input type="url" placeholder="https://iam.core.tech" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button disabled={saving} onClick={() => save({ enabled, targetUrl })}>{saving ? "Saving…" : "Save target"}</button>
        <button disabled={saving || !targetUrl} onClick={() => save({ enabled: !enabled, targetUrl })}>{enabled ? "Disable fleet migration" : "Enable fleet migration"}</button>
      </div>
      <p className="note" style={{ marginTop: 6 }}>Fleet migration: {enabled ? "ON — every agent migrates on its next heartbeat" : "off — only agents you migrate individually"}</p>
      {err && <p className="note" style={{ color: "var(--danger, #b00)" }}>{err}</p>}
      {ok && <p className="note" style={{ color: "var(--ok, #070)" }}>saved</p>}
    </section>
  );
}
```

- [ ] **Step 3: Render it on the Settings page**

In `web/app/settings/page.tsx`: add to the imports the setting key + component, add `getAppSetting<{ enabled?: boolean; targetUrl?: string }>(db, AGENT_MIGRATION_KEY)` to the `Promise.all`, destructure it (e.g. `agentMigration`), and render in the JSX:

```tsx
<AgentMigrationSettings initial={{ enabled: agentMigration?.enabled === true, targetUrl: agentMigration?.targetUrl ?? "" }} />
```

Imports to add:

```ts
import { AGENT_MIGRATION_KEY } from "@/lib/jobs/agent-migration";
import { AgentMigrationSettings } from "./_components/agent-migration-settings";
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/admin/agent-migration web/app/settings/_components/agent-migration-settings.tsx web/app/settings/page.tsx
git commit -m "feat(web): Settings card + API to set the agent migration target"
```

---

### Task 5: Agents UI — Migrate action, current URL, migration status

**Files:**
- Modify: `web/app/agents/actions.ts` (add `requestAgentMigrate`)
- Modify: `web/app/agents/_lib/loader.ts` (map new columns into `AgentVM`)
- Modify: `web/app/agents/_components/agents-view.tsx` (`AgentVM` type, `migrateStatus`, buttons, live-poll keys, URL display)

**Interfaces:**
- Consumes: `requestMigrate` (Task 3).
- Produces: `requestAgentMigrate(id: string)` server action; `AgentVM` fields `currentAppUrl`, `migrateRequested`, `migrateRequestedAt`, `migrateRequestedBy`, `migrateDeliveredAt`, `migratedAt`, `migrateError`.

- [ ] **Step 1: Add the server action**

In `web/app/agents/actions.ts`, after `requestAgentRestart`:

```ts
export async function requestAgentMigrate(id: string) {
  try {
    const me = await requirePermission("agent.manage");
    await makeRunnerService(db).requestMigrate(id, auditActor(me, "ui"));
    revalidatePath("/agents");
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: errMsg(e) };
  }
}
```

- [ ] **Step 2: Map the columns in the loader**

In `web/app/agents/_lib/loader.ts`, inside the `vms` mapping return object (after the `restart*` fields), add:

```ts
    currentAppUrl: a.currentAppUrl ?? null,
    migrateRequested: a.migrateRequested,
    migrateRequestedAt: a.migrateRequestedAt?.toISOString() ?? null,
    migrateRequestedBy: a.migrateRequestedBy ?? null,
    migrateDeliveredAt: a.migrateDeliveredAt?.toISOString() ?? null,
    migratedAt: a.migratedAt?.toISOString() ?? null,
    migrateError: a.migrateError ?? null,
```

- [ ] **Step 3: Extend the `AgentVM` type + import the action**

In `web/app/agents/_components/agents-view.tsx`, add to the `AgentVM` type (near the `restart*` fields):

```ts
  currentAppUrl: string | null;
  migrateRequested: boolean;
  migrateRequestedAt: string | null;
  migrateRequestedBy: string | null;
  migrateDeliveredAt: string | null;
  migratedAt: string | null;
  migrateError: string | null;
```

Add `requestAgentMigrate` to the actions import (line 7).

- [ ] **Step 4: Add a `migrateStatus` label fn**

Near `restartStatus` (~lines 82-112), add (returns a live label + color, or null):

```ts
function migrateStatus(a: AgentVM): { label: string; color: string } | null {
  if (a.migrateError) return { label: `migration failed: ${a.migrateError}`, color: "#b00" };
  if (a.migratedAt) return { label: "migrated ✓", color: "#070" };
  if (a.migrateRequested) return { label: "migrate queued…", color: "#a60" };
  if (a.migrateDeliveredAt) return { label: "migrating…", color: "#a60" };
  return null;
}
```

- [ ] **Step 5: Render the status + current URL on the row**

In the classic status cell (~lines 547-551), after the `restartStatus` IIFE add the same pattern for `migrateStatus(a)`. Where the row shows host/version, add the current base URL when present:

```tsx
{a.currentAppUrl && <div className="note" style={{ marginTop: 2 }}>url: {a.currentAppUrl}</div>}
```

- [ ] **Step 6: Add the Migrate button (classic + v2)**

Classic (in the 2×2 button grid, ~lines 560-569), after the Restart button:

```tsx
{a.enabled && !a.migratedAt && (
  <button onClick={() => run(a.id, requestAgentMigrate)} disabled={toggling === a.id || a.migrateRequested} title="Verify the new app URL, rewrite this agent's scheduled task, and switch it to the new domain">
    {toggling === a.id ? "…" : a.migrateRequested ? "Migrating…" : "Migrate"}
  </button>
)}
```

v2 `ActionsMenu` items array (~lines 649-664), add an entry:

```ts
...(a.enabled && !a.migratedAt
  ? [{ label: a.migrateRequested ? "Migrating…" : "Migrate to new URL", disabled: toggling === a.id || a.migrateRequested, onClick: () => run(a.id, requestAgentMigrate) }]
  : []),
```

- [ ] **Step 7: Keep the row live during a migration**

In the live-refresh poll effect (~lines 321-333), extend the freshness check so a row with a pending/in-flight migration keeps polling — add `a.migrateRequested`, `a.migrateDeliveredAt`, and "recently migrated/errored" to whatever predicate gates the interval (mirror how `restartRequested`/`restartDeliveredAt` are used there).

- [ ] **Step 8: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add web/app/agents
git commit -m "feat(web): Agents UI migrate action + current-URL + migration status"
```

---

### Task 6: Runner pure helpers — URL rewrite in supervisor definitions

**Files:**
- Create: `runner/lib/CtgMigrate.ps1` (dot-sourceable pure helpers)
- Test: `runner/tests/CtgMigrate.Tests.ps1`

**Interfaces:**
- Produces:
  - `Set-CtgAppUrlInArgString -ArgString <string> -NewUrl <string>` → new arg string with the `-AppUrl` token's value replaced (used for the Windows Scheduled Task argument and the systemd `ExecStart` line).
  - `Set-CtgAppUrlInPlist -PlistXml <string> -NewUrl <string>` → new plist text with the `<string>` element following `<string>-AppUrl</string>` replaced.

- [ ] **Step 1: Write the failing Pester test**

Create `runner/tests/CtgMigrate.Tests.ps1`:

```powershell
BeforeAll { . "$PSScriptRoot/../lib/CtgMigrate.ps1" }

Describe 'Set-CtgAppUrlInArgString' {
  It 'replaces a quoted -AppUrl value, preserving other args' {
    $in = '-NoProfile -ExecutionPolicy Bypass -File "C:\iam-runner\Start-IamRunner.ps1" -AppUrl "https://old.kentassociates.org" -AgentId "abc" -StallTimeoutSeconds 600'
    $out = Set-CtgAppUrlInArgString -ArgString $in -NewUrl 'https://iam.core.tech'
    $out | Should -BeLike '*-AppUrl "https://iam.core.tech"*'
    $out | Should -Not -BeLike '*kentassociates*'
    $out | Should -BeLike '*-AgentId "abc"*'
    $out | Should -BeLike '*-StallTimeoutSeconds 600*'
  }
  It 'replaces an unquoted -AppUrl value' {
    $in = '-File x -AppUrl https://old -AgentId abc'
    (Set-CtgAppUrlInArgString -ArgString $in -NewUrl 'https://new') | Should -BeLike '*-AppUrl "https://new"*'
  }
  It 'is a no-op-safe idempotent replace (running twice yields the same)' {
    $once = Set-CtgAppUrlInArgString -ArgString '-AppUrl "https://old" -AgentId a' -NewUrl 'https://new'
    (Set-CtgAppUrlInArgString -ArgString $once -NewUrl 'https://new') | Should -Be $once
  }
}

Describe 'Set-CtgAppUrlInPlist' {
  It 'replaces the string element after -AppUrl only' {
    $in = @'
<array>
<string>-File</string>
<string>/opt/iam/Start-IamRunner.ps1</string>
<string>-AppUrl</string>
<string>https://old.kentassociates.org</string>
<string>-AgentId</string>
<string>abc</string>
</array>
'@
    $out = Set-CtgAppUrlInPlist -PlistXml $in -NewUrl 'https://iam.core.tech'
    $out | Should -BeLike '*<string>https://iam.core.tech</string>*'
    $out | Should -Not -BeLike '*kentassociates*'
    $out | Should -BeLike '*<string>abc</string>*'
  }
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester -Path runner/tests/CtgMigrate.Tests.ps1 -Output Detailed"`
Expected: FAIL — `Set-CtgAppUrlInArgString` not recognized.

- [ ] **Step 3: Implement the helpers**

Create `runner/lib/CtgMigrate.ps1`:

```powershell
# Pure helpers for app-URL self-migration: rewrite the -AppUrl value inside a supervisor definition
# (Scheduled Task argument string / systemd ExecStart / launchd plist). No OS calls here so they are
# Pester-unit-testable; the OS-touching Invoke-CtgMigrate lives in Start-IamRunner.ps1 and calls these.

function Set-CtgAppUrlInArgString {
  # Replace the value following -AppUrl (quoted or bare) with a quoted new URL. Leaves every other arg
  # intact. Idempotent: re-running with the same new URL yields the same string.
  param([Parameter(Mandatory)][string]$ArgString, [Parameter(Mandatory)][string]$NewUrl)
  $repl = '-AppUrl "' + $NewUrl + '"'
  # Match -AppUrl then either a "double-quoted" value or a bare (whitespace-delimited) token.
  return [regex]::Replace($ArgString, '-AppUrl\s+("[^"]*"|\S+)', $repl)
}

function Set-CtgAppUrlInPlist {
  # In a launchd plist's ProgramArguments, the value is the <string> element immediately AFTER the
  # <string>-AppUrl</string> element. Replace only that one.
  param([Parameter(Mandatory)][string]$PlistXml, [Parameter(Mandatory)][string]$NewUrl)
  $pattern = '(<string>-AppUrl</string>\s*<string>)[^<]*(</string>)'
  return [regex]::Replace($PlistXml, $pattern, ('${1}' + [System.Security.SecurityElement]::Escape($NewUrl) + '${2}'))
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester -Path runner/tests/CtgMigrate.Tests.ps1 -Output Detailed"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add runner/lib/CtgMigrate.ps1 runner/tests/CtgMigrate.Tests.ps1
git commit -m "feat(runner): pure -AppUrl rewrite helpers for supervisor definitions"
```

---

### Task 7: Runner — `Invoke-CtgMigrate` verify → rewrite → relaunch

**Files:**
- Modify: `runner/Start-IamRunner.ps1` (dot-source `lib/CtgMigrate.ps1`; add `$AppUrl`/`$migrateError` to the heartbeat POST; handle `$hb.migrate`; add `Invoke-CtgMigrate`)

**Interfaces:**
- Consumes: `Set-CtgAppUrlInArgString`, `Set-CtgAppUrlInPlist` (Task 6); existing `Invoke-CtgRelaunch`, `$AppUrl`, `$ApiToken`, `$AgentId`.
- Produces: `Invoke-CtgMigrate -NewAppUrl <string>` — verifies, rewrites the platform supervisor, then relaunches; on any failure sets `$script:LastMigrateError` and returns WITHOUT relaunching.

- [ ] **Step 1: Dot-source the helpers**

Near the top of `Start-IamRunner.ps1` where other `lib/` files/modules are loaded, add:

```powershell
. (Join-Path $PSScriptRoot 'lib/CtgMigrate.ps1')
```

- [ ] **Step 2: Report the current URL (and any last migrate error) on the heartbeat**

Change the heartbeat POST (~line 2474) to include `appUrl` and, when set, `migrateError`:

```powershell
        $hbBody = @{ agentId = $AgentId; version = $script:RunnerBuild; semver = $script:RunnerSemver; startedAt = $script:RunnerStartedAt; capabilities = $script:RunnerCapabilitiesJson; appUrl = $AppUrl }
        if ($script:LastMigrateError) { $hbBody['migrateError'] = $script:LastMigrateError }
        $hb = Invoke-AppApi POST '/api/agents/heartbeat' $hbBody
```

- [ ] **Step 3: Act on the migrate instruction**

After the `restart`/`discover` handling (~lines 2477-2478), add:

```powershell
        if ($hb.migrate -and $hb.migrate.appUrl) { Invoke-CtgMigrate -NewAppUrl ([string]$hb.migrate.appUrl) }
```

- [ ] **Step 4: Implement `Invoke-CtgMigrate`**

Add near `Invoke-CtgRelaunch` / `Restart-CtgRunner` (~line 1665):

```powershell
function Invoke-CtgMigrate {
  # Operator moved the app to a new hostname. VERIFY we can reach the new URL, REWRITE our own
  # supervisor entry (Scheduled Task / launchd plist / systemd unit) replacing -AppUrl, then relaunch
  # on the new URL. On any failure: record it (reported on the next heartbeat) and DO NOT relaunch —
  # a half-migrated agent must never loop. The verify de-risks removing the old URL up front.
  param([Parameter(Mandatory)][string]$NewAppUrl)
  if ($NewAppUrl.TrimEnd('/') -ieq ([string]$AppUrl).TrimEnd('/')) { return }  # already there
  Write-Host "migrate: requested move to $NewAppUrl — verifying reachability" -ForegroundColor Yellow

  # 1) VERIFY: authenticated GET of the manifest on the NEW host must return 200 (same backend, our
  #    existing token validates). Anything else → stay put and report.
  try {
    $H = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $H['Authorization'] = "Bearer $ApiToken" }
    $null = Invoke-RestMethod -Uri "$NewAppUrl/api/runner/manifest" -Headers $H -TimeoutSec 30 -ErrorAction Stop
  } catch {
    $script:LastMigrateError = "unreachable: $($_.Exception.Message)"
    Write-Warning "migrate: new URL not reachable — staying on $AppUrl ($script:LastMigrateError)"
    return
  }

  # 2) REWRITE the supervisor entry (old URL removed, not appended).
  try {
    if ($IsWindows) {
      $task = Get-ScheduledTask -TaskName 'iam-runner' -ErrorAction Stop
      $act = $task.Actions[0]
      $newArgs = Set-CtgAppUrlInArgString -ArgString $act.Arguments -NewUrl $NewAppUrl
      $newAction = New-ScheduledTaskAction -Execute $act.Execute -Argument $newArgs -WorkingDirectory $act.WorkingDirectory
      Set-ScheduledTask -TaskName 'iam-runner' -Action $newAction -ErrorAction Stop | Out-Null
    }
    elseif ($IsMacOS) {
      $plist = Join-Path $HOME 'Library/LaunchAgents/com.coretelligent.iam-runner.plist'
      if (-not (Test-Path $plist)) { throw "launchd plist not found at $plist" }
      $xml = [System.IO.File]::ReadAllText($plist)
      [System.IO.File]::WriteAllText($plist, (Set-CtgAppUrlInPlist -PlistXml $xml -NewUrl $NewAppUrl))
      & launchctl unload $plist 2>$null; & launchctl load $plist 2>$null
    }
    else {
      $unit = '/etc/systemd/system/iam-runner.service'
      if (-not (Test-Path $unit)) { throw "systemd unit not found at $unit" }
      $lines = [System.IO.File]::ReadAllLines($unit)
      for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*ExecStart=') { $lines[$i] = Set-CtgAppUrlInArgString -ArgString $lines[$i] -NewUrl $NewAppUrl } }
      [System.IO.File]::WriteAllLines($unit, $lines)
      & systemctl daemon-reload 2>$null
    }
  } catch {
    $script:LastMigrateError = "rewrite failed: $($_.Exception.Message)"
    Write-Warning "migrate: could not rewrite the supervisor entry — staying on $AppUrl ($script:LastMigrateError)"
    return
  }

  # 3) SWITCH: point this process (and every relaunch surface built from $AppUrl) at the new URL, then
  #    relaunch. Supervised → exit (the rewritten entry brings us back on the new URL); unsupervised →
  #    the self-spawn in Invoke-CtgRelaunch reads $script:AppUrl, now updated.
  $script:LastMigrateError = $null
  $script:AppUrl = $NewAppUrl
  $global:CtgProgressUrl = $NewAppUrl
  Write-Host "migrate: verified + supervisor rewritten — switching to $NewAppUrl" -ForegroundColor Green
  Invoke-CtgRelaunch -Reason 'migrate'
}
```

Note: `$AppUrl` is the script param; `Invoke-CtgMigrate` sets `$script:AppUrl` so `Invoke-CtgRelaunch`'s self-spawn (unsupervised) and the watchdog args pick up the new value. Initialize `$script:LastMigrateError = $null` once near the top of the script (with the other `$script:` inits) so the heartbeat reference is always defined.

- [ ] **Step 5: Add the `$script:LastMigrateError` initializer**

Near the other `$script:` initializations (top of the run section, before the `while ($true)` loop), add:

```powershell
$script:LastMigrateError = $null
```

- [ ] **Step 6: Syntax-check the script parses**

Run: `~/.local/pwsh/pwsh -NoProfile -c "\$null = [System.Management.Automation.Language.Parser]::ParseFile('runner/Start-IamRunner.ps1', [ref]\$null, [ref]\$errs); if (\$errs) { \$errs; exit 1 } else { 'parse ok' }"`
Expected: `parse ok` (no parse errors).

- [ ] **Step 7: Run the full runner Pester suite (no regressions)**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester -Path runner/tests -Output Detailed"`
Expected: all pass (existing suite + the 4 new CtgMigrate tests).

- [ ] **Step 8: Commit**

```bash
git add runner/Start-IamRunner.ps1
git commit -m "feat(runner): Invoke-CtgMigrate — verify new URL, rewrite supervisor, switch"
```

---

### Task 8: End-to-end verify, VERSION bump, changelog

**Files:**
- Modify: `runner/VERSION`
- Modify: `web/lib/changelog/entries.ts`

**Interfaces:** none produced; this task proves the whole path and ships the release metadata.

- [ ] **Step 1: Bump the runner version**

Set `runner/VERSION` to:

```
1.62.0
```

- [ ] **Step 2: Prepend the changelog entry**

At the TOP of the `CHANGELOG` array in `web/lib/changelog/entries.ts`, add (pick the current `time` on a 15-min boundary):

```ts
  {
    id: "agent-url-migration",
    date: "2026-07-15",
    time: "17:30",
    title: "Agents can move to a new app domain by themselves — no reinstall on each on-prem network",
    items: [
      "Set a new app URL under Settings → Agent domain migration. Prove it on one agent with the Migrate button, then enable it fleet-wide.",
      "Each agent verifies it can reach the new URL, rewrites its own scheduled task / launchd / systemd entry, and switches — the old URL is removed once it reports in on the new one.",
      "If the new URL is unreachable or the rewrite fails, the agent stays on the old URL and the failure shows on its row in Agents; it retries on the next heartbeat.",
      "The Agents page shows each agent's current base URL and its migration status, so you can watch the fleet converge before retiring the old host. Needs runner 1.62.0.",
    ],
  },
```

- [ ] **Step 3: Run the changelog + web unit tests**

Run: `cd web && npx tsc --noEmit && npx tsx --test "lib/**/*.test.ts"`
Expected: PASS (changelog shape/order test green; `agent-migration` tests green).

- [ ] **Step 4: End-to-end dev verification (real switch)**

With the dev app running (see the web-dev-verify recipe), simulate a migration against two reachable dev URLs:
1. Start a dev runner pointed at an "old" dev URL (`-AppUrl http://127.0.0.1:3000`) with a valid `-AgentId`/token.
2. In Settings → Agent domain migration, set the target to a second reachable alias for the same app (e.g. `http://localhost:3000`), Save, then click **Migrate** on that agent's row.
3. Observe in the runner console: `migrate: verified … switching`, a relaunch, then `polling http://localhost:3000`.
4. Observe on the Agents page: the row's current URL flips to the new alias and status shows `migrated ✓`.
5. Negative check: set the target to an unreachable URL (`http://127.0.0.1:9`), Migrate, confirm the runner logs `unreachable`, stays on the old URL, and the row shows `migration failed: unreachable …`.

Record the observed console + UI outcome in the PR description.

- [ ] **Step 5: Commit**

```bash
git add runner/VERSION web/lib/changelog/entries.ts
git commit -m "chore: runner 1.62.0 + changelog for agent URL self-migration"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (agent reports current URL) → Task 3 Step 1-2 (`appUrl` in body + persisted), Task 7 Step 2 (runner sends it), Task 5 (UI shows it). ✓
- Component 2 (global target + per-agent canary, heartbeat emits `migrate`) → Task 2 (decision), Task 3 (wiring + `requestMigrate`), Task 4 (global setting UI/route), Task 5 (canary button). ✓
- Component 3 (verify → rewrite → relaunch; no-relaunch-on-failure) → Task 6 (pure rewrite), Task 7 (Invoke-CtgMigrate). ✓
- Component 4 (confirmation + observability) → Task 3 (`migratedAt`/converged), Task 5 (`migrateStatus`, live poll). ✓
- Clean cutover / old URL removed → Task 6/7 (replace not append; `Set-*` + relaunch). ✓
- Error table (unreachable / rewrite fail / offline / equal target) → Task 2 tests + Task 7 guards + Task 8 negative check. ✓
- Cleanup (VERSION, changelog) → Task 8. (Hard-coded `192.168.0.81` defaults in `update-*` helpers are cosmetic local-helper defaults; left out of scope to keep the change focused — noted in the spec.)

**Placeholder scan:** no TBD/TODO; every code step shows real code. ✓

**Type consistency:** `migrateDecision` return `{ migrate, targetUrl, converged }` used identically in Task 3; column names (`currentAppUrl`, `migrateRequested`, `migrateRequestedAt`, `migrateRequestedBy`, `migrateDeliveredAt`, `migratedAt`, `migrateError`) identical across Tasks 1/3/5; `Set-CtgAppUrlInArgString`/`Set-CtgAppUrlInPlist` names identical in Tasks 6/7; `$script:LastMigrateError` defined (Task 7 Step 5) before use (Task 7 Step 2). ✓
