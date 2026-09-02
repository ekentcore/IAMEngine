# A destructive Spanning offboard drops the licence (FR #95) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a client's Spanning offboard is classified destructive, unassign the licence and free the
seat — instead of attempting an Archive conversion that Kaseya's API cannot perform.

**Architecture:** Pure plan-time injection in `web/lib/profiles/plan-resolve.ts`, keyed on the planned
job's existing `intent`. The runner already implements both outcomes.

**Tech Stack:** TypeScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 12)

## Diagnosis (confirmed 2026-09-02)

The request: *"If the Spanning module is set on a client to be Destructive, it should remove the license
from the user rather than try to convert it to Archive — the majority of clients don't have Archive
licensing for Spanning."*

The premise checks out, and the runner already supports both outcomes
(`Coretelligent.Spanning.psm1:303`): a `removeLicense` or `unassign` flag unassigns the seat; absent it,
the default path attempts the Archive swap. **Nothing has ever set that flag.**

### The Archive swap fails most of the time

Across the 60 most recent Spanning offboard jobs:

| Outcome | Count |
|---|---|
| Archive swap confirmed | 17 |
| **Archive swap FAILED — billable seat left behind** | **37** |
| User not in Spanning | 4 |
| Other / no verdict | 2 |

The runner is already honest about it — it re-reads the tier, refuses to claim success, and warns that
*"Kaseya's API cannot convert Standard → Archive"* — but the seat stays billable and a human has to
finish it by hand. That is the requester's "majority of clients don't have Archive licensing", measured.

### Which clients this changes

`Destructive` is `config.intent.offboard === "destructive"`, **not** `requiresApproval` (a distinct
field). Measured on live clients:

- **4 Spanning rows are flagged destructive**: core2030, core658, core103, core131.
- Spanning is the **only** system flagged destructive anywhere in the fleet.
- None of the four has `removeLicense`, `unassign` or `swapLicense` configured, so all four take the
  Archive path today.
- **Three of the four appear in the failure list above** — core2030 (UM0030927) and core131 (UM0030851,
  UM0030913, UM0030914) all left billable seats.

So this is a four-client change that fixes a failure those clients are actually hitting.

### Why this is safe to automate

Unassigning is genuinely destructive — Kaseya warns that deactivating a licence can lead to backup data
deletion, which is exactly why the runner refuses to auto-unassign on the *default* path. The gate is
that `destructive` intent already forces operator approval and evidence capture at plan time
(`orchestrator.ts:279` and `:281`: `requiresApproval: destructive || …`, `captureEvidence: destructive || …`),
**regardless of the stored `requiresApproval` value** — which is `false` on all four of these rows. So
the job cannot run until a human approves it on the case, and state is snapshotted first.

That is the whole meaning of the classification: *"destructive = actually deletes data — always requires
operator approval AND snapshots state first so it's redoable."*

### Decisions

1. **Key on the planned job's `intent`**, which `PlannedJob` already carries, in `plan-resolve.ts` beside
   the other plan-time injections. No new plumbing.
2. **Explicit client config wins.** A client that has deliberately configured `swapLicense` (one has) or
   already set `removeLicense` keeps exactly what it configured. This only fills the gap.
3. **Spanning only.** It is the only system where "destructive" means a licence tier decision, and the
   only system flagged destructive at all. A generic rule would be inventing policy for systems that
   have not asked for it.
4. **No runner change.** `removeLicense` is already implemented and already idempotent (it no-ops when
   the licence is already gone).
5. **Non-destructive clients are untouched.** For them the Archive conversion IS the intent; when it
   fails the runner's existing warning is the correct outcome, and silently unassigning their seats
   would risk deleting backups nobody agreed to lose.

## Global Constraints

- Web-only. **No runner change, no `runner/VERSION` bump, no migration.**
- Baseline to beat: web **2195 pass / 6 known fail**.

---

### Task 1: Plan `removeLicense` for a destructive Spanning offboard

**Files:**
- Modify: `web/lib/profiles/plan-resolve.ts`
- Test: `web/lib/profiles/plan-resolve.offboard.test.ts`

**Interfaces:**
- No new export. The injection sits with the other offboard injections, before `injectHideFromGal`.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/profiles/plan-resolve.offboard.test.ts`:

```typescript
const spanning = (config: unknown, intent: "disable" | "destructive" | null = "destructive"): PlannedJob =>
  ({ systemKey: "spanning", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent, secretNames: [], dependsOn: [], config } as PlannedJob);

test("a DESTRUCTIVE spanning offboard drops the licence instead of converting to Archive (FR #0000095)", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, true);
});

