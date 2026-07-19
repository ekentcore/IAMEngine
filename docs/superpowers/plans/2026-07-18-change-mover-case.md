# Unified Change/Mover Case — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third case action, `change`, that adds/removes an existing user's group / DL / shared-mailbox / license / OU / attribute access — as a computed persona/location "mover" diff or as hand-picked ad-hoc deltas — reusing the existing runner primitives, planning, approval, audit, and run-report machinery.

**Architecture:** A pure diff engine (`web/lib/cases/change-plan.ts`) turns a target state (reused from `resolvePlannedConfigs` on the onboard path) plus a removal mode into per-directory `ChangeDiff`s, which a change planner converts into `PlannedJob[]` carrying a documented change-config contract. A new `change` branch in the runner job loop dispatches to per-module `Invoke-Ctg*Change` functions that reuse existing add/remove primitives. A dialog + preview modal (scoped/full/add-only) create the case; execution monitoring reuses `run-report-view`.

**Tech Stack:** Next.js App Router + TypeScript + Prisma + PostgreSQL (web); PowerShell 7 modules (runner); tests via `tsx --test` (`node:test`/`node:assert/strict`) for web and Pester for the runner.

## Global Constraints

- The change-config **contract** (keys the web planner writes and the runner reads) is fixed for all tasks: `groups: string[]` (add), `removeGroups: string[]` (remove by name), `reconcileGroups: boolean` (full mode), `desiredGroups: string[]` (reconcile keep-list), `moveToOu: string` (full DN, `OU=…,DC=…`), `attributes: Record<string,unknown>`, `licenses: unknown[]` (add), `removeLicenses: string[]`, `namedGroups: string[]` (Exchange add DL/365-group by name), `removeNamedGroups: string[]` (Exchange remove by name), `addSharedMailboxes: string[]`, `removeSharedMailboxes: string[]`.
- Every new runner function MUST be added to BOTH the module `.psm1`'s `Export-ModuleMember -Function` and the `.psd1`'s `FunctionsToExport` array (see [[module-manifest-export-drift]]).
- Bump `runner/VERSION` once (minor — additive/compatible) in Task 14.
- NEVER run `prisma migrate dev` against the shared dev DB (see [[db-reset-incident-2026-07-13]]). Create the migration SQL and apply it to an isolated DB only.
- Web tests run from `web/`: `npx tsx --test lib/<path>.test.ts`. Runner Pester runs via `~/.local/pwsh/pwsh` (see [[runner-pwsh-testing]]).
- **tsc baseline:** `npx tsc --noEmit` is NOT clean on `main` — there are 3 pre-existing `warningsDismissed` errors in `web/app/cases/_components/run-report-view.tsx`. The gate for every task is "no NEW tsc errors beyond those 3" — not zero. (Adding `change` to the enum in Task 1 also required fixing ~11 `Action`-narrowed sites; that fallout is part of Task 1.)
- Commit after each task; end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Protected-group denylist is authoritative on BOTH add and remove: `domain admins, enterprise admins, schema admins, administrators, account operators, backup operators, server operators, print operators, group policy creator owners, dnsadmins, key admins, enterprise key admins` (matches `plan-resolve.ts:185` and AD's `Test-CtgADProtectedGroup`).
- v1 preview is rule-derived; full reconciliation is executed runner-side. No per-user live-membership discovery in v1.

---

## File Structure

**Web — create:**
- `web/lib/cases/change-types.ts` — shared TS types (`ChangeKind`, `RemovalMode`, `ChangeDelta`, `ChangePayload`, `ChangeDiff`, `ChangeJobConfig`).
- `web/lib/cases/change-plan.ts` — pure diff engine + `planChangeJobs` + target/managed-group helpers.
- `web/lib/cases/change-plan.test.ts` — diff-engine + planner tests.
- `web/lib/cases/change-service.ts` — `createChangeCase` / `confirmChangeCase` orchestration (mirrors `planning-service.ts`).
- `web/app/api/cases/change/route.ts` — create + plan.
- `web/app/api/cases/[id]/change/confirm/route.ts` — apply removal mode → (re)plan execution jobs.
- `web/app/api/cases/change/bulk/route.ts` — bulk fan-out.
- `web/app/clients/_components/change-case-dialog.tsx` — the create dialog.
- `web/app/cases/_components/change-preview.tsx` — the scoped/full/add-only preview modal.
- `web/lib/changelog/entries/change-mover-case.ts` — changelog entry.

**Web — modify:**
- `web/prisma/schema.prisma` — add `change` to `enum Action` (+ migration).
- `web/lib/cases/planning-service.ts` — export a small `writeChangeCase` repo helper OR reuse `createCaseWithJobs` (Task 5).
- `web/app/api/cases/route.ts` — widen the `action` validation to accept `change` (delegates to change-service).

**Runner — modify:**
- `runner/Start-IamRunner.ps1` — `change` branch in the job loop (Task 9); `Change` scriptblocks in `$DISPATCH` (Tasks 10–13); dir-sync trigger + `entra` alias (Task 14).
- `runner/modules/Coretelligent.ActiveDirectory/*` — `Invoke-CtgADChange` (Task 10).
- `runner/modules/Coretelligent.M365/*` — `Invoke-CtgM365Change` (Task 11).
- `runner/modules/Coretelligent.Exchange/*` — `Invoke-CtgExchangeChange` (Task 12).
- `runner/modules/Coretelligent.GoogleWorkspace/*` — `Invoke-CtgGoogleChange` (Task 13).
- `runner/VERSION`, `web/lib/generator/system-map.ts` (Task 14).

---

## Task 1: Add the `change` action to the schema

**Files:**
- Modify: `web/prisma/schema.prisma:40-43` (the `Action` enum)
- Create: `web/prisma/migrations/20260718120000_change_action/migration.sql`

**Interfaces:**
- Produces: the Prisma `Action` enum now includes `change`, usable as `"change"` throughout web code.

- [ ] **Step 1: Edit the enum**

In `web/prisma/schema.prisma`, change:
```prisma
enum Action {
  onboard
  offboard
}
```
to:
```prisma
enum Action {
  onboard
  offboard
  change
}
```

- [ ] **Step 2: Write the migration SQL**

Create `web/prisma/migrations/20260718120000_change_action/migration.sql`:
```sql
-- Add the "change" (mover / ad-hoc access) value to the Action enum.
ALTER TYPE "Action" ADD VALUE IF NOT EXISTS 'change';
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd web && npx prisma generate`
Expected: "Generated Prisma Client" with no error. (Do NOT run `migrate dev` against the shared DB — see [[db-reset-incident-2026-07-13]]. Apply the SQL to an isolated DB when verifying end-to-end.)

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors from the enum change.

- [ ] **Step 5: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/20260718120000_change_action
git commit -m "feat(schema): add change action to Action enum"
```

---

## Task 2: Change payload + diff types

**Files:**
- Create: `web/lib/cases/change-types.ts`

**Interfaces:**
- Produces: `ChangeKind`, `RemovalMode`, `ChangeTarget`, `ChangeDelta`, `ChangePayload`, `ChangeDiff`, `ChangeJobConfig`, `DIRECTORY_SYSTEMS`, `PROTECTED_GROUPS`, `isProtectedGroup(name)`.

- [ ] **Step 1: Write the types file**

Create `web/lib/cases/change-types.ts`:
```ts
// Shared contract for the "change" (mover / ad-hoc access) action. The web planner writes
// ChangeJobConfig onto each directory job's config; the runner Change lane reads the same keys.
export type ChangeKind = "mover" | "adhoc";
export type RemovalMode = "scoped" | "full" | "add-only";
export type ChangeTarget = "group" | "dl" | "sharedMailbox" | "license" | "ou" | "attribute";

// One hand-picked delta (ad-hoc path). `value` is a group/DL/mailbox/license name, an OU DN,
// or "key=value" for an attribute. `system` optionally narrows to one directory systemKey.
export type ChangeDelta = {
  op: "add" | "remove";
  target: ChangeTarget;
  value: string;
  system?: string;
};

export type ChangePayload = {
  userToChange: string; // display name or UPN of the EXISTING user
  changeKind: ChangeKind;
  // mover:
  fromPersona?: string;
  toPersona?: string;
  fromLocation?: string;
  toLocation?: string;
  removalMode?: RemovalMode; // set on confirm from the preview modal
  // adhoc:
  deltas?: ChangeDelta[];
};

// Per-directory diff, one per active directory systemKey.
export type ChangeDiff = {
  systemKey: string;
  add: string[]; // groups to add (idempotent at the runner)
  removeGroups: string[]; // named groups to remove (scoped mode)
  reconcileGroups: boolean; // full mode → runner removes anything not in desiredGroups
  desiredGroups: string[]; // reconcile keep-list (the target group set)
  moveToOu?: string; // AD only, full DN
  attributes?: Record<string, unknown>;
  licenses?: unknown[]; // m365 only, add
  removeLicenses?: string[]; // m365 only
  namedGroups?: string[]; // exchange: DL/365-group add by name
  removeNamedGroups?: string[]; // exchange: DL/365-group remove by name
  addSharedMailboxes?: string[];
  removeSharedMailboxes?: string[];
};

// What lands on job.config (the runner Change lane's read contract).
export type ChangeJobConfig = Omit<ChangeDiff, "systemKey" | "add"> & { groups: string[] };

// Directory systems whose group/OU/attr/license state the change lane manages.
export const DIRECTORY_SYSTEMS = ["active-directory", "entra", "m365", "exchange", "google-workspace"] as const;

export const PROTECTED_GROUPS: ReadonlySet<string> = new Set(
  [
    "domain admins", "enterprise admins", "schema admins", "administrators",
    "account operators", "backup operators", "server operators", "print operators",
    "group policy creator owners", "dnsadmins", "key admins", "enterprise key admins",
  ].map((g) => g.toLowerCase())
);

export function isProtectedGroup(name: string): boolean {
  return PROTECTED_GROUPS.has(name.trim().toLowerCase());
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/lib/cases/change-types.ts
git commit -m "feat(change): add change payload + diff contract types"
```

---

## Task 3: The diff engine

**Files:**
- Create: `web/lib/cases/change-plan.ts` (diff functions only in this task)
- Test: `web/lib/cases/change-plan.test.ts`

**Interfaces:**
- Consumes: `ChangeDiff`, `RemovalMode`, `isProtectedGroup` from `./change-types` (Task 2).
- Produces:
  - `computeMoverDiff(args: { directorySystems: string[]; targetGroupsBySystem: Record<string,string[]>; fromManagedGroups: string[]; targetOuBySystem?: Record<string,string>; removalMode: RemovalMode }): ChangeDiff[]`
  - `deltasToDiff(deltas: ChangeDelta[], directorySystems: string[]): ChangeDiff[]`
  - helper `emptyDiff(systemKey: string): ChangeDiff`

- [ ] **Step 1: Write the failing tests**

Create `web/lib/cases/change-plan.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMoverDiff, deltasToDiff } from "./change-plan";

const dirs = ["active-directory", "m365"];

test("mover scoped: adds target groups, removes managed-but-not-target, keeps unmanaged", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": ["Sales", "AllStaff"] },
    fromManagedGroups: ["Support", "AllStaff"],
    removalMode: "scoped",
  });
  assert.deepEqual(ad.add.sort(), ["AllStaff", "Sales"]);
  assert.deepEqual(ad.removeGroups, ["Support"]); // managed by old role, not in new role
  assert.equal(ad.reconcileGroups, false);
});

