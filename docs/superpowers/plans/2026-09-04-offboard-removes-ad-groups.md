# Offboarding actually removes AD groups (FR #109) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A departing employee stops keeping every Active Directory group membership — and the removal
is recoverable, because what was removed is snapshotted first.

**Architecture:** Plan-time injection in the offboard resolver. The runner already implements the
removal, safely; nothing has ever asked it to.

**Spec:** `docs/superpowers/specs/2026-09-03-unranked-requests-triage.md` (ranked 1st)

## Diagnosis (confirmed 2026-09-03/04)

> "Steps are not removing user from AD groups"

The AD module has supported this the whole time, in two forms — `removeAllGroups`
(`Coretelligent.ActiveDirectory.psm1:618`) strips everything, `removeGroups` (`:656`) strips a named
list. Almost nothing is configured to use either:

| Live AD clients (44) | Count |
|---|---|
| `removeAllGroups` set | **2** (coretelligent, six-one) |
| named-group rules | **0** |
| **neither — no AD group is ever removed** | **42** |

core1594, the reported client, has an entirely empty AD offboard config (`{}`).

So on 42 of 44 AD clients a leaver keeps every group membership, and the case reports green. Group
membership is what grants file-share, application and group-based-licensing access — the offboard is
not offboarding.

**42 clients did not each make that choice.** The seed/profile path never sets a group policy, so
silence reads as "remove nothing". A default is the fix; 42 hand edits are not.

### The removal itself is already careful

This is the reason a default is safe. `removeAllGroups` already:

- skips `Domain Users` (the old default primary, not removable this way);
- skips the group set as the user's **new** primary earlier in the same offboard, and says so;
- skips **protected/privileged** groups via `Test-CtgADProtectedGroup` — well-known admin names, an
  `*,OU=*Privileged,*` DN pattern, and a per-client `protectedGroups` list — recording each as a
  manual-removal item with a WARN rather than silently tearing it down;
- removes by `DistinguishedName`, not Name, so Teams/M365-provisioned groups resolve;
- uses `-ErrorAction Stop` so a failed removal is surfaced, not logged as success.

There was never a "remove-all vs protected-aware sweep" choice to make. `removeAllGroups` **is** the
protected-aware sweep.

### The safety gap that shapes this plan

Group removal is only recoverable if you know what was removed. Checking the gates:

| Live AD clients (44) | Count |
|---|---|
| capture evidence on offboard | 28 |
| **capture NO evidence on offboard** | **16** |
| require approval on offboard | **0** |
| classified `destructive` | **0** |

So turning the default on alone would strip every group on 16 clients **with no snapshot of what was
removed** — irreversible in practice. That is a worse failure than the bug.

Therefore the injection sets **both**: the removal, and evidence capture on the same step.

### Decisions

1. **Default `removeAllGroups: true`** on the AD offboard job when the client expresses no group policy
   of its own. Silence currently means "keep everything", which is the wrong default for an offboard.
2. **Force `captureEvidence` on that job whenever the default fires.** Never strip memberships we have
   not recorded. A client that already captures evidence is unaffected; the 16 that do not now will.
3. **Explicit client config wins, in both directions.** `removeAllGroups: false` is a deliberate opt-out
   and is honoured. A non-empty `removeGroups` rule set means the client chose specific groups, so the
   blanket default stays off.
4. **Say it in the action log.** The step records that the removal was the engine's default rather than
   a configured choice, so an operator reading the case can tell the difference.
5. **No approval gate added.** These steps are classified `disable`, not `destructive`, and the removal
   is reversible from the evidence snapshot. Adding a fleet-wide approval prompt to every offboard is a
   workflow change this request did not ask for — but see the risk note.

## Global Constraints

- Web-only. **No runner change, no `runner/VERSION` bump, no migration.**
- Baseline to beat: web **2202 pass / 6 known fail**.

---

### Task 1: Default the removal, with evidence

**Files:**
- Modify: `web/lib/profiles/plan-resolve.ts` (offboard resolver)
- Test: `web/lib/profiles/plan-resolve.offboard.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
const ad = (config: unknown, captureEvidence = false): PlannedJob =>
  ({ systemKey: "active-directory", sequence: 0, mode: "api", requiresApproval: false, captureEvidence,
     intent: "disable", secretNames: [], dependsOn: [], config } as PlannedJob);

test("an AD offboard with no group policy defaults to removing all groups (FR #0000109)", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, true);
});

test("the default ALSO forces an evidence snapshot — never strip what we didn't record", () => {
  // 16 of 44 AD clients captured no evidence on offboard. Stripping every group without recording
  // them first is a one-way door: nobody knows what to re-add.
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({})]);
  assert.equal(out[0].captureEvidence, true);
});

test("an explicit removeAllGroups:false is a deliberate opt-out and is honoured", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({ removeAllGroups: false })]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, false);
  assert.equal(out[0].captureEvidence, false); // no default fired, so nothing was forced
});

test("a client with named removeGroups rules keeps them and gets no blanket default", () => {
  const client = { globals: {}, personas: {},
    globalsOffboard: { "active-directory": { groups: ["Contractors"] } } };
  const out = resolvePlannedConfigs(client, {}, "offboard", [ad({})]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.deepEqual(cfg.removeGroups, ["Contractors"]);
  assert.equal(cfg.removeAllGroups, undefined);
});

test("a client already capturing evidence is left exactly as it is", () => {
  const out = resolvePlannedConfigs(bare, {}, "offboard", [ad({}, true)]);
  assert.equal(out[0].captureEvidence, true);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, true);
});

test("the default is AD-only — no other lane gets a group flag", () => {
  const m365 = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false,
                 captureEvidence: false, intent: "disable", secretNames: [], dependsOn: [], config: {} } as PlannedJob;
  const out = resolvePlannedConfigs(bare, {}, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, undefined);
});

test("nothing is injected on an ONBOARD", () => {
  const out = resolvePlannedConfigs(bare, {}, "onboard", [ad({})]);
  assert.equal((out[0].config as Record<string, unknown>).removeAllGroups, undefined);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd web && npx tsx --test lib/profiles/plan-resolve.offboard.test.ts`
