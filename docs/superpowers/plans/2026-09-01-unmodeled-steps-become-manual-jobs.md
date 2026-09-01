# Unmodeled runbook steps become manual checklist jobs (FR #96) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A runbook section we haven't modelled as a system becomes a manual step on the case, so the
Run Report is the checklist the operator actually works from — instead of the work silently vanishing.

**Architecture:** The sections are already extracted, classified and persisted (`RunbookSection.status
= "unmodeled"`). The planner has simply never read them. Add a pure helper that turns them into
`mode: "manual"` planned jobs, and call it from both planning paths.

**Tech Stack:** TypeScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 10, decision 6)

## Diagnosis (confirmed 2026-09-01)

The request: *"If a step is unmodeled, it should still appear in the steps as a step to perform manually,
as it still needs to be taken care of, and we could utilize the Run Report as a checklist."*

Everything needed already exists except the last hop:

- **Extraction** classifies each section (`runbook-extract.ts:74`) as `automated` when it maps to a known
  system key and **`unmodeled`** when it doesn't.
- **Persistence** keeps them — `RunbookSection` carries `status`, `title`, `steps[]` and a vendor `guess`.
- **The planner never reads them.** `planCase` takes `ClientSystem[]`; nothing queries `runbookSection`
  at plan time. The only consumer is `playbook.ts:169`, and it filters to `systemKey: { in: keys }` —
  i.e. sections that ARE modelled. An unmodeled section is invisible to the case.

So the work is genuinely just planning them. The rest is already built and needs no changes:

- A `manual` job holds the case open — `runner-logic.ts:117` returns `needs_manual` when any job is
  `manual`, which is exactly the "an untouched one holds the case open" the spec's decision 6 asks for.
- Ticking one off is `POST /api/jobs/{id}/complete`, already undoable and already recomputes case status.
- The Run Report already renders manual steps and shows `config.note` / `config.notes` as their text
  (`manualNotesOf`, run-report.ts:171).

### Scale, measured

241 unmodeled sections on live clients, across **134 client+action pairs**. Median 1 per case; worst
(core1387 onboard) 10. A sample of what is being dropped today: Dropsuite, Box, Verizon, LogMeIn,
SalesForce, Visual Studio Subscriptions, SSO Application Groups.

**Rollout decision (confirmed with the requester): all clients immediately.** Median one extra tick per
case, and it surfaces real work that vanishes today. The cost is that 134 client+action pairs change
behaviour on merge, and a case whose steps all automate today will start waiting on an operator.

### Decisions

1. **Synthetic `systemKey`, prefixed `unmodeled:`.** `Job.systemKey` is a plain `String`, not a foreign
   key, so this is safe. The prefix is what lets every consumer recognise the class.
2. **Deterministic and unique per case.** `replanCaseJobs` keys kept jobs by `systemKey`
   (`repository.ts:390`), so the key must be stable across re-plans — otherwise a ticked step is
   recreated as untouched work on the next re-plan. Derived from the title slug, with a numeric suffix
   only where two sections in one action collide.
3. **The section's steps become the manual note**, via `config.notes`, which the Run Report already
   renders. No UI change is needed.
4. **Planned last.** They depend on nothing and nothing depends on them; putting them after the real
   plan keeps the automated sequence untouched.
5. **No `requiresApproval`.** These are checklist items, not destructive automation.

## Global Constraints

- Web-only. **No runner change, no `runner/VERSION` bump, no migration.**
- Baseline to beat: web **2186 pass / 6 known fail**.

---

### Task 1: The pure helper

**Files:**
- Create: `web/lib/cases/unmodeled-steps.ts`
- Test: `web/lib/cases/unmodeled-steps.test.ts`

**Interfaces:**
- Produces:
  `export const UNMODELED_PREFIX = "unmodeled:"`,
  `export function unmodeledStepKey(title: string, taken: Set<string>): string`,
  `export function unmodeledManualJobs(sections: UnmodeledSection[], startSequence: number): PlannedJob[]`,
  `export function unmodeledStepTitle(request: unknown): string | null`

- [ ] **Step 1: Write the failing tests**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { unmodeledManualJobs, unmodeledStepKey, unmodeledStepTitle, UNMODELED_PREFIX } from "./unmodeled-steps";

test("a section becomes one manual job carrying its steps as the note", () => {
  const jobs = unmodeledManualJobs([{ title: "Dropsuite", steps: ["Add the mailbox", "Confirm the backup"], guess: null }], 5);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].mode, "manual");
  assert.equal(jobs[0].systemKey, "unmodeled:dropsuite");
  assert.equal(jobs[0].sequence, 5);
  assert.deepEqual(jobs[0].dependsOn, []);          // depends on nothing
  assert.equal(jobs[0].requiresApproval, false);    // a checklist item, not destructive automation
  const cfg = jobs[0].config as { title: string; notes: string[] };
  assert.equal(cfg.title, "Dropsuite");
  assert.deepEqual(cfg.notes, ["Add the mailbox", "Confirm the backup"]);
});