test("mover scoped: never removes a protected group even if managed", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": [] },
    fromManagedGroups: ["Domain Admins", "Support"],
    removalMode: "scoped",
  });
  assert.deepEqual(ad.removeGroups, ["Support"]); // Domain Admins excluded
});

test("mover full: sets reconcile + desired keep-list, no explicit removeGroups", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": ["Sales"] },
    fromManagedGroups: ["Support"],
    removalMode: "full",
  });
  assert.equal(ad.reconcileGroups, true);
  assert.deepEqual(ad.desiredGroups, ["Sales"]);
  assert.deepEqual(ad.removeGroups, []);
});

test("mover add-only: no removals at all", () => {
  const [ad] = computeMoverDiff({
    directorySystems: ["active-directory"],
    targetGroupsBySystem: { "active-directory": ["Sales"] },
    fromManagedGroups: ["Support"],
    removalMode: "add-only",
  });
  assert.deepEqual(ad.add, ["Sales"]);
  assert.deepEqual(ad.removeGroups, []);
  assert.equal(ad.reconcileGroups, false);
});

test("mover: OU move flows to AD only", () => {
  const diffs = computeMoverDiff({
    directorySystems: dirs,
    targetGroupsBySystem: {},
    fromManagedGroups: [],
    targetOuBySystem: { "active-directory": "OU=Sales,DC=x,DC=com" },
    removalMode: "scoped",
  });
  assert.equal(diffs.find((d) => d.systemKey === "active-directory")!.moveToOu, "OU=Sales,DC=x,DC=com");
  assert.equal(diffs.find((d) => d.systemKey === "m365")!.moveToOu, undefined);
});

test("adhoc: group add/remove route to every directory; dl routes to exchange", () => {
  const diffs = deltasToDiff(
    [
      { op: "add", target: "group", value: "Sales" },
      { op: "remove", target: "group", value: "Support" },
      { op: "add", target: "dl", value: "sales@x.com" },
    ],
    ["active-directory", "m365", "exchange"]
  );
  const ad = diffs.find((d) => d.systemKey === "active-directory")!;
  assert.deepEqual(ad.add, ["Sales"]);
  assert.deepEqual(ad.removeGroups, ["Support"]);
  const exo = diffs.find((d) => d.systemKey === "exchange")!;
  assert.deepEqual(exo.namedGroups, ["sales@x.com"]);
});

test("adhoc: system-scoped delta lands only on that system", () => {
  const diffs = deltasToDiff([{ op: "add", target: "group", value: "Sales", system: "m365" }], ["active-directory", "m365"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "m365")!.add, ["Sales"]);
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, []);
});

test("adhoc: protected group is dropped from adds and removes", () => {
  const diffs = deltasToDiff(
    [{ op: "add", target: "group", value: "Enterprise Admins" }, { op: "remove", target: "group", value: "Schema Admins" }],
    ["active-directory"]
  );
  assert.deepEqual(diffs[0].add, []);
  assert.deepEqual(diffs[0].removeGroups, []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx tsx --test lib/cases/change-plan.test.ts`
Expected: FAIL — "Cannot find module './change-plan'" (or export-not-found).

- [ ] **Step 3: Write the diff engine**

Create `web/lib/cases/change-plan.ts` with the diff functions (the planner comes in Task 4, appended to this file):
```ts
import type { ChangeDelta, ChangeDiff, RemovalMode } from "./change-types";
import { isProtectedGroup } from "./change-types";

export function emptyDiff(systemKey: string): ChangeDiff {
  return { systemKey, add: [], removeGroups: [], reconcileGroups: false, desiredGroups: [] };
}

const dedupeCI = (xs: string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
};

const notIn = (xs: string[], others: string[]): string[] => {
  const set = new Set(others.map((o) => o.toLowerCase()));
  return xs.filter((x) => !set.has(x.toLowerCase()));
};

// MOVER: compute per-directory diffs from a target group set + the old role's managed groups.
export function computeMoverDiff(args: {
  directorySystems: string[];
  targetGroupsBySystem: Record<string, string[]>;
  fromManagedGroups: string[];
  targetOuBySystem?: Record<string, string>;
  removalMode: RemovalMode;
}): ChangeDiff[] {
  const { directorySystems, targetGroupsBySystem, fromManagedGroups, targetOuBySystem, removalMode } = args;
  const managed = dedupeCI(fromManagedGroups);
  return directorySystems.map((systemKey) => {
    const d = emptyDiff(systemKey);
    const target = dedupeCI(targetGroupsBySystem[systemKey] ?? []);
    d.add = target;
    d.desiredGroups = target;
    if (removalMode === "full") {
      d.reconcileGroups = true; // runner removes anything live not in desiredGroups (minus protected)
    } else if (removalMode === "scoped") {
      // managed by the old role but not granted by the new role, excluding protected groups
      d.removeGroups = notIn(managed, target).filter((g) => !isProtectedGroup(g));
    }
    const ou = targetOuBySystem?.[systemKey];
    if (systemKey === "active-directory" && ou) d.moveToOu = ou;
    return d;
  });
}

// AD-HOC: map hand-picked deltas onto per-directory diffs.
export function deltasToDiff(deltas: ChangeDelta[], directorySystems: string[]): ChangeDiff[] {
  const byKey = new Map<string, ChangeDiff>(directorySystems.map((k) => [k, emptyDiff(k)]));
  const dirTargets = (system?: string): ChangeDiff[] => {
    if (system) { const d = byKey.get(system); return d ? [d] : []; }
    return [...byKey.values()];
  };
  for (const delta of deltas) {
    const v = delta.value.trim();
    if (!v) continue;
    if ((delta.target === "group") && isProtectedGroup(v)) continue; // never touch privileged groups
    if (delta.target === "group") {
      for (const d of dirTargets(delta.system)) {
        if (delta.op === "add") d.add.push(v); else d.removeGroups.push(v);
      }
    } else if (delta.target === "dl") {
      const exo = byKey.get("exchange"); if (!exo) continue;
      if (delta.op === "add") (exo.namedGroups ??= []).push(v); else (exo.removeNamedGroups ??= []).push(v);
    } else if (delta.target === "sharedMailbox") {
      const exo = byKey.get("exchange"); if (!exo) continue;
      if (delta.op === "add") (exo.addSharedMailboxes ??= []).push(v); else (exo.removeSharedMailboxes ??= []).push(v);
    } else if (delta.target === "license") {
      const m = byKey.get("m365"); if (!m) continue;
      if (delta.op === "add") (m.licenses ??= []).push(v); else (m.removeLicenses ??= []).push(v);
    } else if (delta.target === "ou") {
      const ad = byKey.get("active-directory"); if (ad && delta.op === "add") ad.moveToOu = v;
    } else if (delta.target === "attribute") {
      const [key, ...rest] = v.split("=");
      if (!key || rest.length === 0) continue;
      for (const d of dirTargets(delta.system)) (d.attributes ??= {})[key.trim()] = rest.join("=");
    }
  }
  // normalize list fields
  for (const d of byKey.values()) {
    d.add = dedupeCI(d.add);
    d.removeGroups = dedupeCI(d.removeGroups);
    if (d.namedGroups) d.namedGroups = dedupeCI(d.namedGroups);
    if (d.removeNamedGroups) d.removeNamedGroups = dedupeCI(d.removeNamedGroups);
  }
  return [...byKey.values()];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx tsx --test lib/cases/change-plan.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/cases/change-plan.ts web/lib/cases/change-plan.test.ts
git commit -m "feat(change): diff engine for mover + ad-hoc access deltas"
```

---

## Task 4: The change planner (diffs → PlannedJob[])

**Files:**
- Modify: `web/lib/cases/change-plan.ts` (append the planner)
- Test: `web/lib/cases/change-plan.test.ts` (append planner tests)

**Interfaces:**
- Consumes: `PlannedJob` from `../orchestrator`; `ChangeDiff`, `ChangeJobConfig` from `./change-types`; `resolvePlannedConfigs`, `personaSystemKeys` from `../profiles/plan-resolve`.
- Produces:
  - `type ChangePlanClient = { systems: { systemKey: string; mode: string; secretNames: string[]; requiresApproval: boolean }[]; identity?: unknown; personas?: unknown; globals?: unknown; locations?: unknown }`
  - `targetGroupsForPersona(client, toPersona?, toLocation?): { groups: Record<string,string[]>; ou: Record<string,string> }`
  - `managedGroupsForPersona(client, persona?, location?): string[]`
  - `planChangeJobs(client: ChangePlanClient, diffs: ChangeDiff[]): PlannedJob[]`

- [ ] **Step 1: Write the failing planner tests**

Append to `web/lib/cases/change-plan.test.ts`:
```ts
import { planChangeJobs } from "./change-plan";

const client = {
  systems: [
    { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: false },
    { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
    { systemKey: "directory-sync", mode: "api", secretNames: [], requiresApproval: false },
  ],
};

test("planChangeJobs: one job per directory with changes; config carries the contract", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: ["Support"], reconcileGroups: false, desiredGroups: ["Sales"] },
    { systemKey: "m365", add: [], removeGroups: [], reconcileGroups: false, desiredGroups: [] },
  ]);
  const ad = jobs.find((j) => j.systemKey === "active-directory")!;
  assert.equal((ad.config as { groups: string[] }).groups[0], "Sales");
  assert.equal((ad.config as { removeGroups: string[] }).removeGroups[0], "Support");
  // an empty diff (m365 here) produces no job
  assert.equal(jobs.some((j) => j.systemKey === "m365"), false);
});

test("planChangeJobs: a removal job is approval-gated (destructive)", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: [], removeGroups: ["Support"], reconcileGroups: false, desiredGroups: [] },
  ]);
  const ad = jobs.find((j) => j.systemKey === "active-directory")!;
  assert.equal(ad.requiresApproval, true);
  assert.equal(ad.intent, "destructive");
});

