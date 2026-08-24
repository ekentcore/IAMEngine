# Edited fields re-run rules and roles (FR #91) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When an operator corrects a field on a case, the rules and roles that key on that field
actually re-run — without destroying the correction in the process.

**Architecture:** Two ordered changes. First `deriveIdentity` stops overwriting operator-edited identity
fields (a prerequisite, and a live bug in its own right). Then the field-edit route re-derives the plan
through the existing `replanCase`, so rule- and role-driven job configs are recomputed.

**Tech Stack:** TypeScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 4)

## Diagnosis (confirmed 2026-08-24)

The request: *"If a field is edited, any Rules and Roles need to account for the change instead of using
the default of what comes from the case."*

`PATCH /api/cases/:id/fields` writes the edited value into `payload` and stops. Its own header states the
assumption:

> Merges into the case payload (which the runner reads at claim time, so no re-plan needed)

That is true for fields the runner reads directly, and the route even re-derives the UPN's siblings when
the UPN is edited — so the author knew some fields have downstream consequences. It is **false for
everything rule-driven.** Groups, licences, attributes and OU are computed at PLAN time by
`resolvePlannedConfigs` / `personaSystemKeys` from the payload as it was. Correct `department` after
planning and the persona and rule outputs keep the old value; the correction silently does not take.

`replanCase` already re-derives all of it correctly (`replan-service.ts:95-97`). Nothing calls it after a
field edit, and nothing tells the operator the plan is now stale.

### The prerequisite bug, found while confirming the above

`deriveIdentity` honours `fieldSource.displayName === "operator"` (intake-mapper.ts:396) but
**unconditionally overwrites** `userPrincipalName`, `samAccountName`, `mailNickname` and `workEmail` from
the client's username pattern. `replanCase` calls it on every onboard re-plan, immediately after
`mergeOperatorEdits` has carefully preserved the operator's keys.

Verified by running the exact sequence `replanCase` performs:

```
after mergeOperatorEdits : jsmith@acme.com
after deriveIdentity     : jonathan.smith@acme.com     <-- clobbered
samAccountName           : jonathan.smith
```

So **a re-plan today silently reverts a hand-corrected username**, and `mergeOperatorEdits`'s whole
purpose is defeated one line later. The existing tests cover the merge layer and the `displayName` case;
none asserts the UPN survives the derivation that runs straight after it.

This must be fixed FIRST. Task 2 makes a field edit trigger a re-plan, which would otherwise convert a
silent no-op into silent corruption of the identity path on every save — precisely the "wrong accounts at
scale" risk the spec flags.

### Decisions

1. **Mirror the existing `displayName` precedent** rather than invent a mechanism: consult
   `payload.fieldSource[k] === "operator"` per identity field. The pattern is already in this function.
2. **Per-field, not all-or-nothing.** An operator who edits only the UPN still gets `displayName` and the
   fallbacks derived normally.
3. **`userPrincipalNameFallbacks` are always re-derived.** They are conflict alternates generated from the
   client's patterns, never hand-edited, and the route does not stamp them.
4. **Auto re-plan only when the case has not started.** On a started case the incremental re-plan can add
   or re-run jobs, and a field save should not mutate a run in flight. Started cases keep today's
   behaviour, and the operator still has the explicit Re-plan button.
5. **A failed re-plan must not fail the field save.** The edit is already persisted and is the thing the
   operator asked for; the re-derive is best-effort and reported in the response.

## Global Constraints

- Web-only. **No runner change, no `runner/VERSION` bump, no deploy.**
- Baseline to beat: web **2156 pass / 6 known fail**.

---

### Task 1: An operator-edited identity field survives re-derivation

**Files:**
- Modify: `web/lib/servicenow/intake-mapper.ts` (`deriveIdentity`, around :390-410)
- Test: `web/lib/servicenow/intake-mapper.test.ts`

