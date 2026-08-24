# Case-requested mail forwarding is actually applied (FR #97) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When an offboarding ticket asks for the leaver's mail to be forwarded, actually forward it.

**Architecture:** Pure plan-time injection in `web/lib/profiles/plan-resolve.ts`, structurally identical
to the FR #47 out-of-office fix directly above it. No runner change: the Exchange executor has always
implemented the destination.

**Tech Stack:** TypeScript, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 3)

## Diagnosis (confirmed 2026-08-24)

The spec's reading holds exactly, and this is the third instance of the same captured-and-dropped shape
(after #47 and #84).

- **The runner has always been able to do it.** `Coretelligent.Exchange.psm1:1176-1182`, "3. On-request
  forwarding", reads `config.forwarding.{address,keepCopy}` and calls
  `Set-Mailbox -ForwardingSmtpAddress -DeliverToMailboxAndForward`.
- **The intake has always captured it.** `intake-mapper.ts:300-301` writes
  `mailForwarded` (`u_mail_forwarded`) and `forwardEmailTo` (`u_forward_email_to`).
- **Nothing joins the two.** The only `forwarding` reference in `web/lib` is `exchange-preview.ts`, which
  renders a preview of what the runner *would* do. `mailForwarded` and `forwardEmailTo` are referenced
  by nothing but their own mapper tests. The runner's forwarding branch is unreachable from the app.

### What the real data looks like

25 recent cases carry `forwardEmailTo`. **Every one** is in the resolved-email shape
`address (sys_id)` — e.g. `lyao@aleto.co (55ebb6d847383d1418d7d65c346d4354)` (UM0030279, the case #97
was filed from). None is a bare display name or a bare sys_id, so `refLabel`'s
`contactEmail` branch is winning in practice and this stays a web-only fix.

**`mailForwarded` is a real gate, not decoration.** Two of those 25 — UM0030515 and UM0030178 — carry a
populated `forwardEmailTo` with `mailForwarded = false`. Planning forwarding off the address alone would
silently forward a leaver's mail on cases where the requester explicitly said not to. That is worse than
the bug being fixed.

### Decisions

1. **Gate on `mailForwarded === true`.** An address alone is not a request.
2. **Extract the address from the label**, stripping the trailing ` (sys_id)`. Accept the result only if
   it actually looks like an email; a display name is not an SMTP address and must never reach
   `-ForwardingSmtpAddress`. Unparseable means plan nothing (see the limitation below).
3. **Do not invent a `keepCopy` policy.** There is no intake field for it. Merge into any existing
   `cfg.forwarding` so a profile-set `keepCopy` survives, exactly as the #47 fix merges into
   `cfg.autoReply` and only sets `message`. Absent means the runner's existing default.
4. **Do not gate on the profile's `onRequest` array.** Five profiles list `"email-forwarding"` there, but
   `onRequest` is consumed by no code anywhere — it is runbook documentation. #47 shipped without
   gating on `"ooo-message"`, and gating here would silently drop requests for every client that
   happens not to list it.
5. **Exchange lane only.** It is the only lane that can set mailbox forwarding.

### Known limitation, recorded deliberately

If `mailForwarded` is true but the target cannot be parsed as an email (a display name, or a bare
sys_id), nothing is planned and the case does not say so. That is a silent skip, which this batch
generally treats as a defect — it is accepted here only because it occurs in 0 of 25 real cases, and
because the honest fix is a first-class manual job, which is **#96's** scope and machinery. Note it in
the resolution note rather than half-building it here.

## Global Constraints

- **No runner change**, therefore **no `runner/VERSION` bump** and no deploy. If a task finds itself
  editing a `.psm1`, stop — the destination already exists.
- Baseline to beat: web **2149 pass / 6 known fail**.

---

### Task 1: Plan the forwarding address onto the Exchange offboard job

**Files:**
- Modify: `web/lib/profiles/plan-resolve.ts` (add exported helper; inject after the FR #47 OOO block)
- Test: `web/lib/profiles/plan-resolve.offboard.test.ts`

**Interfaces:**
- Produces: `export function caseForwardingAddress(payload: Record<string, unknown>): string | null`
  — the SMTP address to forward to, or null when not requested / not parseable.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/profiles/plan-resolve.offboard.test.ts`:

```typescript
import { caseForwardingAddress } from "./plan-resolve";

const exch = (config: unknown): PlannedJob => ({ systemKey: "exchange", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config });
const bare = { globals: {}, globalsOffboard: {}, personas: {} };

test("caseForwardingAddress: strips the sys_id the intake appends for display", () => {
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb6d847383d1418d7d65c346d4354)" }), "lyao@aleto.co");
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "  lyao@aleto.co  " }), "lyao@aleto.co");
});