test("the key is stable across runs — a re-plan must keep a ticked step ticked", () => {
  // replanCaseJobs keys kept jobs by systemKey. A key that drifted would recreate a completed
  // checklist item as untouched work on the next re-plan.
  const a = unmodeledManualJobs([{ title: "SalesForce (If requested)", steps: [], guess: null }], 0);
  const b = unmodeledManualJobs([{ title: "SalesForce (If requested)", steps: [], guess: null }], 0);
  assert.equal(a[0].systemKey, b[0].systemKey);
  assert.equal(a[0].systemKey, "unmodeled:salesforce-if-requested");
});

test("two sections that slug the same stay distinct", () => {
  const jobs = unmodeledManualJobs([
    { title: "Box", steps: ["a"], guess: null },
    { title: "Box!", steps: ["b"], guess: null },
  ], 0);
  assert.equal(jobs[0].systemKey, "unmodeled:box");
  assert.equal(jobs[1].systemKey, "unmodeled:box-2");
});

test("a section with no usable title is dropped rather than keyed to the bare prefix", () => {
  assert.deepEqual(unmodeledManualJobs([{ title: "   ", steps: ["x"], guess: null }], 0), []);
  assert.deepEqual(unmodeledManualJobs([{ title: "!!!", steps: ["x"], guess: null }], 0), []);
});

test("a section with no steps still becomes a job — the title IS the instruction", () => {
  const jobs = unmodeledManualJobs([{ title: "Greenstreet", steps: [], guess: null }], 0);
  assert.equal(jobs.length, 1);
  assert.deepEqual((jobs[0].config as { notes: string[] }).notes, ["Greenstreet"]);
});

test("a vendor guess is recorded so the step says what it probably is", () => {
  const jobs = unmodeledManualJobs([{ title: "Box", steps: ["Add the user"], guess: "Box (storage)" }], 0);
  const cfg = jobs[0].config as { guess: string | null };
  assert.equal(cfg.guess, "Box (storage)");
});

test("sequences increment from the start point so they land after the real plan", () => {
  const jobs = unmodeledManualJobs([
    { title: "Box", steps: [], guess: null },
    { title: "Verizon", steps: [], guess: null },
  ], 7);
  assert.deepEqual(jobs.map((j) => j.sequence), [7, 8]);
});

test("unmodeledStepTitle reads the label back off a planned job's request", () => {
  assert.equal(unmodeledStepTitle({ config: { title: "Visual Studio Subscriptions" } }), "Visual Studio Subscriptions");
  assert.equal(unmodeledStepTitle({ config: {} }), null);
  assert.equal(unmodeledStepTitle(null), null);
});