Expected: the first, second and fifth FAIL; the rest are guards that already pass.

- [ ] **Step 3: Add the injection**

In the offboard resolver, before the final return:

```typescript
  // AD offboard group removal (FR #0000109). The AD module has always been able to do this —
  // removeAllGroups strips every membership, skipping Domain Users, the new primary group, and any
  // protected/privileged group (well-known admin names, an *Privileged* OU, or the client's own
  // protectedGroups list), recording each skip as a manual-removal item. Nothing ever set the flag:
  // of 44 live AD clients, 2 removed all groups, 0 had named-group rules, and 42 removed NOTHING. So a
  // leaver kept every group — file-share, application and group-based-licensing access — and the case
  // reported green. Silence meant "keep everything", which is the wrong default for an offboard.
  //
  // The evidence half is not optional. 16 of those 44 captured no evidence on offboard, and stripping
  // memberships nobody recorded is a one-way door — the snapshot is what makes this reversible. So the
  // default sets BOTH, and only ever together.
  //
  // Explicit config wins in both directions: removeAllGroups:false is a deliberate opt-out, and a
  // client with named removeGroups rules chose specific groups and does not get the blanket default.
  const withAdGroups = withSpanningDrop.map((j) => {
    if (j.systemKey !== "active-directory") return j;
    const cfg = (j.config as Record<string, unknown> | null) ?? {};
    if ("removeAllGroups" in cfg) return j;
    const named = cfg.removeGroups;
    if (Array.isArray(named) && named.length > 0) return j;
    return {
      ...j,
      captureEvidence: true,
      config: { ...cfg, removeAllGroups: true, removeAllGroupsBy: "engine-default" },
    };
  });

  return injectHideFromGal(withAdGroups, payload, client.backbone);
```

- [ ] **Step 4: Verify**

Run: `cd web && npx tsx --test lib/profiles/plan-resolve.offboard.test.ts` — all PASS.
Run: `cd web && npm test` — expected 2202 + 7 = **2209 pass**, same 6 known failures.
Run: `cd web && npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 5: Commit**

---

### Task 2: Say so on the case

**Files:**
- Modify: `runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1`
- Test: `runner/tests/Coretelligent.ActiveDirectory.Tests.ps1`
- Modify: `runner/VERSION` → 1.114.0

- [ ] **Step 1: Distinguish the default from a configured choice**

At the top of the `removeAllGroups` block, so an operator reading the run report can tell which it was:

```powershell
        if ([string](Get-CtgProp $Config 'removeAllGroupsBy') -eq 'engine-default') {
            $actions.Add("removing all group memberships by ENGINE DEFAULT — this client has no group policy configured. Memberships are captured as evidence first; set removeAllGroups:false on the client to opt out.")
        }
```

- [ ] **Step 2: Test it, bump the version, commit**

Note this is presentational only — if the runner half is not deployed, the removal still happens
correctly; only the explanatory line is missing. The web half is what fixes the bug.

---

### Task 3: Changelog

- [ ] Create `web/lib/changelog/entries/offboard-removes-ad-groups.ts`, register in id order, verify, commit.

---

## Out of scope, deliberately

- **No approval gate.** These steps are classified `disable`, not `destructive`, and the removal is
  reversible from the snapshot. Adding a fleet-wide prompt to every offboard is a workflow change this
  request did not ask for.
- **No backfill of the 42 client configs.** The default covers them; writing 42 rows would be the same
  decision expressed 42 times, and each would then need maintaining.
- **No change to the removal itself.** It is already correct and careful.

## Risks

- **42 clients change behaviour on the next offboard.** That is the point, but it is the largest
  behavioural change in this batch. The mitigations are that protected groups are still skipped and
  reported, and that evidence is now forced — so anything removed can be identified and re-added.
- **Evidence is only useful if someone reads it.** The snapshot lands on the case; if a removal turns
  out to be wrong, recovery is manual from that list.
- **A client that deliberately wanted memberships kept** now has to say so explicitly. Given the
  security stake, opt-out is the right direction for the default to point — but the first few offboards
  after this ships are worth watching.