test("caseForwardingAddress: an address alone is NOT a request — mailForwarded gates it", () => {
  // UM0030515 and UM0030178 are real cases shaped exactly like this. Forwarding a leaver's mail
  // against an explicit "no" is worse than the bug this fixes.
  assert.equal(caseForwardingAddress({ mailForwarded: false, forwardEmailTo: "brandon@drivecapital.com (af605134db3b15d0887192ccd3961959)" }), null);
  assert.equal(caseForwardingAddress({ forwardEmailTo: "brandon@drivecapital.com" }), null);
});

test("caseForwardingAddress: a display name or a bare sys_id is not an SMTP address", () => {
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "Andrew Cohen (sysid123)" }), null);
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "sysidonly" }), null);
  assert.equal(caseForwardingAddress({ mailForwarded: true, forwardEmailTo: "" }), null);
  assert.equal(caseForwardingAddress({ mailForwarded: true }), null);
});

test("offboard plans the case-requested forwarding onto the exchange step (FR #0000097)", () => {
  const out = resolvePlannedConfigs(bare, { mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb)" }, "offboard", [exch({ convertToShared: true })]);
  const cfg = out[0].config as Record<string, unknown>;
  assert.deepEqual(cfg.forwarding, { address: "lyao@aleto.co" });
  assert.equal(cfg.convertToShared, true); // the rest of the config survives
});

test("offboard forwarding keeps a profile-configured keepCopy and only sets the address", () => {
  const out = resolvePlannedConfigs(bare, { mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb)" }, "offboard", [exch({ forwarding: { keepCopy: true } })]);
  assert.deepEqual((out[0].config as Record<string, unknown>).forwarding, { keepCopy: true, address: "lyao@aleto.co" });
});

test("offboard leaves forwarding alone when the ticket did not ask for it", () => {
  const out = resolvePlannedConfigs(bare, { mailForwarded: false, forwardEmailTo: "x@y.com (id)" }, "offboard", [exch({ convertToShared: true })]);
  assert.equal((out[0].config as Record<string, unknown>).forwarding, undefined);
});

test("offboard forwarding is exchange-only — the m365 lane is untouched", () => {
  const m365 = { systemKey: "m365", sequence: 0, mode: "api", requiresApproval: false, captureEvidence: false, intent: null, secretNames: [], dependsOn: [], config: {} } as PlannedJob;
  const out = resolvePlannedConfigs(bare, { mailForwarded: true, forwardEmailTo: "lyao@aleto.co (55ebb)" }, "offboard", [m365]);
  assert.equal((out[0].config as Record<string, unknown>).forwarding, undefined);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web && npx tsx --test lib/profiles/plan-resolve.offboard.test.ts`

Expected: FAIL — `caseForwardingAddress` is not exported yet.

- [ ] **Step 3: Add the pure helper**

In `web/lib/profiles/plan-resolve.ts`, above `resolvePlannedConfigs`:

```typescript
// The intake stores a reference field for DISPLAY: "lyao@aleto.co (55ebb6d8…)" — refLabel appends the
// sys_id so the record stays lookup-able. -ForwardingSmtpAddress needs the address alone.
const SYS_ID_SUFFIX = /\s*\([0-9a-f]{32}\)\s*$|\s*\([^()]*\)\s*$/i;
// Deliberately strict: a DISPLAY NAME is not an SMTP address, and handing one to Exchange would fail
// the step (or worse, silently target nothing). Local@domain.tld, no whitespace.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// The forwarding target an offboard ticket asked for, or null when it asked for none.
export function caseForwardingAddress(payload: Record<string, unknown>): string | null {
  // An address alone is NOT a request. Real cases (UM0030515, UM0030178) carry a populated target with
  // mailForwarded=false — forwarding a leaver's mail against an explicit "no" would be worse than the
  // bug this fixes.
  if (payload.mailForwarded !== true) return null;
  const raw = typeof payload.forwardEmailTo === "string" ? payload.forwardEmailTo.trim() : "";
  if (!raw) return null;
  const addr = raw.replace(SYS_ID_SUFFIX, "").trim();
  return LOOKS_LIKE_EMAIL.test(addr) ? addr : null;
}
```

- [ ] **Step 4: Inject it onto the exchange job**

In `resolvePlannedConfigs`, replace the final `return injectHideFromGal(withOoo, payload, client.backbone);`
with the forwarding step in front of it:

```typescript
  // Case-requested mail forwarding (FR #0000097, and #0000099 filed as the same defect): the intake
  // captures both halves — u_mail_forwarded -> payload.mailForwarded and u_forward_email_to ->
  // payload.forwardEmailTo — and NOTHING read either. The Exchange executor has always implemented the
  // destination (config.forwarding.address -> Set-Mailbox -ForwardingSmtpAddress), so like FR #47 above
  // the entire gap was plan-time and no runner change is needed.
  //
  // MERGE rather than replace, for the same reason the OOO block merges: a profile that configured
  // keepCopy keeps it, and the ticket supplies only the address. There is no intake field for keepCopy,
  // so inventing a policy here would be guessing on the leaver's mail.
  const fwd = caseForwardingAddress(payload);
  const withForwarding = !fwd ? withOoo : withOoo.map((j) => {
    if (j.systemKey !== "exchange") return j; // the only lane that can set mailbox forwarding
    const cfg = (j.config as Record<string, unknown> | null) ?? {};
    return { ...j, config: { ...cfg, forwarding: { ...((cfg.forwarding as Record<string, unknown> | null) ?? {}), address: fwd } } };
  });

  return injectHideFromGal(withForwarding, payload, client.backbone);
```

- [ ] **Step 5: Run the tests**

Run: `cd web && npx tsx --test lib/profiles/plan-resolve.offboard.test.ts`

Expected: all PASS.

- [ ] **Step 6: Run the whole suite**

Run: `cd web && npm test`

Expected: 2149 + 7 new = **2156 pass**, the same 6 known failures, no new ones.

- [ ] **Step 7: Commit**

```bash
git add web/lib/profiles/plan-resolve.ts web/lib/profiles/plan-resolve.offboard.test.ts
git commit -m "FR #97: an offboard actually applies the mail forwarding the ticket asked for"
```

---

### Task 2: Changelog

**Files:**
- Create: `web/lib/changelog/entries/case-requested-mail-forwarding.ts`
- Modify: `web/lib/changelog/entries/_registry.ts` (one line)

- [ ] **Step 1: Write the entry**

```typescript
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "case-requested-mail-forwarding",
  date: "2026-08-24",
  time: "16:00",
  title: "An offboard applies the mail forwarding the ticket asked for",
  items: [
    "A ticket could ask for the leaver's mail to be forwarded and nothing happened — no step, no error, no note. (FR #0000097, and #0000099 filed as the same defect)",
    "Both halves already existed and had simply never been joined: the intake has always captured \"mail forwarded\" and \"forward email to\", and the Exchange step has always known how to set forwarding. Nothing in between ever passed one to the other, so the runner's forwarding branch could not be reached",
    "The forwarding target is now planned onto the Exchange step, with the sys_id the intake appends for display stripped off first — Exchange needs the address by itself",
    "It is applied ONLY when the ticket's \"mail forwarded\" box is ticked. A target address on its own is not a request, and two recent cases had one filled in alongside an explicit no",
    "A client that has configured \"keep a copy in the mailbox\" keeps that setting; the ticket supplies only the address",
    "No runner release needed — this was entirely a plan-time gap, the third of this exact shape after the out-of-office fix (#0000047) and mailbox delegates (#0000084)",
  ],
};
```

- [ ] **Step 2: Register it**

Add to `_registry.ts`, next to its neighbours:

```typescript
export { entry as caseRequestedMailForwarding } from "./case-requested-mail-forwarding";
```

- [ ] **Step 3: Verify and commit**

Run: `cd web && npm test` — expected 2156 pass / 6 known failures.

```bash
git add web/lib/changelog/entries/
git commit -m "Changelog for case-requested mail forwarding"
```

---

## Out of scope, deliberately

- **No runner change.** `Coretelligent.Exchange.psm1` already implements the destination; touching it
  would mean a version bump and a fleet deploy for nothing.
- **No `keepCopy` intake field.** There is none today, and adding one is a ServiceNow form change, not
  a code change.
- **No manual-job fallback** for an unparseable target — that is #96's machinery. Recorded as a
  limitation on the request instead of half-built here.

## Risks

- **Forwarding a leaver's mail is a data-disclosure action.** The `mailForwarded` gate is the control
  that keeps it to tickets that actually asked, and it has its own test built from two real cases.
- **A display name reaching Exchange** would fail the step. The strict email check prevents it; the cost
  is the silent-skip limitation recorded above.
