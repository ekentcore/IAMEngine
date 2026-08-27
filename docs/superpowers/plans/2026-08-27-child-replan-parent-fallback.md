# A child client's re-plan inherits its parent's runbook (FR #42) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop a re-plan on a child client planning ZERO jobs — which is why groups the ticket asked for
were pulled onto the case and then added to nobody.

**Architecture:** The parent-inheritance fallback lives in `clientForPlanning` (the initial-plan path) and
is simply absent from `replanInputs` (the re-plan path). Extract it once and use it in both, so the two
cannot drift apart again.

**Tech Stack:** TypeScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 7)

## Diagnosis (confirmed 2026-08-27)

The request: *"Child Companies are pulling groups from the case but not adding them to the user."*

The spec's hypothesis was that FR#4 routes requested groups to the lane that masters them, so a child
whose systems differ from its parent's gets groups handed to a lane it does not run. **That is not what
happened.** The routing is fine — replaying the reported case's exact payload through today's
`resolvePlannedConfigs` puts both distribution groups on the m365 job correctly.

The real cause is one step earlier: **on a re-plan there were no jobs to put them on.**

### The reported case

UM0029925 — Paradise Animal Hospital (`core901`), a child of `core802`, with **no systems of its own**.
The ticket asked for `emailDistroGroups: ["PAH Techs", "PAH Paradise"]`. Neither reached any job config.
Its audit trail shows three re-plans, every one of them:

```
case.replan  {"jobs":0,"kept":3,"added":0,"mode":"incremental","refreshedFromServiceNow":true}
```

`jobs` is `planned.length`. The planner produced **nothing**, so `resolvePlannedConfigs` had an empty
array to merge the requested groups into, and they went nowhere. The incremental re-plan then "kept" the
three jobs from the original plan, so the case looked healthy.

### Why the two paths disagree

- `clientForPlanning` (`repository.ts:160-180`) — the **initial plan** — falls back to the parent when
  `c.systems.length === 0 && c.parentId && c.inheritParentSystems`, taking the parent's systems wholesale
  and its modeling inputs individually.
- `replanInputs` (`repository.ts:272-301`) — the **re-plan** — selects the child's own `systems` and
  returns `{ ...c.client }`. **There is no fallback.** A child with zero systems re-plans to zero jobs.

That also means a re-plan loses the parent's `identity`, `personas`, `globals`, `globalsOffboard`,
`locations`, `adObjects` and `cloudGroups` for these clients — not just the systems.

### Fleet-wide

| Client kind | `case.replan` events | Planned ZERO jobs |
|---|---|---|
| No-systems child | 30 | **23 (77%)** |
| Everything else | 291 | 5 (2%) |

Affected clients: core879, core901, core833, core2233, core870, core1271, core2188.

Corroborating the mechanism: the only other child onboard that ever requested distribution groups —
UM0030740 (`core915`, same parent, byte-identical configuration) — got them, because its groups were
present at INITIAL plan time and it never needed a re-plan to pick them up.

### Decisions

1. **Extract the fallback, don't copy it.** These two paths have already drifted once; a second copy
   would drift again. One helper, used by both.
2. **Identical semantics.** The same gate (`no own systems && parentId && inheritParentSystems`), the same
   fields, the same "anything the child HAS set still wins" individual fallback. This is not the moment
   to redesign inheritance — that is #41.
3. **`intakeRules` keeps NOT falling back**, because `clientForPlanning` does not fall back for it either.
   Matching today's initial-plan behaviour exactly is the whole point.

## Global Constraints

- Web-only. **No runner change, no `runner/VERSION` bump, no deploy.**
- Baseline to beat: web **2166 pass / 6 known fail**.

---

### Task 1: Extract the parent fallback and use it in both planning paths

**Files:**
- Create: `web/lib/cases/parent-inheritance.ts`
- Modify: `web/lib/cases/repository.ts` (`clientForPlanning`, `replanInputs`)
- Test: `web/lib/cases/parent-inheritance.test.ts`

**Interfaces:**
- Produces:
  `export function inheritsFromParent(child: { systems: unknown[]; parentId: string | null; inheritParentSystems: boolean }): boolean`
  and
  `export function applyParentInheritance<C extends InheritableChild, P extends InheritableParent>(child: C, parent: P | null): C`

- [ ] **Step 1: Write the failing tests**