test("planChangeJobs: an add-only job is not approval-gated", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  assert.equal(jobs.find((j) => j.systemKey === "active-directory")!.requiresApproval, false);
});

test("planChangeJobs: injects directory-sync after AD when the client has it, and a trailing case-resolution", () => {
  const jobs = planChangeJobs(client as never, [
    { systemKey: "active-directory", add: ["Sales"], removeGroups: [], reconcileGroups: false, desiredGroups: ["Sales"] },
  ]);
  const keys = jobs.map((j) => j.systemKey);
  assert.ok(keys.includes("directory-sync"));
  assert.equal(keys[keys.length - 1], "case-resolution");
  assert.deepEqual(jobs.find((j) => j.systemKey === "directory-sync")!.dependsOn, ["active-directory"]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx tsx --test lib/cases/change-plan.test.ts`
Expected: FAIL — `planChangeJobs` not exported.

- [ ] **Step 3: Append the planner implementation**

Append to `web/lib/cases/change-plan.ts`:
```ts
import type { PlannedJob, Mode } from "../orchestrator";
import type { ChangeDiff } from "./change-types";
import { resolvePlannedConfigs, personaSystemKeys } from "../profiles/plan-resolve";

export type ChangePlanSystem = { systemKey: string; mode: string; secretNames: string[]; requiresApproval: boolean };
export type ChangePlanClient = {
  systems: ChangePlanSystem[];
  identity?: unknown;
  personas?: unknown;
  globals?: unknown;
  locations?: unknown;
};

const DIR = new Set(["active-directory", "entra", "m365", "exchange", "google-workspace"]);

// Build a target group set per directory by reusing the ONBOARD resolver with a payload that
// encodes the target persona/location. resolvePlannedConfigs writes `groups` (and `ou`) onto each
// directory job's config — exactly the "what should this persona have" computation we need.
export function targetGroupsForPersona(
  client: ChangePlanClient,
  toPersona?: string,
  toLocation?: string
): { groups: Record<string, string[]>; ou: Record<string, string> } {
  const payload: Record<string, unknown> = {};
  if (toPersona) payload.persona = toPersona;
  if (toLocation) payload.location = toLocation;
  const seed: PlannedJob[] = client.systems
    .filter((s) => DIR.has(s.systemKey))
    .map((s, i) => ({ systemKey: s.systemKey, sequence: i, mode: "api" as Mode, requiresApproval: false, captureEvidence: false, intent: null, secretNames: s.secretNames, config: null, dependsOn: [] }));
  const resolved = resolvePlannedConfigs(client as never, payload, "onboard", seed);
  const groups: Record<string, string[]> = {};
  const ou: Record<string, string> = {};
  for (const j of resolved) {
    const cfg = (j.config ?? {}) as { groups?: unknown; ou?: unknown };
    if (Array.isArray(cfg.groups)) groups[j.systemKey] = cfg.groups.map(String);
    if (typeof cfg.ou === "string" && cfg.ou) ou[j.systemKey] = cfg.ou;
  }
  return { groups, ou };
}

// The FROM role's managed groups (the union across every directory of what the old persona granted).
export function managedGroupsForPersona(client: ChangePlanClient, fromPersona?: string, fromLocation?: string): string[] {
  const { groups } = targetGroupsForPersona(client, fromPersona, fromLocation);
  return [...new Set(Object.values(groups).flat())];
}

const hasChange = (d: ChangeDiff): boolean =>
  d.add.length > 0 || d.removeGroups.length > 0 || d.reconcileGroups ||
  Boolean(d.moveToOu) || Boolean(d.attributes && Object.keys(d.attributes).length) ||
  Boolean(d.licenses?.length) || Boolean(d.removeLicenses?.length) ||
  Boolean(d.namedGroups?.length) || Boolean(d.removeNamedGroups?.length) ||
  Boolean(d.addSharedMailboxes?.length) || Boolean(d.removeSharedMailboxes?.length);

const isRemoval = (d: ChangeDiff): boolean =>
  d.removeGroups.length > 0 || d.reconcileGroups || Boolean(d.moveToOu) ||
  Boolean(d.removeLicenses?.length) || Boolean(d.removeNamedGroups?.length) || Boolean(d.removeSharedMailboxes?.length);

// Turn per-directory diffs into a topo-ordered PlannedJob[]. No identity pipeline (that is
// onboard/offboard-specific): a change touches only the systems that actually have a delta.
export function planChangeJobs(client: ChangePlanClient, diffs: ChangeDiff[]): PlannedJob[] {
  const active = new Map(client.systems.map((s) => [s.systemKey, s]));
  const jobs: PlannedJob[] = [];
  let seq = 0;
  for (const d of diffs) {
    if (!hasChange(d)) continue;
    const sys = active.get(d.systemKey);
    if (!sys) continue;
    const removal = isRemoval(d);
    const config = {
      groups: d.add,
      removeGroups: d.removeGroups,
      reconcileGroups: d.reconcileGroups,
      desiredGroups: d.desiredGroups,
      ...(d.moveToOu ? { moveToOu: d.moveToOu } : {}),
      ...(d.attributes ? { attributes: d.attributes } : {}),
      ...(d.licenses ? { licenses: d.licenses } : {}),
      ...(d.removeLicenses ? { removeLicenses: d.removeLicenses } : {}),
      ...(d.namedGroups ? { namedGroups: d.namedGroups } : {}),
      ...(d.removeNamedGroups ? { removeNamedGroups: d.removeNamedGroups } : {}),
      ...(d.addSharedMailboxes ? { addSharedMailboxes: d.addSharedMailboxes } : {}),
      ...(d.removeSharedMailboxes ? { removeSharedMailboxes: d.removeSharedMailboxes } : {}),
    };
    jobs.push({
      systemKey: d.systemKey,
      sequence: seq++,
      mode: (sys.mode as Mode) ?? "api",
      requiresApproval: removal, // removals/OU-move/reconcile are approval-gated
      captureEvidence: removal,
      intent: removal ? "destructive" : "disable",
      secretNames: sys.secretNames,
      config,
      dependsOn: [],
    });
  }
  // A directory-sync step after AD, if the client models it (push on-prem group/OU edits to Entra).
  if (jobs.some((j) => j.systemKey === "active-directory") && active.has("directory-sync")) {
    const ds = active.get("directory-sync")!;
    jobs.push({ systemKey: "directory-sync", sequence: seq++, mode: (ds.mode as Mode) ?? "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: ds.secretNames, config: null, dependsOn: ["active-directory"] });
  }
  // Trailing closing step (mirrors onboard/offboard). Manual — the app writes the SN work note.
  jobs.push({ systemKey: "case-resolution", sequence: seq++, mode: "manual", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], config: null, dependsOn: [] });
  return jobs;
}
```

Note: `Mode` is exported from `@prisma/client`; if `../orchestrator` does not re-export it, import it as `import type { Mode } from "@prisma/client"` instead.

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx tsx --test lib/cases/change-plan.test.ts`
Expected: PASS (all tests, old + new).

- [ ] **Step 5: Commit**

```bash
git add web/lib/cases/change-plan.ts web/lib/cases/change-plan.test.ts
git commit -m "feat(change): change planner — diffs to PlannedJob[] with approval gating + dir-sync"
```

---

## Task 5: Change service (create + confirm) and repo wiring

**Files:**
- Create: `web/lib/cases/change-service.ts`
- Test: `web/lib/cases/change-service.test.ts`

**Interfaces:**
- Consumes: `createCaseWithJobs` from `./repository` (via a `CaseRepository`), `computeMoverDiff`/`deltasToDiff`/`planChangeJobs`/`targetGroupsForPersona`/`managedGroupsForPersona` (Tasks 3–4), `deriveStatus` from `./planning-service`, `resolveActor`/`ActorInput` from `../auth/actor`.
- Produces:
  - `createChangeCase(repo, input: { clientSlug: string; payload: ChangePayload; subject?: string | null; serviceNowCaseNumber?: string | null; dryRun?: boolean; source?: CaseSource }, actor): Promise<PlanOutcome>` — plans with the diff already computed from the payload; a case with no confirmed `removalMode` (mover) is created HELD in `review` so the preview modal can set the mode before dispatch.
  - `confirmChangeCase(repo, caseId, removalMode: RemovalMode, actor): Promise<PlanOutcome>` — recomputes the mover diff with the chosen mode and replaces the case's jobs.

- [ ] **Step 1: Write the failing test (mover create builds jobs; ad-hoc create builds jobs)**

Create `web/lib/cases/change-service.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChangeDiffs } from "./change-service";

const client = {
  systems: [
    { systemKey: "active-directory", mode: "api", secretNames: ["ad-dc"], requiresApproval: false },
    { systemKey: "m365", mode: "api", secretNames: ["m365-admin"], requiresApproval: false },
  ],
  personas: null, globals: null, locations: null,
};

test("buildChangeDiffs: adhoc payload maps deltas onto directory diffs", () => {
  const diffs = buildChangeDiffs(client as never, {
    userToChange: "Jane Doe",
    changeKind: "adhoc",
    deltas: [{ op: "add", target: "group", value: "Sales" }],
  });
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, ["Sales"]);
});

test("buildChangeDiffs: mover with no personas yields empty adds (no target rules), scoped removeGroups empty", () => {
  const diffs = buildChangeDiffs(client as never, {
    userToChange: "Jane Doe",
    changeKind: "mover",
    toPersona: "Sales",
    removalMode: "scoped",
  });
  // no persona rules configured on this bare client → nothing to add or remove
  assert.deepEqual(diffs.find((d) => d.systemKey === "active-directory")!.add, []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd web && npx tsx --test lib/cases/change-service.test.ts`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Write the change service**

Create `web/lib/cases/change-service.ts`:
```ts
import type { CaseSource } from "@prisma/client";
import type { ChangeDiff, ChangePayload, RemovalMode } from "./change-types";
import { DIRECTORY_SYSTEMS } from "./change-types";
import { computeMoverDiff, deltasToDiff, planChangeJobs, targetGroupsForPersona, managedGroupsForPersona, type ChangePlanClient } from "./change-plan";
import { deriveStatus, type PlanOutcome } from "./planning-service";
import type { CaseRepository } from "./repository";
import { resolveActor, type ActorInput } from "../auth/actor";

// Which directory systems are actually active on this client (drives the per-system diffs).
function activeDirectorySystems(client: ChangePlanClient): string[] {
  const present = new Set(client.systems.map((s) => s.systemKey));
  return DIRECTORY_SYSTEMS.filter((k) => present.has(k));
}

export function buildChangeDiffs(client: ChangePlanClient, payload: ChangePayload): ChangeDiff[] {
  const dirs = activeDirectorySystems(client);
  if (payload.changeKind === "adhoc") {
    return deltasToDiff(payload.deltas ?? [], dirs);
  }
  const { groups, ou } = targetGroupsForPersona(client, payload.toPersona, payload.toLocation);
  const fromManaged = managedGroupsForPersona(client, payload.fromPersona, payload.fromLocation);
  return computeMoverDiff({
    directorySystems: dirs,
    targetGroupsBySystem: groups,
    fromManagedGroups: fromManaged,
    targetOuBySystem: ou,
    removalMode: payload.removalMode ?? "scoped",
  });
}

export type CreateChangeInput = {
  clientSlug: string;
  payload: ChangePayload;
  subject?: string | null;
  serviceNowCaseNumber?: string | null;
  dryRun?: boolean;
  source?: CaseSource;
};

export async function createChangeCase(repo: CaseRepository, input: CreateChangeInput, actor: ActorInput): Promise<PlanOutcome> {
  const client = (await repo.clientForPlanning(input.clientSlug)) as unknown as ChangePlanClient & { id: string };
  const diffs = buildChangeDiffs(client, input.payload);
  const planned = planChangeJobs(client, diffs);
  const status = deriveStatus(planned);
  const who = resolveActor(actor);
  const creator = { label: who.actor, userId: who.userId };
  const caseId = await repo.createCaseWithJobs(
    { clientSlug: input.clientSlug, action: "change", subject: input.subject ?? null, serviceNowCaseNumber: input.serviceNowCaseNumber ?? null, payload: input.payload as unknown as Record<string, unknown>, dryRun: input.dryRun ?? false, source: input.source ?? "manual" },
    client.id,
    planned,
    status,
    creator
  );
  await repo.writeAudit({ action: "case.change.create", caseRequestId: caseId, clientId: client.id, user: who, detail: { changeKind: input.payload.changeKind, jobs: planned.length } });
  // A mover with no confirmed removal mode is held for the preview modal to choose scoped/full.
  if (input.payload.changeKind === "mover" && !input.payload.removalMode) {
    await repo.setHold(caseId, "review");
  }
  return { caseId, status, jobCount: planned.filter((p) => p.mode !== "manual").length, manualCount: planned.filter((p) => p.mode === "manual").length, approvalCount: planned.filter((p) => p.requiresApproval).length };
}

export async function confirmChangeCase(repo: CaseRepository, caseId: string, removalMode: RemovalMode, actor: ActorInput): Promise<PlanOutcome> {
  const existing = await repo.caseForReplan(caseId); // { clientId, clientSlug, payload, client: ChangePlanClient }
  const payload = { ...(existing.payload as unknown as ChangePayload), removalMode };
  const diffs = buildChangeDiffs(existing.client as ChangePlanClient, payload);
  const planned = planChangeJobs(existing.client as ChangePlanClient, diffs);
  const status = deriveStatus(planned);
  const who = resolveActor(actor);
  await repo.replaceJobs(caseId, planned, status, { ...payload });
  await repo.clearHold(caseId);
  await repo.writeAudit({ action: "case.change.confirm", caseRequestId: caseId, clientId: existing.clientId, user: who, detail: { removalMode, jobs: planned.length } });
  return { caseId, status, jobCount: planned.filter((p) => p.mode !== "manual").length, manualCount: planned.filter((p) => p.mode === "manual").length, approvalCount: planned.filter((p) => p.requiresApproval).length };
}
```

Note on repo methods: `createCaseWithJobs`, `writeAudit`, `setHold`, `clearHold` already exist on `CaseRepository` (see `repository.ts`). `caseForReplan` and `replaceJobs` are the replan-service pattern — reuse `web/lib/cases/replan-service.ts` if it already exposes an equivalent (check `replan-service.ts` for the exact method names and adapt; if it uses `regenerateJobs(caseId, planned, status)`, call that instead of `replaceJobs`).

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx tsx --test lib/cases/change-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify repo method names**

Run: `cd web && grep -nE "async (createCaseWithJobs|writeAudit|setHold|clearHold|caseForReplan|replaceJobs|regenerateJobs)" lib/cases/repository.ts lib/cases/replan-service.ts`
Expected: confirm the exact names; adjust `change-service.ts` calls to match (rename `replaceJobs`/`caseForReplan` to whatever `replan-service.ts` exposes). Re-run the test after adjusting.

- [ ] **Step 6: Commit**

```bash
git add web/lib/cases/change-service.ts web/lib/cases/change-service.test.ts
git commit -m "feat(change): change service — create (held-for-review) + confirm-with-removal-mode"
```

---

## Task 6: `POST /api/cases/change` — create + plan

**Files:**
- Create: `web/app/api/cases/change/route.ts`

**Interfaces:**
- Consumes: `guard` (`route-guard`), `currentClientScope`/`scopeAllows` (`client-scope`), `makeCaseRepository` (`repository`), `createChangeCase` (Task 5), `auditActor` (`../auth/actor`).

- [ ] **Step 1: Write the route (mirrors `web/app/api/cases/route.ts`)**

Create `web/app/api/cases/change/route.ts`:
```ts
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createChangeCase } from "@/lib/cases/change-service";
import { auditActor } from "@/lib/auth/actor";
import type { ChangePayload } from "@/lib/cases/change-types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const _g = await guard("case.import"); if (_g.res) return _g.res;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : null) as ChangePayload | null;
  if (!clientSlug || !payload || typeof payload.userToChange !== "string" || (payload.changeKind !== "mover" && payload.changeKind !== "adhoc")) {
    return NextResponse.json({ error: "clientSlug and payload{ userToChange, changeKind: mover|adhoc } are required" }, { status: 422 });
  }

  const scope = await currentClientScope(db);
  if (scope !== null) {
    const target = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
    if (!target || !scopeAllows(scope, target.id)) return NextResponse.json({ error: `client not found: ${clientSlug}` }, { status: 404 });
  }

  try {
    const outcome = await createChangeCase(
      makeCaseRepository(db),
      { clientSlug, payload, subject: typeof body.subject === "string" ? body.subject : null, dryRun: body.dryRun === true, source: "manual" },
      auditActor(_g.user, "ui:change-case")
    );
    return NextResponse.json(outcome, { status: 201 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const status = reason.startsWith("client not found") ? 404 : 500;
    return NextResponse.json({ error: reason }, { status });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-test the route compiles under the dev server**

Run (in a scratch worktree dev server per [[web-dev-verify-recipe]]): `curl -sS -X POST localhost:3000/api/cases/change -H 'content-type: application/json' -d '{}'`
Expected: `{"error":"..."}` with 422 (not a 500 / stack trace), proving the route mounts.

- [ ] **Step 4: Commit**

```bash
git add web/app/api/cases/change/route.ts
git commit -m "feat(change): POST /api/cases/change create+plan route"
```

---

## Task 7: `POST /api/cases/[id]/change/confirm` — apply removal mode

**Files:**
- Create: `web/app/api/cases/[id]/change/confirm/route.ts`

**Interfaces:**
- Consumes: `guard`, `caseInScope` (`client-scope`), `confirmChangeCase` (Task 5), `auditActor`.

- [ ] **Step 1: Write the route**

Create `web/app/api/cases/[id]/change/confirm/route.ts`:
```ts
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { caseInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { confirmChangeCase } from "@/lib/cases/change-service";
import { auditActor } from "@/lib/auth/actor";

export const dynamic = "force-dynamic";

const MODES = new Set(["scoped", "full", "add-only"]);

export async function POST(req: Request, { params }: { params: { id: string } }) {
  // Full reconciliation / removals are destructive → require the destructive-approve permission.
  const _g = await guard("case.approve_destructive"); if (_g.res) return _g.res;
  if (!(await caseInScope(db, params.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: { removalMode?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  if (typeof body.removalMode !== "string" || !MODES.has(body.removalMode)) {
    return NextResponse.json({ error: "removalMode must be scoped|full|add-only" }, { status: 422 });
  }
  try {
    const outcome = await confirmChangeCase(makeCaseRepository(db), params.id, body.removalMode as never, auditActor(_g.user, "ui:change-confirm"));
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "web/app/api/cases/[id]/change/confirm/route.ts"
git commit -m "feat(change): confirm route applies removal mode + replans jobs"
```

---

## Task 8: `POST /api/cases/change/bulk` — CSV / multi-user fan-out

**Files:**
- Create: `web/app/api/cases/change/bulk/route.ts`

**Interfaces:**
- Consumes: `guard`, `currentClientScope`/`scopeAllows`, `createChangeCase`, `auditActor`, `recordAudit`.
- Behavior: one transition applied to N users → N `change` cases (keeps the one-user-per-case model). Bounded at `MAX = 100`.

- [ ] **Step 1: Write the route (mirrors `web/app/api/cases/bulk/route.ts`)**

Create `web/app/api/cases/change/bulk/route.ts`:
```ts
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { recordAudit } from "@/lib/auth/audit";
import { db } from "@/lib/db";
import { makeCaseRepository } from "@/lib/cases/repository";
import { createChangeCase } from "@/lib/cases/change-service";
import { auditActor } from "@/lib/auth/actor";
import type { ChangePayload } from "@/lib/cases/change-types";

export const dynamic = "force-dynamic";
const MAX = 100;

export async function POST(req: Request) {
  const _g = await guard("case.import"); if (_g.res) return _g.res;
  let body: { clientSlug?: unknown; users?: unknown; template?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }
  const clientSlug = typeof body.clientSlug === "string" ? body.clientSlug : "";
  const template = (body.template && typeof body.template === "object" ? body.template : null) as Partial<ChangePayload> | null;
  if (!clientSlug || !template || (template.changeKind !== "mover" && template.changeKind !== "adhoc")) {
    return NextResponse.json({ error: "clientSlug and template{ changeKind } are required" }, { status: 422 });
  }
  if (!Array.isArray(body.users) || body.users.some((u) => typeof u !== "string")) {
    return NextResponse.json({ error: "users[] (display names or UPNs) is required" }, { status: 422 });
  }
  const users = [...new Set((body.users as string[]).map((s) => s.trim()).filter(Boolean))].slice(0, MAX);
  if (users.length === 0) return NextResponse.json({ error: "no users given" }, { status: 422 });

  const scope = await currentClientScope(db);
  if (scope !== null) {
    const target = await db.client.findUnique({ where: { slug: clientSlug }, select: { id: true } });
    if (!target || !scopeAllows(scope, target.id)) return NextResponse.json({ error: `client not found: ${clientSlug}` }, { status: 404 });
  }

  const repo = makeCaseRepository(db);
  const results: { user: string; ok: boolean; caseId?: string; error?: string }[] = [];
  for (const user of users) {
    try {
      const outcome = await createChangeCase(repo, { clientSlug, payload: { ...(template as ChangePayload), userToChange: user }, source: "manual" }, auditActor(_g.user, "ui:change-bulk"));
      results.push({ user, ok: true, caseId: outcome.caseId });
    } catch (e) {
      results.push({ user, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const ok = results.filter((r) => r.ok).length;
  await recordAudit("case.change.bulk", { user: _g.user, detail: { clientSlug, requested: users.length, ok } });
  return NextResponse.json({ results, ok, failed: results.length - ok });
}
```

- [ ] **Step 2: Type-check + commit**

Run: `cd web && npx tsc --noEmit` (expected: no errors)
```bash
git add web/app/api/cases/change/bulk/route.ts
git commit -m "feat(change): bulk change route — one transition fanned to N users"
```

---

## Task 9: Runner — add the `change` branch to the job loop

**Files:**
- Modify: `runner/Start-IamRunner.ps1:2939` (lane selection)

**Interfaces:**
- Produces: the job loop selects `$handler.Change` when `$job.action -eq 'change'`, and posts a `skipped` result (manual follow-up) when a system has no `Change` scriptblock.

- [ ] **Step 1: Edit the lane-selection block**

In `runner/Start-IamRunner.ps1`, replace (around line 2939):
```powershell
$fn = if ($job.action -eq 'offboard') { $handler.Offboard } else { $handler.Onboard }
```
with:
```powershell
$fn = switch ($job.action) {
    'offboard' { $handler.Offboard }
    'change'   { if ($handler.ContainsKey('Change')) { $handler.Change } else { $null } }
    default    { $handler.Onboard }
}
```
The existing `if (-not $fn) { ...post skipped... continue }` block immediately below already handles the "no lane" case — a `change` job on a system with no `Change` scriptblock posts `status='skipped'` with "no change lane for <systemKey> — manual follow-up", which surfaces as a manual checklist row.

- [ ] **Step 2: Syntax-check the script**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('runner/Start-IamRunner.ps1', [ref]\$null, [ref]\$null); 'parsed ok'"`
Expected: `parsed ok`.

- [ ] **Step 3: Commit**

```bash
git add runner/Start-IamRunner.ps1
git commit -m "feat(runner): dispatch change action to the Change lane"
```

---

## Task 10: Runner — AD `Invoke-CtgADChange`

**Files:**
- Modify: `runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1` (add the function + export)
- Modify: `runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1` (`FunctionsToExport`)
- Modify: `runner/Start-IamRunner.ps1` (add `Change` to the `active-directory` `$DISPATCH` entry)
- Test: `runner/tests/ADChange.Tests.ps1`

**Interfaces:**
- Produces: `Invoke-CtgADChange -User <pscustomobject> -Config <pscustomobject> -AdConnection <hashtable>` → `[pscustomobject]@{ System='active-directory'; Status='ok'; Actions=@(...) }`. Reads `groups` (add), `removeGroups` (remove by name), `reconcileGroups`+`desiredGroups` (full mode), `moveToOu`, `attributes`.

- [ ] **Step 1: Write the failing Pester test**

Create `runner/tests/ADChange.Tests.ps1`:
```powershell
BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1" -Force
}
Describe 'Invoke-CtgADChange' {
    BeforeEach {
        Mock -CommandName Get-ADUser -ModuleName Coretelligent.ActiveDirectory -MockWith { [pscustomobject]@{ SamAccountName = 'jdoe'; DistinguishedName = 'CN=jdoe,OU=Users,DC=x,DC=com' } }
        Mock -CommandName Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith { }
        Mock -CommandName Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -MockWith { }
    }
    It 'adds groups from config.groups' {
        $u = [pscustomobject]@{ SamAccountName = 'jdoe' }
        $c = [pscustomobject]@{ groups = @('Sales'); removeGroups = @() }
        $r = Invoke-CtgADChange -User $u -Config $c
        Should -Invoke Add-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -Times 1
        $r.Actions -join ';' | Should -Match 'added to group: Sales'
    }
    It 'removes named groups but refuses a protected group' {
        Mock -CommandName Get-ADPrincipalGroupMembership -ModuleName Coretelligent.ActiveDirectory -MockWith { @([pscustomobject]@{ Name = 'Support'; DistinguishedName = 'CN=Support,DC=x,DC=com' }, [pscustomobject]@{ Name = 'Domain Admins'; DistinguishedName = 'CN=Domain Admins,DC=x,DC=com' }) }
        $u = [pscustomobject]@{ SamAccountName = 'jdoe' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @('Support', 'Domain Admins') }
        $r = Invoke-CtgADChange -User $u -Config $c
        Should -Invoke Remove-ADGroupMember -ModuleName Coretelligent.ActiveDirectory -Times 1  # only Support
        $r.Actions -join ';' | Should -Match 'refused protected group: Domain Admins'
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/ADChange.Tests.ps1 -Output Detailed"`
Expected: FAIL — `Invoke-CtgADChange` not recognized.

- [ ] **Step 3: Add the function**

In `Coretelligent.ActiveDirectory.psm1`, add (near `Invoke-CtgADOffboarding`):
```powershell
function Invoke-CtgADChange {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [hashtable]$AdConnection = @{}
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $sam = [string]((Get-CtgProp $User 'SamAccountName') ?? (Get-CtgProp $User 'sam'))
    if (-not $sam) { throw "Invoke-CtgADChange: no SamAccountName on the target user" }

    # ADD
    foreach ($g in @(Get-CtgProp $Config 'groups')) {
        if (-not $g) { continue }
        if (Test-CtgADProtectedGroup -Group $g -Config $Config) { $actions.Add("refused protected group: $g"); continue }
        if ($PSCmdlet.ShouldProcess($sam, "Add to group $g")) {
            try { Add-ADGroupMember -Identity $g -Members $sam -ErrorAction Stop @AdConnection; $actions.Add("added to group: $g") }
            catch {
                if ($_.Exception.Message -match 'already a member') { $actions.Add("already in group: $g") }
                else {
                    $resolved = Resolve-CtgAdGroup -Name $g -AdConnection $AdConnection
                    if ($resolved) { Add-ADGroupMember -Identity $resolved.DistinguishedName -Members $sam -ErrorAction Stop @AdConnection; $actions.Add("added to group: $g") }
                    else { $actions.Add("group not found: $g") }
                }
            }
        }
    }

    # REMOVE by name (scoped)
    $removeNames = @(Get-CtgProp $Config 'removeGroups' | Where-Object { $_ })
    $reconcile = (Get-CtgProp $Config 'reconcileGroups') -eq $true
    if ($removeNames.Count -or $reconcile) {
        $memberships = @(Get-ADPrincipalGroupMembership -Identity $sam -ErrorAction SilentlyContinue @AdConnection)
        $desired = @(Get-CtgProp $Config 'desiredGroups' | ForEach-Object { "$_".ToLower() })
        foreach ($g in $memberships) {
            $name = [string]$g.Name
            if ($name -ieq 'Domain Users') { continue }
            if (Test-CtgADProtectedGroup -Group $name -Config $Config) {
                if ($removeNames | Where-Object { $_ -ieq $name }) { $actions.Add("refused protected group: $name") }
                continue
            }
            $shouldRemove = if ($reconcile) { -not ($desired -contains $name.ToLower()) } else { [bool]($removeNames | Where-Object { $_ -ieq $name }) }
            if (-not $shouldRemove) { continue }
            $gid = if ($g.DistinguishedName) { $g.DistinguishedName } else { $g.Name }
            if ($PSCmdlet.ShouldProcess($sam, "Remove from group $name")) {
                Remove-ADGroupMember -Identity $gid -Members $sam -Confirm:$false -ErrorAction SilentlyContinue @AdConnection
                $actions.Add("removed from group: $name")
            }
        }
        # names listed for removal the user isn't in
        foreach ($n in $removeNames) { if (-not ($memberships.Name -contains $n)) { $actions.Add("not a member of $n (skip)") } }
    }

    # OU move
    $targetOu = Get-CtgProp $Config 'moveToOu'
    if ($targetOu) {
        if ("$targetOu" -notmatch '(?i)dc=') { $actions.Add("skipped move: '$targetOu' is not a full OU DN") }
        else {
            $existing = Get-ADUser -Identity $sam -ErrorAction Stop @AdConnection
            if ($PSCmdlet.ShouldProcess($sam, "Move to $targetOu")) { Move-ADObject -Identity $existing.DistinguishedName -TargetPath $targetOu @AdConnection; $actions.Add("moved to $targetOu") }
        }
    }

    # Attributes
    $attrs = Get-CtgProp $Config 'attributes'
    if ($attrs) { foreach ($a in Set-CtgADAttributes -Sam $sam -Attributes $attrs -AdConnection $AdConnection) { $actions.Add($a) } }

    [pscustomobject]@{ System = 'active-directory'; Status = 'ok'; Actions = @($actions) }
}
```
Note: `Set-CtgADAttributes` is already exported by this module (AD `.psd1:13`). If its parameter names differ (`-Sam`/`-Attributes`/`-AdConnection`), adjust the call to match its actual signature (grep the function header).

- [ ] **Step 4: Export the function (both places)**

In `Coretelligent.ActiveDirectory.psm1`, add `'Invoke-CtgADChange'` to the trailing `Export-ModuleMember -Function` list. In `Coretelligent.ActiveDirectory.psd1`, add `'Invoke-CtgADChange'` to `FunctionsToExport`.

- [ ] **Step 5: Wire the `$DISPATCH` entry**

In `runner/Start-IamRunner.ps1`, in the `'active-directory'` entry, add a `Change` scriptblock:
```powershell
        Change   = { param($job, $creds) Invoke-CtgADChange -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
```

- [ ] **Step 6: Run the test to verify pass**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/ADChange.Tests.ps1 -Output Detailed"`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add runner/modules/Coretelligent.ActiveDirectory runner/Start-IamRunner.ps1 runner/tests/ADChange.Tests.ps1
git commit -m "feat(runner): AD change lane — add/remove groups, reconcile, OU move, attributes"
```

---

## Task 11: Runner — M365 `Invoke-CtgM365Change`

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (+ export)
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psd1`
- Modify: `runner/Start-IamRunner.ps1` (`m365` `$DISPATCH` `Change`; `entra` aliases it in Task 14)
- Test: `runner/tests/M365Change.Tests.ps1`

**Interfaces:**
- Produces: `Invoke-CtgM365Change -User <pscustomobject> -Config <pscustomobject>` → `[pscustomobject]@{ System='m365'; Status='ok'; Actions=@(...) }`. Reads `groups` (add by name→id), `removeGroups` (remove by name→id), `reconcileGroups`+`desiredGroups`, `licenses`/`removeLicenses`. Cloud/dynamic/on-prem group nuances honored (on-prem-mastered groups are the AD lane's job; skip them here).

- [ ] **Step 1: Write the failing Pester test**

Create `runner/tests/M365Change.Tests.ps1`:
```powershell
BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psd1" -Force }
Describe 'Invoke-CtgM365Change' {
    BeforeEach {
        Mock -CommandName Resolve-CtgM365Upn -ModuleName Coretelligent.M365 -MockWith { [pscustomobject]@{ Id = 'user-guid'; UserPrincipalName = 'jdoe@x.com' } }
        Mock -CommandName Resolve-CtgEntraGroupId -ModuleName Coretelligent.M365 -MockWith { param($NameOrId) @{ Id = "grp-$NameOrId"; Error = $null } }
        Mock -CommandName Add-CtgGroupMember -ModuleName Coretelligent.M365 -MockWith { $null }
        Mock -CommandName Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -MockWith { }
    }
    It 'adds groups by name via resolve+Add-CtgGroupMember' {
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @('Sales'); removeGroups = @() }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Add-CtgGroupMember -ModuleName Coretelligent.M365 -Times 1
        $r.Actions -join ';' | Should -Match 'added to group: Sales'
    }
    It 'removes a named group via resolve+Remove-MgGroupMemberByRef' {
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }
        $c = [pscustomobject]@{ groups = @(); removeGroups = @('Support') }
        $r = Invoke-CtgM365Change -User $u -Config $c
        Should -Invoke Remove-MgGroupMemberByRef -ModuleName Coretelligent.M365 -Times 1
        $r.Actions -join ';' | Should -Match 'removed from group: Support'
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/M365Change.Tests.ps1 -Output Detailed"`
Expected: FAIL — function not recognized.

- [ ] **Step 3: Add the function**

In `Coretelligent.M365.psm1`, add:
```powershell
function Invoke-CtgM365Change {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $resolved = Resolve-CtgM365Upn -User $User
    if (-not $resolved -or -not $resolved.Id) { throw "Invoke-CtgM365Change: could not resolve the target user in Entra" }
    $userId = $resolved.Id

    foreach ($g in @(Get-CtgProp $Config 'groups')) {
        if (-not $g) { continue }
        $gid = Resolve-CtgEntraGroupId -NameOrId $g
        if ($gid.Error -or -not $gid.Id) { $actions.Add("group not found: $g"); continue }
        if ($PSCmdlet.ShouldProcess($resolved.UserPrincipalName, "Add to group $g")) {
            $err = Add-CtgGroupMember -GroupId $gid.Id -UserId $userId
            if ($err) { $actions.Add("add group $g failed: $err") } else { $actions.Add("added to group: $g") }
        }
    }

    $removeNames = @(Get-CtgProp $Config 'removeGroups' | Where-Object { $_ })
    foreach ($g in $removeNames) {
        $gid = Resolve-CtgEntraGroupId -NameOrId $g
        if ($gid.Error -or -not $gid.Id) { $actions.Add("group not found: $g"); continue }
        if ($PSCmdlet.ShouldProcess($resolved.UserPrincipalName, "Remove from group $g")) {
            try { Remove-MgGroupMemberByRef -GroupId $gid.Id -DirectoryObjectId $userId -ErrorAction Stop; $actions.Add("removed from group: $g") }
            catch { if ($_.Exception.Message -match 'does not exist|NotFound|Resource') { $actions.Add("not a member of $g (skip)") } else { $actions.Add("remove group $g failed: $($_.Exception.Message)") } }
        }
    }

    # Licenses: add via config.licenses, remove via config.removeLicenses (skuId or name)
    foreach ($l in @(Get-CtgProp $Config 'licenses')) {
        if (-not $l) { continue }
        $spec = [pscustomobject]@{ skuId = [string]$l }
        if ($PSCmdlet.ShouldProcess($resolved.UserPrincipalName, "Add license $l")) {
            foreach ($a in (Set-CtgSeatAwareLicense -UserId $userId -Config $spec).Actions) { $actions.Add($a) }
        }
    }
    foreach ($l in @(Get-CtgProp $Config 'removeLicenses')) {
        if (-not $l) { continue }
        $sku = Resolve-CtgSkuId -Name ([string]$l)
        if ($sku -and $PSCmdlet.ShouldProcess($resolved.UserPrincipalName, "Remove license $l")) {
            Set-MgUserLicense -UserId $userId -AddLicenses @() -RemoveLicenses @($sku) -ErrorAction SilentlyContinue | Out-Null
            $actions.Add("removed license: $l")
        }
    }

    [pscustomobject]@{ System = 'm365'; Status = 'ok'; Actions = @($actions) }
}
```
Note: `Resolve-CtgM365Upn`, `Resolve-CtgEntraGroupId`, `Add-CtgGroupMember`, `Set-CtgSeatAwareLicense`, `Resolve-CtgSkuId` are already defined in this module. If `Set-CtgSeatAwareLicense`'s config shape differs from `{ skuId }`, pass the real field it expects (its header reads `Config.skuId` per the runner reference) — verify with `grep -n "Get-CtgProp \$Config" Coretelligent.M365.psm1` around line 344.

- [ ] **Step 4: Export (both places) + wire `$DISPATCH`**

Add `'Invoke-CtgM365Change'` to the `.psm1` `Export-ModuleMember` list and the `.psd1` `FunctionsToExport`. In `Start-IamRunner.ps1`, add to the `'m365'` entry:
```powershell
        Change   = { param($job, $creds) Invoke-CtgM365Change -User $job.payload -Config $job.config }
```

- [ ] **Step 5: Run to verify pass**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/M365Change.Tests.ps1 -Output Detailed"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.M365 runner/Start-IamRunner.ps1 runner/tests/M365Change.Tests.ps1
git commit -m "feat(runner): M365 change lane — add/remove Entra groups + licenses by name"
```

---

## Task 12: Runner — Exchange `Invoke-CtgExchangeChange`

**Files:**
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` (+ export)
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1`
- Modify: `runner/Start-IamRunner.ps1` (`exchange` `$DISPATCH` `Change`)
- Test: `runner/tests/ExchangeChange.Tests.ps1`

**Interfaces:**
- Produces: `Invoke-CtgExchangeChange -User <pscustomobject> -Config <pscustomobject>` → `[pscustomobject]@{ System='exchange'; Status='ok'; Actions=@(...) }`. Reads `namedGroups` (add DL/365-group — reuse `Invoke-CtgExchangeNamedGroups`), `removeNamedGroups` (NEW — remove by name), `addSharedMailboxes`/`removeSharedMailboxes` (NEW — Add/Remove-MailboxPermission FullAccess).

- [ ] **Step 1: Write the failing Pester test**

Create `runner/tests/ExchangeChange.Tests.ps1`:
```powershell
BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force }
Describe 'Invoke-CtgExchangeChange' {
    BeforeEach {
        Mock -CommandName Invoke-CtgExchangeNamedGroups -ModuleName Coretelligent.Exchange -MockWith { param($NewUser, $Groups) @($Groups | ForEach-Object { "added to group: $_" }) }
        Mock -CommandName Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientType = 'MailUniversalDistributionGroup'; Identity = $Identity } }
        Mock -CommandName Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        Mock -CommandName Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock -CommandName Remove-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
    }
    It 'adds named groups via the existing helper' {
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ namedGroups = @('sales@x.com') })
        $r.Actions -join ';' | Should -Match 'added to group: sales@x.com'
    }
    It 'removes a named distribution list' {
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeNamedGroups = @('sales@x.com') })
        Should -Invoke Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 1
        $r.Actions -join ';' | Should -Match 'removed from distribution list: sales@x.com'
    }
    It 'grants and revokes shared-mailbox FullAccess' {
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ addSharedMailboxes = @('team@x.com'); removeSharedMailboxes = @('old@x.com') })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1
        Should -Invoke Remove-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/ExchangeChange.Tests.ps1 -Output Detailed"`
Expected: FAIL — function not recognized.

- [ ] **Step 3: Add the function**

In `Coretelligent.Exchange.psm1`, add:
```powershell
function Invoke-CtgExchangeChange {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $upn = [string]((Get-CtgProp $User 'UserPrincipalName') ?? (Get-CtgProp $User 'PrimarySmtpAddress') ?? (Get-CtgProp $User 'email'))
    if (-not $upn) { throw "Invoke-CtgExchangeChange: no UPN/PrimarySmtpAddress on the target user" }

    # ADD DL / 365-group by name (reuse the onboard helper)
    $addNamed = @(Get-CtgProp $Config 'namedGroups' | Where-Object { $_ })
    if ($addNamed.Count) { foreach ($a in (Invoke-CtgExchangeNamedGroups -NewUser $upn -Groups $addNamed)) { $actions.Add($a) } }

    # REMOVE DL / 365-group by name (new)
    foreach ($g in @(Get-CtgProp $Config 'removeNamedGroups' | Where-Object { $_ })) {
        $r = Get-Recipient -Identity $g -ErrorAction SilentlyContinue
        if (-not $r) { $actions.Add("group not found: $g"); continue }
        if ("$($r.RecipientType)" -match 'GroupMailbox|UnifiedGroup') {
            if ($PSCmdlet.ShouldProcess($g, "Remove $upn from 365 group")) {
                Remove-UnifiedGroupLinks -Identity $r.Identity -LinkType Members -Links $upn -Confirm:$false -ErrorAction SilentlyContinue
                $actions.Add("removed from 365 group: $g")
            }
        } else {
            if ($PSCmdlet.ShouldProcess($g, "Remove $upn from distribution list")) {
                Remove-DistributionGroupMember -Identity $r.Identity -Member $upn -BypassSecurityGroupManagerCheck -Confirm:$false -ErrorAction SilentlyContinue
                $actions.Add("removed from distribution list: $g")
            }
        }
    }

    # Shared-mailbox FullAccess grant / revoke (new)
    foreach ($mbx in @(Get-CtgProp $Config 'addSharedMailboxes' | Where-Object { $_ })) {
        if ($PSCmdlet.ShouldProcess($mbx, "Grant $upn FullAccess")) {
            Add-MailboxPermission -Identity $mbx -User $upn -AccessRights FullAccess -InheritanceType All -AutoMapping $true -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
            $actions.Add("granted FullAccess on: $mbx")
        }
    }
    foreach ($mbx in @(Get-CtgProp $Config 'removeSharedMailboxes' | Where-Object { $_ })) {
        if ($PSCmdlet.ShouldProcess($mbx, "Revoke $upn FullAccess")) {
            Remove-MailboxPermission -Identity $mbx -User $upn -AccessRights FullAccess -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
            $actions.Add("revoked FullAccess on: $mbx")
        }
    }

    [pscustomobject]@{ System = 'exchange'; Status = 'ok'; Actions = @($actions) }
}
```

- [ ] **Step 4: Export (both places) + wire `$DISPATCH`**

Add `'Invoke-CtgExchangeChange'` to the `.psm1` `Export-ModuleMember` and the `.psd1` `FunctionsToExport`. In `Start-IamRunner.ps1`, in the `'exchange'` entry add (it reuses the entry's existing `Connect`):
```powershell
        Change   = { param($job, $creds) Invoke-CtgExchangeChange -User $job.payload -Config $job.config }
```

- [ ] **Step 5: Run to verify pass**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/ExchangeChange.Tests.ps1 -Output Detailed"`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.Exchange runner/Start-IamRunner.ps1 runner/tests/ExchangeChange.Tests.ps1
git commit -m "feat(runner): Exchange change lane — DL/365-group add+remove + shared-mailbox grant/revoke"
```

---

## Task 13: Runner — Google `Invoke-CtgGoogleChange`

**Files:**
- Modify: `runner/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1` (+ export)
- Modify: the module `.psd1`
- Modify: `runner/Start-IamRunner.ps1` (`google-workspace` `$DISPATCH` `Change`)
- Test: `runner/tests/GoogleChange.Tests.ps1`

**Interfaces:**
- Produces: `Invoke-CtgGoogleChange -User <pscustomobject> -Config <pscustomobject>` → `[pscustomobject]@{ System='google-workspace'; Status='ok'; Actions=@(...) }`. Reads `groups` (add), `removeGroups` (remove by name), `reconcileGroups`+`desiredGroups`.

- [ ] **Step 1: Write the failing Pester test**

Create `runner/tests/GoogleChange.Tests.ps1`:
```powershell
BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psd1" -Force }
Describe 'Invoke-CtgGoogleChange' {
    BeforeEach {
        Mock -CommandName Get-CtgGoogleUserGroups -ModuleName Coretelligent.GoogleWorkspace -MockWith { @('existing@x.com') }
        Mock -CommandName Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { $null }
    }
    It 'adds a new group and skips an existing one' {
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @('sales@x.com','existing@x.com'); removeGroups = @() })
        $r.Actions -join ';' | Should -Match 'added to group: sales@x.com'
        $r.Actions -join ';' | Should -Match 'already in group: existing@x.com'
    }
    It 'removes a named group the user is in' {
        $r = Invoke-CtgGoogleChange -User ([pscustomobject]@{ email = 'jdoe@x.com' }) -Config ([pscustomobject]@{ groups = @(); removeGroups = @('existing@x.com') })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' } -Times 1
        $r.Actions -join ';' | Should -Match 'removed from group: existing@x.com'
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/GoogleChange.Tests.ps1 -Output Detailed"`
Expected: FAIL — function not recognized.

- [ ] **Step 3: Add the function**

In `Coretelligent.GoogleWorkspace.psm1`, add:
```powershell
function Invoke-CtgGoogleChange {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = [string]((Get-CtgProp $User 'email') ?? (Get-CtgProp $User 'PrimaryEmail') ?? (Get-CtgProp $User 'UserPrincipalName'))
    if (-not $email) { throw "Invoke-CtgGoogleChange: no email on the target user" }
    $current = @(Get-CtgGoogleUserGroups -Email $email)

    foreach ($g in @(Get-CtgProp $Config 'groups')) {
        if (-not $g) { continue }
        if ($current -contains $g) { $actions.Add("already in group: $g"); continue }
        if ($PSCmdlet.ShouldProcess($email, "Add to group $g")) {
            Invoke-CtgGoogleApi -Method POST -Path "/groups/$g/members" -Body @{ email = $email; role = 'MEMBER' } | Out-Null
            $actions.Add("added to group: $g")
        }
    }

    $removeNames = @(Get-CtgProp $Config 'removeGroups' | Where-Object { $_ })
    $reconcile = (Get-CtgProp $Config 'reconcileGroups') -eq $true
    $desired = @(Get-CtgProp $Config 'desiredGroups' | ForEach-Object { "$_".ToLower() })
    $toRemove = if ($reconcile) { @($current | Where-Object { $desired -notcontains "$_".ToLower() }) } else { @($removeNames | Where-Object { $current -contains $_ }) }
    foreach ($g in $toRemove) {
        if ($PSCmdlet.ShouldProcess($email, "Remove from group $g")) {
            Invoke-CtgGoogleApi -Method DELETE -Path "/groups/$g/members/$email" | Out-Null
            $actions.Add("removed from group: $g")
        }
    }

    [pscustomobject]@{ System = 'google-workspace'; Status = 'ok'; Actions = @($actions) }
}
```

- [ ] **Step 4: Export (both places) + wire `$DISPATCH`**

Add `'Invoke-CtgGoogleChange'` to the `.psm1` `Export-ModuleMember` and the `.psd1` `FunctionsToExport`. In `Start-IamRunner.ps1`, add a `google-workspace` `Change` scriptblock (mirroring its Onboard entry's `Connect`):
```powershell
        Change   = { param($job, $creds) Invoke-CtgGoogleChange -User $job.payload -Config $job.config }
```

- [ ] **Step 5: Run to verify pass**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/GoogleChange.Tests.ps1 -Output Detailed"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.GoogleWorkspace runner/Start-IamRunner.ps1 runner/tests/GoogleChange.Tests.ps1
git commit -m "feat(runner): Google change lane — add/remove/reconcile group membership"
```

---

## Task 14: Runner — dir-sync trigger, `entra` alias, VERSION + catalog

**Files:**
- Modify: `runner/Start-IamRunner.ps1` (`directory-sync` already dispatches; ensure `entra` aliases `m365`'s `Change`; wire the `directory-sync` change path)
- Modify: `runner/VERSION`
- Modify: `web/lib/generator/system-map.ts` (optional `supportsChange` catalog flag, if present)

**Interfaces:**
- Produces: `entra` change jobs run the same M365 change lane; the `directory-sync` job (injected by `planChangeJobs`) triggers a delta sync after AD edits; `runner/VERSION` bumped.

- [ ] **Step 1: Alias entra + give directory-sync a Change lane**

In `runner/Start-IamRunner.ps1`, after the `$DISPATCH['entra'] = $DISPATCH['m365']` line (≈1402), the alias already carries the new `Change` scriptblock. For `directory-sync`, add a `Change` to its entry that reuses its onboard sync trigger:
```powershell
        Change   = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config -Credential (Get-CtgAdDcCredential $creds) }
```
(If `directory-sync`'s `$DISPATCH` entry defines `Onboard`/`Offboard` as the same `Invoke-CtgDirectorySync` call, add the identical `Change` line so a change case can trigger a sync.)

- [ ] **Step 2: Bump the runner version**

Read `runner/VERSION`, then increment the MINOR component (e.g. `1.73.0` → `1.74.0`). Per [[runner-version-policy]] a new compatible lane is a minor bump.

- [ ] **Step 3: (If the catalog models capabilities) add `supportsChange`**

Run: `cd web && grep -n "supportsOnboard\|supportsOffboard" lib/generator/system-map.ts`
If those flags exist per-system, add `supportsChange: true` to `active-directory`, `entra`, `m365`, `exchange`, `google-workspace` and `false`/omit elsewhere. If no such per-system flags exist, skip this step (the runner's "no Change lane → skipped/manual" fallback already handles unsupported systems).

- [ ] **Step 4: Syntax-check + parse**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "[void][System.Management.Automation.Language.Parser]::ParseFile('runner/Start-IamRunner.ps1', [ref]\$null, [ref]\$null); 'parsed ok'"`
Expected: `parsed ok`.

- [ ] **Step 5: Commit**

```bash
git add runner/Start-IamRunner.ps1 runner/VERSION web/lib/generator/system-map.ts
git commit -m "feat(runner): entra change alias + directory-sync change trigger + version bump"
```

---

## Task 15: UI — change-case dialog

**Files:**
- Create: `web/app/clients/_components/change-case-dialog.tsx`

**Interfaces:**
- Consumes: `GroupMultiselect` (`./group-multiselect`), `OuTreePicker` (`./ad-pickers`).
- Props: `{ slug: string; personas: string[]; locations: string[]; knownGroups: { name: string; type?: string }[]; ous: string[] }`.
- Behavior: pick user; toggle mover (from/to persona+location) vs ad-hoc (add/remove group picks, OU, DL); POST `/api/cases/change`; on success `router.push('/cases/' + caseId)`.

- [ ] **Step 1: Write the component (follows `add-client-dialog.tsx`)**

Create `web/app/clients/_components/change-case-dialog.tsx`:
```tsx
"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { GroupMultiselect } from "./group-multiselect";

type Props = { slug: string; personas: string[]; locations: string[]; knownGroups: { name: string; type?: string }[]; ous: string[] };

export function ChangeCaseDialog({ slug, personas, locations, knownGroups }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [kind, setKind] = useState<"mover" | "adhoc">("mover");
  const [user, setUser] = useState("");
  const [fromPersona, setFromPersona] = useState("");
  const [toPersona, setToPersona] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [addGroups, setAddGroups] = useState<string[]>([]);
  const [removeGroups, setRemoveGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sections = [{ label: "Known groups", options: knownGroups.map((g) => g.name) }];

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(null);
    const payload =
      kind === "mover"
        ? { userToChange: user, changeKind: "mover", fromPersona: fromPersona || undefined, toPersona: toPersona || undefined, toLocation: toLocation || undefined }
        : { userToChange: user, changeKind: "adhoc", deltas: [
            ...addGroups.map((g) => ({ op: "add", target: "group", value: g })),
            ...removeGroups.map((g) => ({ op: "remove", target: "group", value: g })),
          ] };
    try {
      const res = await fetch("/api/cases/change", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientSlug: slug, payload }) });
      const data = await res.json();
      if (res.ok) { ref.current?.close(); router.push(`/cases/${data.caseId}`); }
      else setError(data.error ?? res.statusText);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button className="btn" onClick={() => ref.current?.showModal()}>Change / move user</button>
      <dialog ref={ref} onClose={() => { setError(null); setBusy(false); }}>
        <form onSubmit={submit} style={{ minWidth: 420, display: "grid", gap: 12 }}>
          <h3>Change / move a user</h3>
          <label>User (name or UPN)<input value={user} onChange={(e) => setUser(e.target.value)} required /></label>
          <div role="tablist" style={{ display: "flex", gap: 8 }}>
            <button type="button" aria-pressed={kind === "mover"} onClick={() => setKind("mover")}>Mover (persona/location)</button>
            <button type="button" aria-pressed={kind === "adhoc"} onClick={() => setKind("adhoc")}>Ad-hoc access</button>
          </div>
          {kind === "mover" ? (
            <>
              <label>From persona<select value={fromPersona} onChange={(e) => setFromPersona(e.target.value)}><option value="">(unknown)</option>{personas.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>To persona<select value={toPersona} onChange={(e) => setToPersona(e.target.value)}><option value="">(none)</option>{personas.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>To location<select value={toLocation} onChange={(e) => setToLocation(e.target.value)}><option value="">(none)</option>{locations.map((l) => <option key={l}>{l}</option>)}</select></label>
              <p className="note">You&apos;ll choose scoped vs full removal on the next screen (the preview).</p>
            </>
          ) : (
            <>
              <div>Add to groups<GroupMultiselect sections={sections} value={addGroups} onChange={setAddGroups} /></div>
              <div>Remove from groups<GroupMultiselect sections={sections} value={removeGroups} onChange={setRemoveGroups} /></div>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={() => ref.current?.close()}>Cancel</button>
            <button type="submit" disabled={busy || !user}>{busy ? "Creating…" : "Create change case"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/app/clients/_components/change-case-dialog.tsx
git commit -m "feat(change-ui): change-case dialog (mover + ad-hoc)"
```

---

## Task 16: UI — change preview modal (scoped / full / add-only)

**Files:**
- Create: `web/app/cases/_components/change-preview.tsx`

**Interfaces:**
- Props: `{ caseId: string; diffs: { systemKey: string; add: string[]; removeGroups: string[] }[] }` (the server passes the rule-derived diff for display).
- Behavior: shows adds (green) / scoped-removes (red) per system + a scoped/full/add-only radio; POST `/api/cases/[id]/change/confirm` with the chosen `removalMode`; on success `router.refresh()`.

- [ ] **Step 1: Write the component**

Create `web/app/cases/_components/change-preview.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Diff = { systemKey: string; add: string[]; removeGroups: string[] };
type Props = { caseId: string; diffs: Diff[] };

export function ChangePreview({ caseId, diffs }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<"scoped" | "full" | "add-only">("scoped");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/change/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ removalMode: mode }) });
      const data = await res.json();
      if (res.ok) router.refresh(); else setError(data.error ?? res.statusText);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <h3>Review the change</h3>
      {diffs.map((d) => (
        <div key={d.systemKey}>
          <strong>{d.systemKey}</strong>
          <ul>
            {d.add.map((g) => <li key={`a-${g}`} style={{ color: "green" }}>+ add {g}</li>)}
            {mode !== "add-only" && d.removeGroups.map((g) => <li key={`r-${g}`} style={{ color: "crimson" }}>− remove {g}</li>)}
            {mode === "full" && <li className="note">+ full reconciliation: any group not required by the new role will also be removed at run time (protected groups excluded).</li>}
          </ul>
        </div>
      ))}
      <fieldset>
        <legend>Removal scope</legend>
        <label><input type="radio" name="mode" checked={mode === "scoped"} onChange={() => setMode("scoped")} /> Scoped — only groups the old role managed</label>
        <label><input type="radio" name="mode" checked={mode === "full"} onChange={() => setMode("full")} /> Full reconciliation — remove anything not in the new role</label>
        <label><input type="radio" name="mode" checked={mode === "add-only"} onChange={() => setMode("add-only")} /> Add only — never remove</label>
      </fieldset>
      {error && <p className="error">{error}</p>}
      <button onClick={confirm} disabled={busy}>{busy ? "Applying…" : "Confirm & plan"}</button>
    </section>
  );
}
```

- [ ] **Step 2: Type-check + commit**

Run: `cd web && npx tsc --noEmit` (expected: no errors)
```bash
git add web/app/cases/_components/change-preview.tsx
git commit -m "feat(change-ui): preview modal with scoped/full/add-only removal choice"
```

---

## Task 17: UI — entry points + case-page wiring

**Files:**
- Modify: `web/app/clients/[slug]/page.tsx` (render `ChangeCaseDialog`; pass personas/locations/knownGroups/ous from the existing loader)
- Modify: `web/app/cases/[id]/page.tsx` (render `ChangePreview` for a `change` case still held in `review`)

**Interfaces:**
- Consumes: `ChangeCaseDialog` (Task 15), `ChangePreview` (Task 16), the client detail loader's existing persona/location/cloudGroups/adObjects data, and `buildChangeDiffs` (Task 5) to compute the preview diff server-side.

- [ ] **Step 1: Add the dialog to the client page**

In `web/app/clients/[slug]/page.tsx`, near the existing "Guided setup" / action buttons (`clients/[slug]/page.tsx:288` region), render:
```tsx
<ChangeCaseDialog
  slug={client.slug}
  personas={personaNames}
  locations={locationNames}
  knownGroups={(client.cloudGroups?.groups ?? []).map((g: { name: string; type?: string }) => ({ name: g.name, type: g.type }))}
  ous={client.adObjects ?? []}
/>
```
Derive `personaNames`/`locationNames` from the client's `personas`/`locations` plan blocks already loaded by the page's `_lib/loader.ts` (add them to the loader's `select` if not present — follow [[v2-page-loader-drift]]: put page-data changes in `_lib/loader.ts`, not inline).

- [ ] **Step 2: Add the preview to the case page**

In `web/app/cases/[id]/page.tsx`, when `caseRow.action === "change"` and the case is held (`pausedReason === "review"`), compute and render the preview:
```tsx
{caseRow.action === "change" && caseRow.pausedReason === "review" && (
  <ChangePreview caseId={caseRow.id} diffs={changePreviewDiffs} />
)}
```
Compute `changePreviewDiffs` in the page's loader by calling `buildChangeDiffs(client, caseRow.payload as ChangePayload)` and projecting to `{ systemKey, add, removeGroups }`. For a non-`change` case render nothing extra (the existing `RunReportView` is unchanged).

- [ ] **Step 3: Type-check + build the affected routes**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (Do NOT run `next build` while a dev server is live — see [[nextjs-build-vs-dev-gotcha]].)

- [ ] **Step 4: Commit**

```bash
git add "web/app/clients/[slug]/page.tsx" "web/app/clients/[slug]/_lib/loader.ts" "web/app/cases/[id]/page.tsx"
git commit -m "feat(change-ui): entry points on client page + preview on the change case page"
```

---

## Task 18: Changelog + full-suite verification

**Files:**
- Create: `web/lib/changelog/entries/change-mover-case.ts` (+ register in `_registry.ts`)

**Interfaces:**
- Consumes: the changelog entry shape used by sibling files in `web/lib/changelog/entries/`.

- [ ] **Step 1: Write the changelog entry**

Inspect a sibling for the exact shape: `cd web && ls lib/changelog/entries | head` then read one (e.g. `cat lib/changelog/entries/guided-setup-test-then-write.ts`). Create `web/lib/changelog/entries/change-mover-case.ts` following that shape exactly, with a NEW id (sorted) and `time` set to `TZ=America/New_York date +%H:%M` rounded to a 15-min boundary (see [[changelog-times-eastern]]). Register it in `web/lib/changelog/entries/_registry.ts` (id-sorted).

Entry body: "Movers & ad-hoc access: new `change` case adds/removes an existing user's groups, DLs, shared mailboxes, licences and OU — as a computed persona/location transition or hand-picked deltas — with a scoped/full/add-only removal choice. Runner 1.74.0 + the change-action migration need deploy."

- [ ] **Step 2: Run the full web test suite**

Run: `cd web && npx tsx --test "lib/**/*.test.ts"`
Expected: all tests pass, including the new `change-plan`/`change-service` files.

- [ ] **Step 3: Run the runner Pester suite**

Run: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests -Output Detailed"`
Expected: all pass, including the four new `*Change.Tests.ps1`.

- [ ] **Step 4: End-to-end (isolated dev DB)**

Per [[web-dev-verify-recipe]]: start a worktree dev server against an ISOLATED database (apply `20260718120000_change_action` there — never the shared DB, [[db-reset-incident-2026-07-13]]), mint a DB session + `site_v2` cookie. Create a mover change case for a test user on a v2.1 client (e.g. `six-one`), confirm the preview lists correct adds/scoped-removes, toggle scoped→full, confirm, and verify: (a) `change` jobs exist per directory with the contract config, (b) no identity-pipeline steps, (c) `case.change.create`/`confirm` audit rows, (d) removal jobs read `needs_approval`. Dispatch is optional (no live runner needed to validate planning).

- [ ] **Step 5: Commit**

```bash
git add web/lib/changelog/entries/change-mover-case.ts web/lib/changelog/entries/_registry.ts
git commit -m "docs(changelog): change/mover case"
```

---

## Self-Review notes (coverage against the spec)

- **`change` action + payload** → Tasks 1, 2. **Diff engine (scoped/full/add-only, protected-group exclusion)** → Task 3. **Rule-derived target reuse of `resolvePlannedConfigs`** → Task 4 (`targetGroupsForPersona`). **Planner (no identity pipeline, dir-sync inject, approval gating)** → Task 4. **Create held-for-review + confirm-with-mode** → Task 5. **Manual + bulk triggers** → Tasks 6, 8. **Confirm route (destructive-gated)** → Task 7. **Runner Change lane across every supported directory** → Tasks 9–14 (AD/M365/Exchange/Google + entra alias + dir-sync). **By-name removal + shared-mailbox add/remove (new code)** → Tasks 11, 12. **UI dialog + preview toggle** → Tasks 15–17. **Approval/audit/RBAC reuse** → Tasks 5, 7, 4 (`requiresApproval`/`intent`). **Non-goal (no per-user live discovery)** honored — preview is rule-derived (Task 16 note).
- **Deploy artifacts the human must ship:** migration `20260718120000_change_action`, runner `1.74.0`.