**Interfaces:**
- Produces: no new export. `deriveIdentity` keeps its signature; it simply stops overwriting
  operator-stamped identity keys.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/servicenow/intake-mapper.test.ts`:

```typescript
test("deriveIdentity keeps an operator-edited UPN and its siblings (FR #0000091)", () => {
  // The exact payload replanCase hands over after mergeOperatorEdits: PATCH /api/cases/:id/fields
  // sets these four together and stamps each as operator-sourced.
  const merged = {
    firstName: "Jonathan", lastName: "Smith",
    userPrincipalName: "jsmith@acme.com", samAccountName: "jsmith", mailNickname: "jsmith", workEmail: "jsmith@acme.com",
    fieldSource: { userPrincipalName: "operator", samAccountName: "operator", mailNickname: "operator", workEmail: "operator" },
  };
  const out = deriveIdentity(merged, { usernamePatterns: ["{first}.{last}@{domain}"], primaryDomain: "acme.com" });
  assert.equal(out.userPrincipalName, "jsmith@acme.com");
  assert.equal(out.samAccountName, "jsmith");
  assert.equal(out.mailNickname, "jsmith");
  assert.equal(out.workEmail, "jsmith@acme.com");
});

test("deriveIdentity still derives the fields the operator did NOT edit", () => {
  // Only the UPN was hand-corrected; samAccountName must still follow the pattern.
  const merged = {
    firstName: "Jonathan", lastName: "Smith",
    userPrincipalName: "jsmith@acme.com",
    fieldSource: { userPrincipalName: "operator" },
  };
  const out = deriveIdentity(merged, { usernamePatterns: ["{first}.{last}@{domain}"], primaryDomain: "acme.com" });
  assert.equal(out.userPrincipalName, "jsmith@acme.com"); // kept
  assert.equal(out.samAccountName, "jonathan.smith");     // derived
});

test("deriveIdentity re-derives everything when nothing is operator-sourced", () => {
  const out = deriveIdentity({ firstName: "Jonathan", lastName: "Smith", userPrincipalName: "stale@acme.com" },
    { usernamePatterns: ["{first}.{last}@{domain}"], primaryDomain: "acme.com" });
  assert.equal(out.userPrincipalName, "jonathan.smith@acme.com");
  assert.equal(out.samAccountName, "jonathan.smith");
});