Create `web/lib/cases/parent-inheritance.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { inheritsFromParent, applyParentInheritance } from "./parent-inheritance";

const parent = {
  systems: [{ systemKey: "m365" }, { systemKey: "exchange" }],
  identity: { usernamePatterns: ["{first}.{last}@{domain}"] },
  personas: { vet: {} }, globals: { m365: {} }, globalsOffboard: { m365: {} },
  locations: { rows: [] }, adObjects: { ous: [] }, cloudGroups: { groups: [] },
};

test("a child with no systems, a parent, and inheritance on DOES inherit", () => {
  assert.equal(inheritsFromParent({ systems: [], parentId: "p1", inheritParentSystems: true }), true);
});

test("a child with its own systems does NOT inherit (adding systems ends inheritance)", () => {
  assert.equal(inheritsFromParent({ systems: [{ systemKey: "m365" }], parentId: "p1", inheritParentSystems: true }), false);
});

test("a child with inheritance switched off does NOT inherit", () => {
  assert.equal(inheritsFromParent({ systems: [], parentId: "p1", inheritParentSystems: false }), false);
});

test("a top-level client never inherits", () => {
  assert.equal(inheritsFromParent({ systems: [], parentId: null, inheritParentSystems: true }), false);
});

test("systems come wholesale from the parent", () => {
  const child = { systems: [] as unknown[], identity: null, personas: null, globals: null, globalsOffboard: null, locations: null, adObjects: null, cloudGroups: null };
  const out = applyParentInheritance(child, parent);
  assert.deepEqual(out.systems, parent.systems);
});

test("modeling inputs fall back INDIVIDUALLY — anything the child set still wins", () => {
  const child = { systems: [] as unknown[], identity: null, personas: { own: {} }, globals: null, globalsOffboard: null, locations: null, adObjects: null, cloudGroups: null };
  const out = applyParentInheritance(child, parent);
  assert.deepEqual(out.personas, { own: {} });        // child's own survives
  assert.deepEqual(out.globals, parent.globals);      // unset falls back
  assert.deepEqual(out.identity, parent.identity);
});

test("a parent with no systems of its own changes nothing", () => {
  const child = { systems: [] as unknown[], identity: null, personas: null, globals: null, globalsOffboard: null, locations: null, adObjects: null, cloudGroups: null };
  const out = applyParentInheritance(child, { ...parent, systems: [] });
  assert.deepEqual(out.systems, []);
  assert.equal(out.personas, null);
});

test("a null parent changes nothing", () => {
  const child = { systems: [] as unknown[], identity: null, personas: null, globals: null, globalsOffboard: null, locations: null, adObjects: null, cloudGroups: null };
  assert.deepEqual(applyParentInheritance(child, null), child);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd web && npx tsx --test lib/cases/parent-inheritance.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create the module**

Create `web/lib/cases/parent-inheritance.ts`:

```typescript
// Account-hierarchy inheritance, in ONE place.
//
// A child with NO modeled systems of its own plans with its PARENT's runbook (e.g. CORE2181..89 inherit
// CORE1456). Systems come wholesale from the parent; the modeling inputs fall back individually, so
// anything the child HAS set still wins. Adding systems to the child later automatically ends the
// inheritance, and a child whose inheritParentSystems was switched off never inherits.
//
// This lived only in clientForPlanning (the INITIAL plan). replanInputs (the RE-PLAN) selected the
// child's own systems and had no fallback at all, so a re-plan on such a child planned ZERO jobs — 77%
// of their re-plans, against 2% everywhere else. Nothing to plan meant nothing for the requested-groups
// merge to land on, which is how a ticket's distribution groups were pulled onto the case and then added
// to nobody (FR #0000042). Extracted rather than copied precisely because the two paths already drifted
// once.
export type InheritableChild = {
  systems: unknown[];
  identity: unknown; personas: unknown; globals: unknown; globalsOffboard: unknown;
  locations: unknown; adObjects: unknown; cloudGroups: unknown;
};
export type InheritableParent = Omit<InheritableChild, "systems"> & { systems: unknown[] };

export function inheritsFromParent(child: { systems: unknown[]; parentId: string | null; inheritParentSystems: boolean }): boolean {
  return child.systems.length === 0 && !!child.parentId && child.inheritParentSystems;
}

export function applyParentInheritance<C extends InheritableChild>(child: C, parent: InheritableParent | null): C {
  // A parent with no systems has no runbook to lend — leave the child exactly as it is rather than
  // blanking it against an empty parent.
  if (!parent || parent.systems.length === 0) return child;
  return {
    ...child,
    systems: parent.systems,
    identity: child.identity ?? parent.identity,
    personas: child.personas ?? parent.personas,
    globals: child.globals ?? parent.globals,
    globalsOffboard: child.globalsOffboard ?? parent.globalsOffboard,
    locations: child.locations ?? parent.locations,
    adObjects: child.adObjects ?? parent.adObjects,
    cloudGroups: child.cloudGroups ?? parent.cloudGroups,
  };
}