test("a non-destructive spanning offboard still converts to Archive", () => {
  // For these clients the Archive conversion IS the intent. Unassigning their seats could delete
  // backups nobody agreed to lose.
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({}, "disable")]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, undefined);
});

test("an explicitly configured swapLicense wins over the destructive default", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({ swapLicense: { from: "Standard", to: "Archive" } })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.equal(cfg.removeLicense, undefined);           // the client configured a swap deliberately
  assert.deepEqual(cfg.swapLicense, { from: "Standard", to: "Archive" });
});

test("an already-set removeLicense is left exactly as it is", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({ removeLicense: false })]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, false);
});

test("the rest of the spanning config survives the injection", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [spanning({ afterMailboxConvertAndLicenseRemoval: true })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.equal(cfg.afterMailboxConvertAndLicenseRemoval, true);
  assert.equal(cfg.removeLicense, true);
});

test("a destructive step on ANOTHER system is not given a spanning licence flag", () => {
  const m365 = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: "destructive", secretNames: [], dependsOn: [], config: {} } as PlannedJob;
  const out = resolvePlannedConfigs(bare, {}, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, undefined);
});

test("a destructive spanning step is not touched on an ONBOARD", () => {
  const out = resolvePlannedConfigs(bare, {}, "onboard", [spanning({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeLicense, undefined);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd web && npx tsx --test lib/profiles/plan-resolve.offboard.test.ts`
Expected: the first and fifth FAIL; the rest already pass (they are the guards).

- [ ] **Step 3: Add the injection**

In `resolvePlannedConfigs`, immediately before the final `return injectHideFromGal(...)`:

```typescript
  // Spanning, destructive offboard (FR #0000095): unassign the licence rather than attempt an Archive
  // conversion. The runner has always supported both (config.removeLicense -> /users/unassign) and
  // nothing ever set the flag, so every client took the Archive path — which Kaseya's API cannot
  // perform from a Standard licence ("Standard licenses cannot be converted to archived licenses").
  // Measured before shipping: 37 of the 60 most recent Spanning offboards failed the swap and left a
  // billable seat for a human to finish by hand, and three of the four destructive clients are in
  // that list.
  //
  // Only for the DESTRUCTIVE classification. For everyone else the Archive conversion is the intent,
  // and quietly unassigning their seats could delete backups nobody agreed to lose — Kaseya warns that
  // deactivating a licence can do exactly that, which is why the runner refuses to auto-unassign on
  // the default path. The gate here is that a destructive step already forces operator approval AND
  // an evidence snapshot at plan time (orchestrator.ts), whatever the stored requiresApproval says.
  //
  // Explicit client config wins: a deliberately configured swapLicense or removeLicense is untouched.
  const withSpanningDrop = action !== "offboard" ? withForwarding : withForwarding.map((j) => {
    if (j.systemKey !== "spanning" || j.intent !== "destructive") return j;
    const cfg = (j.config as Record<string, unknown> | null) ?? {};
    if ("removeLicense" in cfg || "unassign" in cfg || "swapLicense" in cfg) return j;
    return { ...j, config: { ...cfg, removeLicense: true } };
  });

  return injectHideFromGal(withSpanningDrop, payload, client.backbone);
```

- [ ] **Step 4: Verify**

Run: `cd web && npx tsx --test lib/profiles/plan-resolve.offboard.test.ts` — all PASS.
Run: `cd web && npm test` — expected 2195 + 7 = **2202 pass**, same 6 known failures.
Run: `cd web && npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 5: Commit**

```bash
git add web/lib/profiles/plan-resolve.ts web/lib/profiles/plan-resolve.offboard.test.ts
git commit -m "FR #95: a destructive Spanning offboard drops the licence"
```

---

### Task 2: Changelog

- [ ] Create `web/lib/changelog/entries/spanning-destructive-drops-licence.ts`, register it in
  `_registry.ts` in id order, verify the suite, commit.

---

## Out of scope, deliberately

- **The 37 failing Archive swaps on non-destructive clients.** For them the conversion is the intended
  outcome, and the runner's warning is the correct behaviour. The real remedy is either Archive
  licensing or reclassifying those clients as destructive — a client-configuration decision, not code.
- **No runner change.** `removeLicense` already exists and is already idempotent.
- **No generic destructive→drop rule.** Spanning is the only system where "destructive" implies a
  licence-tier decision, and the only one flagged destructive at all.

## Risks

- **Unassigning can delete backup data** (Kaseya's own warning). Mitigated by the classification itself:
  a destructive step cannot run without operator approval and snapshots state first. But it IS a
  behaviour change for four clients, and the first one should be watched.
- **A client flagged destructive by accident** now frees seats where it used to leave them. Worth
  confirming with the requester that core2030, core658, core103 and core131 are all intended.