test("the prefix is what marks the class", () => {
  assert.ok(unmodeledStepKey("Box", new Set()).startsWith(UNMODELED_PREFIX));
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `cd web && npx tsx --test lib/cases/unmodeled-steps.test.ts` — FAIL, module does not exist.

- [ ] **Step 3: Write the module**

```typescript
import type { PlannedJob } from "../orchestrator";

// A runbook section the extractor could not map to a known system (RunbookSection.status
// "unmodeled"): real work — Dropsuite, Box, Verizon, LogMeIn — that the planner never saw, because
// planCase reads ClientSystem rows and nothing read the sections. So it vanished off the case
// entirely (FR #0000096). Each one becomes a MANUAL job: a manual job holds the case at
// "needs_manual" until an operator ticks it (runner-logic.ts), which is exactly "an untouched one
// holds the case open".
export const UNMODELED_PREFIX = "unmodeled:";

export type UnmodeledSection = { title: string; steps: string[]; guess: string | null };

// Job.systemKey is a plain String, not a foreign key, so a synthetic key is safe. It must be STABLE
// across re-plans: replanCaseJobs keys kept jobs by systemKey, so a key that drifted would recreate
// a ticked-off checklist item as untouched work every time the case was re-planned.
export function unmodeledStepKey(title: string, taken: Set<string>): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!slug) return "";
  let key = `${UNMODELED_PREFIX}${slug}`;
  for (let n = 2; taken.has(key); n++) key = `${UNMODELED_PREFIX}${slug}-${n}`;
  taken.add(key);
  return key;
}

// The section's own title, read back off a planned job — the Run Report shows this rather than the
// slugged key.
export function unmodeledStepTitle(request: unknown): string | null {
  const cfg = ((request ?? {}) as { config?: unknown }).config as { title?: unknown } | undefined;
  return typeof cfg?.title === "string" && cfg.title.trim() ? cfg.title.trim() : null;
}

export function unmodeledManualJobs(sections: UnmodeledSection[], startSequence: number): PlannedJob[] {
  const taken = new Set<string>();
  const out: PlannedJob[] = [];
  for (const s of sections) {
    const title = (s.title ?? "").trim();
    const systemKey = unmodeledStepKey(title, taken);
    if (!systemKey) continue; // nothing usable to key on — a heading of punctuation, not a step
    const steps = (s.steps ?? []).map((x) => String(x).trim()).filter(Boolean);
    out.push({
      systemKey,
      sequence: startSequence + out.length,
      mode: "manual",
      requiresApproval: false, // a checklist item, not destructive automation
      captureEvidence: false,
      intent: null,
      secretNames: [],
      dependsOn: [], // depends on nothing, and nothing depends on it
      // notes are what the Run Report renders for a manual step (manualNotesOf). With no steps the
      // title is the whole instruction, so it becomes the note itself.
      config: { title, guess: s.guess ?? null, notes: steps.length ? steps : [title], unmodeled: true },
    });
  }
  return out;
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd web && npx tsx --test lib/cases/unmodeled-steps.test.ts` — all PASS.

```bash
git add web/lib/cases/unmodeled-steps.ts web/lib/cases/unmodeled-steps.test.ts
git commit -m "FR #96 (1/3): turn an unmodeled runbook section into a manual job"
```

---

### Task 2: Plan them, on both paths

**Files:**
- Modify: `web/lib/cases/repository.ts` (a loader both services can call)
- Modify: `web/lib/cases/planning-service.ts`
- Modify: `web/lib/cases/replan-service.ts`

- [ ] **Step 1: Add the loader**

In `makeCaseRepository`, beside the other planning reads:

```typescript
    // Sections the extractor could not map to a system. The planner turns each into a manual
    // checklist step (FR #0000096); nothing else reads them at plan time.
    async unmodeledSections(clientId: string, action: Action) {
      const rows = await db.runbookSection.findMany({
        where: { clientId, action, status: "unmodeled" },
        orderBy: { seq: "asc" },
        select: { title: true, steps: true, guess: true },
      });
      return rows.map((r) => ({ title: r.title, steps: r.steps ?? [], guess: r.guess ?? null }));
    },
```

- [ ] **Step 2: Append them in `planning-service.ts`**

After the existing `const planned = resolvePlannedConfigs(...)`:

```typescript
  // Unmodeled runbook sections become manual checklist steps, planned LAST — they depend on nothing
  // and nothing depends on them, so the automated sequence is untouched (FR #0000096).
  const unmodeled = unmodeledManualJobs(
    await repo.unmodeledSections(client.id, input.action),
    planned.reduce((m, j) => Math.max(m, j.sequence), -1) + 1
  );
  const plannedAll = [...planned, ...unmodeled];
```

Then use `plannedAll` in `deriveStatus` and `createCaseWithJobs`.

- [ ] **Step 3: Append them in `replan-service.ts`**

The same two lines after its `resolvePlannedConfigs`, using `info.client.id` and `action`, feeding
`deriveStatus` and `replanCaseJobs`. The stable key means a ticked step stays ticked.

- [ ] **Step 4: Verify and commit**

Run: `cd web && npm test` and `npx tsc --noEmit -p tsconfig.json`.

```bash
git add web/lib/cases/
git commit -m "FR #96 (2/3): plan unmodeled sections as manual steps on both planning paths"
```

---

### Task 3: Label them, and the changelog

**Files:**
- Modify: `web/lib/cases/run-report.ts` and `web/lib/cases/repository.ts` (step naming)
- Create + register the changelog entry

- [ ] **Step 1: Show the section title, not the slug**

Both name lookups currently read `names.get(key) ?? ADHOC_STEP_LABELS[key] ?? key`, which would show
`unmodeled:visual-studio-subscriptions`. Prefer the title carried on the job:

```typescript
      systemName: unmodeledStepTitle(j.request) ?? input.names.get(j.systemKey) ?? ADHOC_STEP_LABELS[j.systemKey] ?? j.systemKey,
```

and the equivalent at `repository.ts:900`.

- [ ] **Step 2: Changelog**

```typescript
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "unmodeled-steps-become-manual",
  date: "2026-09-01",
  time: "10:00",
  title: "Runbook steps we haven't automated now appear on the case as manual work",
  items: [
    "A runbook section the engine hasn't modelled as a system — Dropsuite, Box, Verizon, LogMeIn, SalesForce — used to vanish off the case entirely. It now appears as a manual step with the runbook's own instructions, so the Run Report is the whole checklist. (FR #0000096)",
    "The step holds the case open until you tick it off, the same as any other manual step, and un-ticking works if you tick one by mistake",
    "241 of these exist across 134 client-and-action pairs, so most cases gain one step and a few gain several — the worst is ten. They were always work someone had to do; they just weren't written down anywhere the case could see",
    "Web-only — no runner change",
  ],
};
```

- [ ] **Step 3: Verify and commit**

---

## Out of scope, deliberately

- **No change to extraction or classification.** Which sections are unmodeled is already decided
  correctly; this only stops the answer being thrown away.
- **No per-client toggle.** Confirmed with the requester: all clients at once.
- **No auto-modelling.** A `guess` is recorded on the step, not acted on.

## Risks

- **134 client+action pairs change behaviour on merge.** Cases that complete cleanly today will hold at
  "needs manual" until someone ticks the new steps. That is the requested behaviour, but it is a real
  operational change and worth watching for the first day.
- **A stale runbook adds stale steps.** If a section describes work no longer done, it now appears on
  every case until the runbook is corrected. The fix is the runbook, not the planner.