test("deriveIdentity always re-derives the conflict fallbacks, even beside an operator UPN", () => {
  // Fallbacks are generated alternates, never hand-edited — they must track the client's patterns.
  const out = deriveIdentity(
    { firstName: "Jonathan", lastName: "Smith", mi: "Q", userPrincipalName: "jsmith@acme.com", fieldSource: { userPrincipalName: "operator" } },
    { usernamePatterns: ["{first}.{last}@{domain}", "{first}.{mi}@{domain}"], primaryDomain: "acme.com" });
  assert.equal(out.userPrincipalName, "jsmith@acme.com");
  assert.deepEqual(out.userPrincipalNameFallbacks, ["jonathan.q@acme.com"]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && npx tsx --test lib/servicenow/intake-mapper.test.ts`

Expected: the first, second and fourth FAIL (the derived value wins); the third PASSES.

- [ ] **Step 3: Keep operator-stamped identity fields**

In `deriveIdentity`, immediately after the existing `operatorDisplayName` line, add a general helper and
use it for the four identity keys in the `merged` object:

```typescript
  // An operator-edited identity field must survive re-derivation, exactly as displayName already does.
  // replanCase runs mergeOperatorEdits (which carefully preserves the operator's keys) and then calls
  // this function, so without this the preserved value is overwritten one line later and a hand-
  // corrected username silently reverts to the pattern on every re-plan (FR #0000091).
  const src = (payload.fieldSource ?? {}) as Record<string, unknown>;
  const operatorEdited = (k: string): boolean => src[k] === "operator";
  const keepOperator = <T>(k: string, derived: T): T => (operatorEdited(k) && payload[k] != null ? (payload[k] as T) : derived);
```

Then in the `merged` literal, wrap the four:

```typescript
    userPrincipalName: keepOperator("userPrincipalName", upn),
    userPrincipalNameFallbacks: fallbacks, // always derived — generated alternates, never hand-edited
    samAccountName: keepOperator("samAccountName", localPart || null),
    mailNickname: keepOperator("mailNickname", localPart || null),
    primaryDomain: domain || null,
    workEmail: keepOperator("workEmail", upn),
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npx tsx --test lib/servicenow/intake-mapper.test.ts`

Expected: all PASS, including the pre-existing nickname and displayName tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd web && npm test`

Expected: 2156 + 4 = **2160 pass**, the same 6 known failures.

- [ ] **Step 6: Commit**

```bash
git add web/lib/servicenow/intake-mapper.ts web/lib/servicenow/intake-mapper.test.ts
git commit -m "FR #91 (1/2): an operator-edited identity field survives re-derivation"
```

---

### Task 2: A field edit re-runs the rules

**Files:**
- Modify: `web/app/api/cases/[id]/fields/route.ts`
- Test: `web/lib/cases/replan-payload-merge.test.ts` (pure helper only — the route itself has no harness)

**Interfaces:**
- Consumes: Task 1's guarantee that re-deriving will not revert the edit being saved.
- Produces: `export function fieldEditNeedsReplan(startedJobs: number): boolean` in the route module is
  NOT wanted — keep the route thin. The gate is inline; see Step 2.

- [ ] **Step 1: Add the re-derive to the route**

In `web/app/api/cases/[id]/fields/route.ts`, widen the `findUnique` select to see whether the case has
started, and re-plan after the payload write.

Change the case lookup to:

```typescript
  const c = await db.caseRequest.findUnique({
    where: { id: params.id },
    select: { payload: true, pausedReason: true, jobs: { where: { startedAt: { not: null } }, select: { id: true }, take: 1 } },
  });
```

Then, after the existing `await db.caseRequest.update(...)` and BEFORE the needs_info release, add:

```typescript
  // Re-run the rules and roles against the corrected value (FR #0000091). Job CONFIGS — groups,
  // licences, attributes, OU — are computed at PLAN time from the payload, so writing the new value
  // alone left every rule that keyed on it still holding the ticket's original. The header above used
  // to say "no re-plan needed"; that is true only of the fields the runner reads directly.
  //
  // NOT on a case that has already started: an incremental re-plan can add or re-run steps, and a
  // field save must not mutate a run in flight. Those keep today's behaviour and the explicit Re-plan
  // button. Best-effort either way — the edit itself is already saved and is what the operator asked
  // for, so a re-plan failure is reported, never a failed save.
  let replanned: string | null = null;
  if (c.jobs.length === 0) {
    try {
      const r = await replanCase(db, params.id, { user: g.user });
      replanned = r.ok ? "replanned" : r.error;
    } catch (e) {
      replanned = e instanceof Error ? e.message : String(e);
    }
  }
```

Add the import at the top:

```typescript
import { replanCase } from "@/lib/cases/replan-service";
```

And include it in the response:

```typescript
  return NextResponse.json({ ok: true, filled, remaining: remaining.length, replanned, released: c.pausedReason === "needs_info" && remaining.length === 0 });
```

- [ ] **Step 2: Correct the route's header comment**

The first paragraph currently asserts the false premise. Replace:

```
// PATCH /api/cases/:id/fields { fields: { <field>: <value> } } — fill in the "Needs Information"
// fields the intake couldn't determine. Merges into the case payload (which the runner reads at
// claim time, so no re-plan needed), drops the filled keys from payload.unknownFields, and releases
// the hold once nothing's left to fill.
```

with:

```
// PATCH /api/cases/:id/fields { fields: { <field>: <value> } } — fill in the "Needs Information"
// fields the intake couldn't determine, or correct one the ticket got wrong. Merges into the case
// payload, drops the filled keys from payload.unknownFields, and releases the hold once nothing's
// left to fill.
//
// Then RE-PLANS an unstarted case (FR #0000091). The payload alone is not enough: the runner reads
// user fields from it at claim time, but job CONFIGS — groups, licences, attributes, OU — were
// computed at plan time by the rules and personas, so a corrected department left every rule still
// holding the ticket's original value and the correction silently did not take.
```

- [ ] **Step 3: Add the regression test for the interaction**

Append to `web/lib/cases/replan-payload-merge.test.ts` — this is the invariant that makes Task 2 safe, and
it belongs beside the merge tests it completes:

```typescript
test("an operator-edited UPN survives the FULL replan sequence (merge THEN derive)", () => {
  // The merge tests above prove the value reaches the payload. This proves it is still there after
  // deriveIdentity, which replanCase calls immediately afterwards — the step that used to undo it.
  const persisted = {
    firstName: "Jonathan", lastName: "Smith",
    userPrincipalName: "jsmith@acme.com", samAccountName: "jsmith",
    fieldSource: { userPrincipalName: "operator", samAccountName: "operator" },
  };
  const merged = mergeOperatorEdits({ firstName: "Jonathan", lastName: "Smith" }, persisted);
  const out = deriveIdentity(merged, { usernamePatterns: ["{first}.{last}@{domain}"], primaryDomain: "acme.com" });
  assert.equal(out.userPrincipalName, "jsmith@acme.com");
  assert.equal(out.samAccountName, "jsmith");
});
```

with the import added at the top of that file:

```typescript
import { deriveIdentity } from "../servicenow/intake-mapper";
```

- [ ] **Step 4: Verify**

Run: `cd web && npm test`

Expected: 2160 + 1 = **2161 pass**, the same 6 known failures.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/cases/[id]/fields/route.ts web/lib/cases/replan-payload-merge.test.ts
git commit -m "FR #91 (2/2): editing a field re-runs the rules and roles"
```

---

### Task 3: Changelog

**Files:**
- Create: `web/lib/changelog/entries/edited-fields-rerun-rules.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

- [ ] **Step 1: Write and register the entry**

```typescript
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "edited-fields-rerun-rules",
  date: "2026-08-24",
  time: "18:00",
  title: "Correcting a field on a case re-runs the rules and roles",
  items: [
    "Correct a field the ticket got wrong — department, job title, location, employment type — and the rules and personas that key on it now re-run, so the groups, licences, attributes and OU follow the corrected value. Before, the new value was saved but every rule kept firing on the ticket's original and the correction silently did not take. (FR #0000091)",
    "Job configs are decided when the case is planned, not when a step runs, which is why saving the field alone was never enough. The case is re-planned automatically after an edit",
    "Only on a case that has not started yet — a field save must not reshape a run already in flight. Started cases are unchanged and still have the Re-plan button",
    "Found while fixing that: a re-plan silently reverted a hand-corrected username to the pattern-generated one. The merge that preserves operator edits was being undone one step later by the identity derivation, so any re-plan threw the correction away. An edited username, login name, mail nickname or work email is now kept",
    "Web-only — no runner change",
  ],
};
```

Register in `_registry.ts`:

```typescript
export { entry as editedFieldsRerunRules } from "./edited-fields-rerun-rules";
```

- [ ] **Step 2: Verify and commit**

Run: `cd web && npm test` — expected 2161 pass / 6 known failures.

```bash
git add web/lib/changelog/entries/
git commit -m "Changelog for edited fields re-running rules"
```

---

## Out of scope, deliberately

- **No auto re-plan on a started case.** Reshaping a run in flight from a field save is a bigger
  behaviour change than this request asks for.
- **No new "plan is stale" UI.** Re-planning automatically removes the need for the operator to notice a
  badge; adding one as well would be two mechanisms for one problem.
- **No change to which fields the rules read.** This makes the existing rules see the corrected value; it
  does not widen what they can key on.

## Risks

- **Identity blast radius.** Task 1 changes how usernames are derived, which the spec calls out as the
  highest-consequence area in the batch. It is gated strictly on an explicit `fieldSource === "operator"`
  stamp, so a case with no operator edits derives exactly as it does today — pinned by its own test.
- **A field save now mutates the plan.** Bounded to unstarted cases, and best-effort so it can never turn
  a successful save into a failed request.