// The parent columns both planning paths need to read.
export const PARENT_INHERIT_SELECT = {
  identity: true, personas: true, globals: true, globalsOffboard: true,
  locations: true, systems: true, adObjects: true, cloudGroups: true,
} as const;
```

- [ ] **Step 4: Use it in `clientForPlanning`**

Replace the inline block in `repository.ts` (the `if (c.systems.length === 0 && c.parentId && c.inheritParentSystems) { ... }`
through its closing brace) with:

```typescript
      if (inheritsFromParent(c)) {
        const p = await db.client.findUnique({ where: { id: c.parentId! }, select: PARENT_INHERIT_SELECT });
        const merged = applyParentInheritance({ ...c, notNeededSecrets, wiredOptionalSecrets }, p);
        if (merged.systems !== c.systems) return merged;
      }
```

- [ ] **Step 5: Use it in `replanInputs`**

`replanInputs` must select the two gate fields it does not currently read. Add to its client select
(it already selects `parentId`):

```typescript
              inheritParentSystems: true,
```

Then replace its return's `client:` value:

```typescript
      const inherited = inheritsFromParent(c.client)
        ? applyParentInheritance(c.client, await db.client.findUnique({ where: { id: c.client.parentId! }, select: PARENT_INHERIT_SELECT }))
        : c.client;
      return {
        serviceNowCaseNumber: c.serviceNowCaseNumber,
        action: c.action,
        payload: (c.payload ?? {}) as Record<string, unknown>,
        emailDomainOverride: c.emailDomainOverride,
        client: { ...inherited, notNeededSecrets, wiredOptionalSecrets },
        started: hasStartedJobs(c.jobs),
      };
```

Add the import at the top of `repository.ts`:

```typescript
import { inheritsFromParent, applyParentInheritance, PARENT_INHERIT_SELECT } from "./parent-inheritance";
```

- [ ] **Step 6: Verify**

Run: `cd web && npx tsx --test lib/cases/parent-inheritance.test.ts` — all PASS.
Run: `cd web && npm test` — expected 2166 + 8 = **2174 pass**, same 6 known failures.
Run: `cd web && npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 7: Commit**

```bash
git add web/lib/cases/parent-inheritance.ts web/lib/cases/parent-inheritance.test.ts web/lib/cases/repository.ts
git commit -m "FR #42: a child client's re-plan inherits its parent's runbook"
```

---

### Task 2: Changelog

**Files:**
- Create: `web/lib/changelog/entries/child-replan-parent-fallback.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

- [ ] **Step 1: Write and register**

```typescript
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "child-replan-parent-fallback",
  date: "2026-08-27",
  time: "10:00",
  title: "Re-planning a child company's case no longer plans nothing",
  items: [
    "A child company with no systems of its own borrows its parent's runbook. That worked when the case was first planned and not when it was re-planned — a re-plan produced ZERO steps, 77% of the time for these clients against 2% everywhere else. (FR #0000042)",
    "The visible symptom was the reported one: groups the ticket asked for were pulled onto the case and then added to nobody. There were no steps to add them to. The re-plan kept the steps from the original plan, so the case looked healthy",
    "A re-plan was also dropping the parent's roles, personas, every-user rules, locations and username patterns for those clients — the same missing fallback, wider than groups",
    "The inheritance rule now lives in one place used by both paths, because they had already drifted apart once",
    "Unchanged: a child with its OWN systems still does not inherit, and a child with inheritance switched off still does not",
    "Web-only — no runner change",
  ],
};
```

- [ ] **Step 2: Verify and commit**

Run: `cd web && npm test` — expected 2174 pass / 6 known failures.

```bash
git add web/lib/changelog/entries/
git commit -m "Changelog for the child re-plan parent fallback"
```

---

## Out of scope, deliberately

- **No change to the inheritance RULE.** Same gate, same fields, same precedence as the initial plan.
  Redesigning it — including the per-child opt-out the requester wants for roles and personas — is #41,
  which follows this.
- **No backfill of already-planned cases.** A case whose re-plan under-planned keeps its jobs; re-planning
  it again after this ships picks up the parent's runbook.

## Risks

- **A re-plan on these clients will now add steps it previously did not.** That is the fix working — the
  child's plan should match the parent's runbook — but on an in-flight case it means new pending steps
  appearing where a re-plan used to be a no-op. `replanCaseJobs` is incremental and keeps finished and
  in-flight jobs, so nothing already done is disturbed. Worth watching on the first few.
- **Seven clients change behaviour at once** (core879, core901, core833, core2233, core870, core1271,
  core2188). All of them are currently re-planning to nothing, so the change is strictly an improvement,
  but it is not a no-op for them.
