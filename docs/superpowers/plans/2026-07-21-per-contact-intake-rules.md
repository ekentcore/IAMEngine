# Per-contact intake rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator configure per-client "intake rules" so that when a specific ServiceNow contact submits an onboard case, the plan skips named systems (e.g. Active Directory + directory-sync) and forces an email domain (e.g. shawmutinfinite.com); every other requester gets the normal plan.

**Architecture:** Store an ordered rule list on `Client.intakeRules` (JSON). A pure `matchIntakeRule(intakeRules, payload)` runs at the shared plan/replan path: it forces the email/UPN domain *before* identity derivation and threads the matched rule's `skipSystems` into `planCase`, which then omits those lanes and their synthetic AD steps. A "Populate from ServiceNow" contact picker (backed by a `customer_contact` query) feeds the rule editor. The matched rule is stamped on the case payload for provenance.

**Tech Stack:** Next.js (App Router, TypeScript) + Prisma + PostgreSQL; ServiceNow Table API; Node's built-in test runner (`node:test` + `node:assert/strict`) via `tsx`.

## Global Constraints

- Feature request: **#0000019** — Shawmut Corporation (`core2107`, CORE2107).
- **Onboard-only.** No offboard behavior changes.
- Trigger is strictly **the requesting contact's sys_id**, never the client generally or the new user's domain.
- Rule effects are **configurable data**: `skipSystems: string[]` + `forceDomain: string`. No hardcoded "cloud-only" preset.
- Rules evaluate **in order; first match wins**; a single matched rule is applied.
- All new tests use `node:test` + `node:assert/strict`, colocated as `*.test.ts` under `web/lib/`. Run all: `cd web && npm test`. Run one file: `cd web && npx tsx --test lib/<path>.test.ts`.
- Config write routes gate on `guard("client.edit_systems")`; reads on `guardAuth()`; all client routes are scope-gated via `clientSlugInScope`. Every config write logs an `AuditLog` row via `repo.writeAudit`.
- ServiceNow config comes from `snConfigFromEnv()`. Any sys_id interpolated into a ServiceNow query MUST be validated `^[0-9a-f]{32}$` first (query-injection defense, matching `fetchAccountContactEmails`).
- UI follows the host design system: flat, minimal borders, sentence case, no gradients.

---

### Task 1: Add `Client.intakeRules` column + migration

**Files:**
- Modify: `web/prisma/schema.prisma` (the `Client` model, near `locations Json?` ~line 100)
- Create: `web/prisma/migrations/<timestamp>_client_intake_rules/migration.sql`

**Interfaces:**
- Produces: `Client.intakeRules: Prisma.JsonValue | null` — the ordered rule list.

- [ ] **Step 1: Add the column to the Prisma schema**

In `web/prisma/schema.prisma`, in the `Client` model, immediately after the `locations Json?` line, add:

```prisma
  // Per-contact intake rules (FR #0000019): when a configured ServiceNow contact submits an onboard
  // case, skip named systems and force an email domain. Shape:
  // { rules: [ { id, label, match: { contacts: [{ sysId, name }] }, effects: { skipSystems: string[], forceDomain: string } } ] }
  // First matching rule wins; onboard-only. Evaluated in matchIntakeRule at plan/replan time.
  intakeRules            Json?
```

- [ ] **Step 2: Create the migration SQL**

Create `web/prisma/migrations/20260721160000_client_intake_rules/migration.sql`:

```sql
-- Per-contact intake rules (FR #0000019)
ALTER TABLE "Client" ADD COLUMN "intakeRules" JSONB;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `cd web && npx prisma generate`
Expected: "Generated Prisma Client" with no errors.

> **Do NOT run `prisma migrate dev`** against the shared dev DB. The SQL file above is applied by the normal deploy path; regenerating the client is enough to compile against the new field locally.

- [ ] **Step 4: Verify it compiles**

Run: `cd web && npx tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no error mentioning `intakeRules`.

- [ ] **Step 5: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/20260721160000_client_intake_rules
git commit -m "feat(db): add Client.intakeRules column (FR #0000019)"
```

---

### Task 2: `intake-rules.ts` — types + `matchIntakeRule`

**Files:**
- Create: `web/lib/profiles/intake-rules.ts`
- Test: `web/lib/profiles/intake-rules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type IntakeRuleContact = { sysId: string; name: string }`
  - `type IntakeRule = { id: string; label: string; match: { contacts: IntakeRuleContact[] }; effects: { skipSystems: string[]; forceDomain: string | null } }`
  - `type IntakeRulesDoc = { rules: IntakeRule[] }`
  - `type MatchedIntakeRule = { id: string; label: string; skipSystems: ReadonlySet<string>; forceDomain: string | null }`
  - `function parseIntakeRules(value: unknown): IntakeRulesDoc` — tolerant parse (never throws; bad input → `{ rules: [] }`).
  - `function matchIntakeRule(intakeRules: unknown, payload: Record<string, unknown>): MatchedIntakeRule | null` — first rule any of whose `match.contacts[].sysId` equals `payload.requestedByContactSysId` or `payload.openedBySysId`; else `null`.

- [ ] **Step 1: Write the failing test**

Create `web/lib/profiles/intake-rules.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIntakeRule, parseIntakeRules } from "./intake-rules";

const shawmut = {
  rules: [
    {
      id: "shawmut-infinite",
      label: "Shawmut Infinite (cloud-only)",
      match: { contacts: [{ sysId: "7750e1e447bdf29c3c5e88f4116d4393", name: "Angie Shropshire" }] },
      effects: { skipSystems: ["active-directory", "directory-sync"], forceDomain: "shawmutinfinite.com" },
    },
  ],
};

test("matches on requestedByContactSysId", () => {
  const m = matchIntakeRule(shawmut, { requestedByContactSysId: "7750e1e447bdf29c3c5e88f4116d4393" });
  assert.ok(m);
  assert.equal(m!.id, "shawmut-infinite");
  assert.equal(m!.forceDomain, "shawmutinfinite.com");
  assert.ok(m!.skipSystems.has("active-directory"));
  assert.ok(m!.skipSystems.has("directory-sync"));
});

test("matches on openedBySysId fallback", () => {
  const m = matchIntakeRule(shawmut, { openedBySysId: "7750e1e447bdf29c3c5e88f4116d4393" });
  assert.equal(m?.id, "shawmut-infinite");
});

test("no match for a different requester", () => {
  assert.equal(matchIntakeRule(shawmut, { requestedByContactSysId: "0000000000000000000000000000dead" }), null);
});

test("first matching rule wins", () => {
  const doc = {
    rules: [
      { id: "a", label: "A", match: { contacts: [{ sysId: "aa", name: "x" }] }, effects: { skipSystems: ["s1"], forceDomain: "a.com" } },
      { id: "b", label: "B", match: { contacts: [{ sysId: "aa", name: "x" }] }, effects: { skipSystems: ["s2"], forceDomain: "b.com" } },
    ],
  };
  assert.equal(matchIntakeRule(doc, { requestedByContactSysId: "aa" })?.id, "a");
});

test("null / malformed rules → null", () => {
  assert.equal(matchIntakeRule(null, { requestedByContactSysId: "aa" }), null);
  assert.equal(matchIntakeRule({ rules: "nope" }, { requestedByContactSysId: "aa" }), null);
  assert.equal(matchIntakeRule({}, { requestedByContactSysId: "aa" }), null);
});

test("no requester keys on payload → null", () => {
  assert.equal(matchIntakeRule(shawmut, {}), null);
});

test("parseIntakeRules tolerates junk", () => {
  assert.deepEqual(parseIntakeRules(undefined), { rules: [] });
  assert.deepEqual(parseIntakeRules({ rules: [{ id: "x" }] }).rules.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/profiles/intake-rules.test.ts`
Expected: FAIL — cannot find module `./intake-rules`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/profiles/intake-rules.ts`:

```ts
// Per-contact intake rules (FR #0000019). When a configured ServiceNow contact submits an ONBOARD
// case, the plan skips named systems (e.g. active-directory + directory-sync) and forces an email
// domain (e.g. shawmutinfinite.com). Everyone else falls through to the client's normal plan.
//
// Stored on Client.intakeRules as { rules: IntakeRule[] }; evaluated here at plan/replan time.
// First matching rule wins. Match is on the requesting contact's sys_id only.

export type IntakeRuleContact = { sysId: string; name: string };
export type IntakeRule = {
  id: string;
  label: string;
  match: { contacts: IntakeRuleContact[] };
  effects: { skipSystems: string[]; forceDomain: string | null };
};
export type IntakeRulesDoc = { rules: IntakeRule[] };
export type MatchedIntakeRule = {
  id: string;
  label: string;
  skipSystems: ReadonlySet<string>;
  forceDomain: string | null;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Tolerant parse: any malformed input yields { rules: [] } (a client with no rules is the norm).
export function parseIntakeRules(value: unknown): IntakeRulesDoc {
  const raw = (value ?? null) as { rules?: unknown } | null;
  const list = raw && Array.isArray(raw.rules) ? raw.rules : [];
  const rules: IntakeRule[] = [];
  for (const r of list) {
    const o = (r ?? {}) as Record<string, unknown>;
    const match = (o.match ?? {}) as { contacts?: unknown };
    const effects = (o.effects ?? {}) as { skipSystems?: unknown; forceDomain?: unknown };
    const contacts = Array.isArray(match.contacts)
      ? match.contacts
          .map((c) => ({ sysId: str((c as Record<string, unknown>)?.sysId), name: str((c as Record<string, unknown>)?.name) }))
          .filter((c) => c.sysId !== "")
      : [];
    const skipSystems = Array.isArray(effects.skipSystems)
      ? effects.skipSystems.map(str).filter((s) => s !== "")
      : [];
    const forceDomain = str(effects.forceDomain) || null;
    rules.push({
      id: str(o.id) || `rule-${rules.length}`,
      label: str(o.label) || "Intake rule",
      match: { contacts },
      effects: { skipSystems, forceDomain },
    });
  }
  return { rules };
}

// First rule any of whose contacts' sysId equals the payload's requesting-contact sys_id
// (requestedByContactSysId primary, openedBySysId fallback). Null when none match.
export function matchIntakeRule(
  intakeRules: unknown,
  payload: Record<string, unknown>,
): MatchedIntakeRule | null {
  const keys = [payload.requestedByContactSysId, payload.openedBySysId]
    .map((v) => (typeof v === "string" ? v : ""))
    .filter((v) => v !== "");
  if (keys.length === 0) return null;
  const { rules } = parseIntakeRules(intakeRules);
  for (const rule of rules) {
    if (rule.match.contacts.some((c) => keys.includes(c.sysId))) {
      return {
        id: rule.id,
        label: rule.label,
        skipSystems: new Set(rule.effects.skipSystems),
        forceDomain: rule.effects.forceDomain,
      };
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/profiles/intake-rules.test.ts`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/profiles/intake-rules.ts web/lib/profiles/intake-rules.test.ts
git commit -m "feat(plan): matchIntakeRule + IntakeRules types (FR #0000019)"
```

---

### Task 3: Capture the requester's sys_id at intake

**Files:**
- Modify: `web/lib/servicenow/intake.ts` (`INTAKE_FIELDS`, ~line 9-42)
- Modify: `web/lib/servicenow/intake-mapper.ts` (`onboardPayload`, the `requestedBy:` line ~222)
- Test: `web/lib/servicenow/intake-requester.test.ts`

**Interfaces:**
- Consumes: `SnUserMgmtRecord` fields (`opened_by`, `contact`).
- Produces: onboard payload gains `requestedBySysId` (contact reference sys_id), `openedBySysId` (opened_by sys_id). Both `string | null`.

> The picker resolves **customer_contact** sys_ids. `contact` on the case is the customer_contact reference; `opened_by` is a `sys_user` reference (kept as a secondary key). We capture both so matching is robust regardless of which one carries the requester. `payload.requestedBySysId` is the value `matchIntakeRule` reads as `requestedByContactSysId`? — NO: keep names aligned. This task writes `requestedByContactSysId` and `openedBySysId` (the exact keys `matchIntakeRule` reads in Task 2).

- [ ] **Step 1: Write the failing test**

Create `web/lib/servicenow/intake-requester.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntake } from "./intake-mapper";
import type { SnUserMgmtRecord } from "./intake";

function record(over: Partial<Record<string, { value: string; display_value: string }>>): SnUserMgmtRecord {
  const base: Record<string, { value: string; display_value: string }> = {
    number: { value: "UM1", display_value: "UM1" },
    subcategory: { value: "New User Request", display_value: "New User Request" },
    u_first: { value: "Kate", display_value: "Kate" },
    u_last: { value: "Doe", display_value: "Doe" },
    account: { value: "acct-sys-id", display_value: "Shawmut" },
    opened_by: { value: "user-sys-id-123", display_value: "Angie Shropshire" },
    contact: { value: "7750e1e447bdf29c3c5e88f4116d4393", display_value: "Angie Shropshire" },
  };
  return { ...base, ...over } as SnUserMgmtRecord;
}

test("onboard payload captures requester sys_ids", () => {
  const n = normalizeIntake(record({}));
  assert.equal(n.payload.requestedByContactSysId, "7750e1e447bdf29c3c5e88f4116d4393");
  assert.equal(n.payload.openedBySysId, "user-sys-id-123");
  assert.equal(n.payload.requestedBy, "Angie Shropshire"); // display name still present
});

test("absent requester fields → null, no throw", () => {
  const n = normalizeIntake(record({ contact: undefined, opened_by: undefined }));
  assert.equal(n.payload.requestedByContactSysId, null);
  assert.equal(n.payload.openedBySysId, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/servicenow/intake-requester.test.ts`
Expected: FAIL — `requestedByContactSysId` is `undefined`.

- [ ] **Step 3: Add `contact` to the fetched fields**

In `web/lib/servicenow/intake.ts`, in the `INTAKE_FIELDS` array, on the routing/identity line (currently `"number", "short_description", "subcategory", "account", "company", "opened_by",`), add `"contact"`:

```ts
  "number", "short_description", "subcategory", "account", "company", "opened_by", "contact",
```

- [ ] **Step 4: Capture the sys_ids in `onboardPayload`**

In `web/lib/servicenow/intake-mapper.ts`, in `onboardPayload`, find the line `requestedBy: disp(r, "opened_by"),` and add two lines immediately after it:

```ts
    requestedBy: disp(r, "opened_by"),
    // Requester sys_ids for per-contact intake rules (FR #0000019). `contact` is the customer_contact
    // reference (what the rule picker resolves); `opened_by` is the sys_user who opened the case (a
    // fallback match key). matchIntakeRule reads both.
    requestedByContactSysId: val(r, "contact"),
    openedBySysId: val(r, "opened_by"),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/servicenow/intake-requester.test.ts`
Expected: PASS — both tests.

- [ ] **Step 6: Run the existing intake tests (no regressions)**

Run: `cd web && npx tsx --test lib/servicenow/intake-fields.test.ts lib/servicenow/*.test.ts 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add web/lib/servicenow/intake.ts web/lib/servicenow/intake-mapper.ts web/lib/servicenow/intake-requester.test.ts
git commit -m "feat(intake): capture requester contact sys_ids (FR #0000019)"
```

---

### Task 4: `planCase` — `skipSystems` parameter

**Files:**
- Modify: `web/lib/orchestrator.ts` (`included()` ~line 97, `planCase` signature ~line 115, `active` filter ~line 130)
- Test: `web/lib/orchestrator.intake-skip.test.ts`

**Interfaces:**
- Consumes: existing `planCase` params.
- Produces: `planCase(systems, action, payload, personaSystems?, notNeededSecrets?, wiredOptional?, skipSystems?: ReadonlySet<string>)`. When a `systemKey` is in `skipSystems`, that system is excluded from the plan, and the synthetic `ad-email-writeback` / `ad-consistency-check` steps (which key off `active-directory` being active) are not injected.

- [ ] **Step 1: Write the failing test**

Create `web/lib/orchestrator.intake-skip.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planCase } from "./orchestrator";
import type { ClientSystem } from "@prisma/client";

function sys(systemKey: string, over: Partial<ClientSystem> = {}): ClientSystem {
  return {
    id: `id-${systemKey}`,
    clientId: "c1",
    systemKey,
    mode: "api",
    onboardWhen: "always",
    offboardWhen: "never",
    dependsOn: [],
    requiresApproval: false,
    captureEvidence: false,
    secretNames: [],
    config: null,
    ...over,
  } as unknown as ClientSystem;
}

const systems = [
  sys("active-directory"),
  sys("directory-sync"),
  sys("entra"),
  sys("m365"),
  sys("exchange"),
];

test("skipSystems drops the named lanes and the synthetic AD steps", () => {
  const planned = planCase(systems, "onboard", {}, undefined, undefined, undefined,
    new Set(["active-directory", "directory-sync"]));
  const keys = planned.map((j) => j.systemKey);
  assert.ok(!keys.includes("active-directory"));
  assert.ok(!keys.includes("directory-sync"));
  assert.ok(!keys.includes("ad-email-writeback"));
  assert.ok(!keys.includes("ad-consistency-check"));
  assert.ok(keys.includes("entra"));
  assert.ok(keys.includes("m365"));
  assert.ok(keys.includes("exchange"));
});

test("without skipSystems the AD lanes and synthetic steps are present", () => {
  const keys = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.ok(keys.includes("active-directory"));
  assert.ok(keys.includes("ad-email-writeback"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/orchestrator.intake-skip.test.ts`
Expected: FAIL — first test finds `active-directory` still present (7th arg ignored).

- [ ] **Step 3: Add the parameter and filter**

In `web/lib/orchestrator.ts`, extend the `planCase` signature. After the existing `wiredOptional?: ReadonlySet<string>` parameter, add:

```ts
  wiredOptional?: ReadonlySet<string>,
  // System keys to exclude from this plan regardless of onboardWhen (per-contact intake rules,
  // FR #0000019). Skipping active-directory also suppresses the synthetic ad-email-writeback /
  // ad-consistency-check steps, which only inject when active-directory is active.
  skipSystems?: ReadonlySet<string>
```

Then change the `active` filter line (currently `const active = systems.filter((s) => included(s, action, payload, personaSystems));`) to:

```ts
  const active = systems.filter(
    (s) => !skipSystems?.has(s.systemKey) && included(s, action, payload, personaSystems)
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/orchestrator.intake-skip.test.ts`
Expected: PASS — both tests.

- [ ] **Step 5: Run existing orchestrator tests (no regressions)**

Run: `cd web && npx tsx --test lib/orchestrator*.test.ts 2>&1 | tail -20`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add web/lib/orchestrator.ts web/lib/orchestrator.intake-skip.test.ts
git commit -m "feat(plan): planCase skipSystems parameter (FR #0000019)"
```

---

### Task 5: Apply the rule in planning + replan (force domain, skip systems, stamp provenance)

**Files:**
- Modify: `web/lib/cases/planning-service.ts` (domain block ~line 62-70, `planCase` call ~line 80)
- Modify: `web/lib/cases/replan-service.ts` (domain block ~line 57-58, `planCase` call ~line 61-62)
- Test: `web/lib/cases/planning-intake-rule.test.ts`

**Interfaces:**
- Consumes: `matchIntakeRule` (Task 2), `planCase` `skipSystems` param (Task 4).
- Produces: onboard plans for a rule-matched requester have no skipped systems and a UPN/work email on the forced domain, plus `payload.__intakeRule = { id, label }`.

> `clientForPlanning` must select `intakeRules`. Verify it uses `include`/`select` that already carries all Client scalar fields; if it uses an explicit `select`, add `intakeRules: true`. Check `web/lib/clients/repository.ts` `clientForPlanning`.

- [ ] **Step 1: Ensure `clientForPlanning` returns `intakeRules`**

Run: `cd web && grep -nE "clientForPlanning" lib/clients/repository.ts`

Open that method. If it uses an explicit `select`, add `intakeRules: true` to it. If it selects the whole client (no `select`) or uses `...`-spread of scalars, no change is needed. Also confirm the `ResolveClient` / `PlanClient` types don't need widening (they accept extra fields).

- [ ] **Step 2: Write the failing test**

Create `web/lib/cases/planning-intake-rule.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchIntakeRule } from "../profiles/intake-rules";
import { planCase } from "../orchestrator";
import { deriveIdentity } from "../servicenow/intake-mapper";
import type { ClientSystem } from "@prisma/client";

// This test exercises the exact composition planning-service performs (match → force domain →
// derive identity → planCase with skipSystems), without a DB.
function sys(systemKey: string): ClientSystem {
  return {
    id: `id-${systemKey}`, clientId: "c1", systemKey, mode: "api",
    onboardWhen: "always", offboardWhen: "never", dependsOn: [],
    requiresApproval: false, captureEvidence: false, secretNames: [], config: null,
  } as unknown as ClientSystem;
}
const systems = [sys("active-directory"), sys("directory-sync"), sys("entra"), sys("m365"), sys("exchange")];
const intakeRules = {
  rules: [{
    id: "shawmut-infinite", label: "Shawmut Infinite (cloud-only)",
    match: { contacts: [{ sysId: "7750e1e447bdf29c3c5e88f4116d4393", name: "Angie Shropshire" }] },
    effects: { skipSystems: ["active-directory", "directory-sync"], forceDomain: "shawmutinfinite.com" },
  }],
};

function compose(payload: Record<string, unknown>, defaultDomain: string) {
  const rule = matchIntakeRule(intakeRules, payload);
  const domain = rule?.forceDomain ?? defaultDomain;
  let p = deriveIdentity({ ...payload }, { usernamePatterns: ["{first}.{last}"], primaryDomain: domain });
  if (rule) p = { ...p, __intakeRule: { id: rule.id, label: rule.label } };
  const planned = planCase(systems, "onboard", p, undefined, undefined, undefined, rule?.skipSystems);
  return { planned, payload: p, rule };
}

test("matched requester → cloud-only plan on forced domain", () => {
  const { planned, payload } = compose(
    { firstName: "Kate", lastName: "Doe", requestedByContactSysId: "7750e1e447bdf29c3c5e88f4116d4393" },
    "shawmutcorporation.com",
  );
  const keys = planned.map((j) => j.systemKey);
  assert.ok(!keys.includes("active-directory"));
  assert.ok(!keys.includes("directory-sync"));
  assert.ok(!keys.includes("ad-email-writeback"));
  assert.ok(keys.includes("m365"));
  assert.match(String(payload.userPrincipalName), /@shawmutinfinite\.com$/);
  assert.match(String(payload.workEmail), /@shawmutinfinite\.com$/);
  assert.equal((payload.__intakeRule as { id: string }).id, "shawmut-infinite");
});

test("other requester → normal AD-synced plan on default domain", () => {
  const { planned, payload, rule } = compose(
    { firstName: "Bob", lastName: "Roe", requestedByContactSysId: "0000000000000000000000000000dead" },
    "shawmutcorporation.com",
  );
  assert.equal(rule, null);
  assert.ok(planned.map((j) => j.systemKey).includes("active-directory"));
  assert.match(String(payload.userPrincipalName), /@shawmutcorporation\.com$/);
  assert.equal(payload.__intakeRule, undefined);
});
```

> Confirm the field names `deriveIdentity` outputs (`userPrincipalName`, `workEmail`). Run `grep -nE "userPrincipalName|workEmail|primaryDomain" web/lib/servicenow/intake-mapper.ts` in `deriveIdentity`; adjust the asserted key names to match exactly before running.

- [ ] **Step 3: Run test to verify it fails or passes**

Run: `cd web && npx tsx --test lib/cases/planning-intake-rule.test.ts`
Expected: PASS once the field names match (this test validates the composition helpers from Tasks 2 & 4 are correct together). If it fails on a field name, fix the assertion, not the source.

- [ ] **Step 4: Wire the rule into `planning-service.ts`**

In `web/lib/cases/planning-service.ts`, locate:

```ts
  let domain = client.emailDomain ?? client.primaryDomain;
  if (input.action === "onboard" && opts?.resolveDomain) domain = await opts.resolveDomain(client);
  let payload =
    input.action === "onboard"
      ? deriveIdentity(input.payload, {
          usernamePatterns: identity.usernamePatterns ?? null,
          primaryDomain: domain,
        })
      : input.payload;
```

Replace with (add the import at the top: `import { matchIntakeRule } from "../profiles/intake-rules";`):

```ts
  let domain = client.emailDomain ?? client.primaryDomain;
  if (input.action === "onboard" && opts?.resolveDomain) domain = await opts.resolveDomain(client);
  // Per-contact intake rule (FR #0000019): a configured requester forces the domain and skips systems.
  const intakeRule = input.action === "onboard"
    ? matchIntakeRule((client as { intakeRules?: unknown }).intakeRules, input.payload as Record<string, unknown>)
    : null;
  if (intakeRule?.forceDomain) domain = intakeRule.forceDomain;
  let payload =
    input.action === "onboard"
      ? deriveIdentity(input.payload, {
          usernamePatterns: identity.usernamePatterns ?? null,
          primaryDomain: domain,
        })
      : input.payload;
  if (intakeRule) payload = { ...payload, __intakeRule: { id: intakeRule.id, label: intakeRule.label } };
```

Then update the `planCase(...)` call (inside the `resolvePlannedConfigs(...)` argument) to pass `intakeRule?.skipSystems` as the final argument:

```ts
  const planned = resolvePlannedConfigs(client, payload, input.action,
    planCase(client.systems, input.action, payload, personaSystemKeys(client, payload, input.action),
      new Set(client.notNeededSecrets), new Set(client.wiredOptionalSecrets), intakeRule?.skipSystems));
```

- [ ] **Step 5: Add the matched rule to the `case.plan`/`case.create` audit detail**

In the same file, in the `repo.writeAudit({ ... action: "case.create" ... detail: { ... } })` call, add to `detail`:

```ts
      intakeRule: intakeRule ? { id: intakeRule.id, label: intakeRule.label } : null,
```

- [ ] **Step 6: Wire the rule into `replan-service.ts`**

In `web/lib/cases/replan-service.ts`, add the import `import { matchIntakeRule } from "../profiles/intake-rules";`. Locate the onboard domain block:

```ts
    const { domain } = await makeEmailDomainResolver(db)(info.client, override ?? info.emailDomainOverride ?? undefined);
    payload = deriveIdentity(payload, { usernamePatterns: identity.usernamePatterns ?? null, primaryDomain: domain });
```

Replace with:

```ts
    let { domain } = await makeEmailDomainResolver(db)(info.client, override ?? info.emailDomainOverride ?? undefined);
    const intakeRule = matchIntakeRule((info.client as { intakeRules?: unknown }).intakeRules, payload as Record<string, unknown>);
    if (intakeRule?.forceDomain) domain = intakeRule.forceDomain;
    payload = deriveIdentity(payload, { usernamePatterns: identity.usernamePatterns ?? null, primaryDomain: domain });
    if (intakeRule) payload = { ...payload, __intakeRule: { id: intakeRule.id, label: intakeRule.label } };
```

Then update the `planCase(...)` call to thread `skipSystems`. The `intakeRule` const is declared inside the `if (action === "onboard")` block; declare it at the function scope so the `planCase` call can see it. Change the block so `intakeRule` is hoisted:

```ts
  let intakeRule: ReturnType<typeof matchIntakeRule> = null;
  if (action === "onboard") {
    // ...existing identity/domain lines from above, without re-declaring intakeRule (assign it)...
  }
  const planned = resolvePlannedConfigs(info.client, payload, action,
    planCase(info.client.systems, action, payload, personaSystemKeys(info.client, payload, action),
      new Set(info.client.notNeededSecrets), new Set(info.client.wiredOptionalSecrets), intakeRule?.skipSystems));
```

Adjust the two lines inside the block to `intakeRule = matchIntakeRule(...)` (assignment, not `const`). Confirm `info.client` carries `intakeRules` (whatever query `replan-service` uses to load `info.client` — if it uses an explicit `select`, add `intakeRules: true`; grep for where `info.client` is loaded).

- [ ] **Step 7: Verify the whole suite compiles and passes**

Run: `cd web && npx tsc --noEmit 2>&1 | head -20 && npm test 2>&1 | tail -25`
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/lib/cases/planning-service.ts web/lib/cases/replan-service.ts web/lib/cases/planning-intake-rule.test.ts
git commit -m "feat(plan): apply intake rules at plan + replan (FR #0000019)"
```

---

### Task 6: `fetchAccountContacts` gateway + `sn-contacts` populate route

**Files:**
- Modify: `web/lib/servicenow/gateway.ts` (add `fetchAccountContacts` near `fetchAccountContactEmails` ~line 108)
- Create: `web/app/api/clients/[slug]/sn-contacts/route.ts`
- Test: `web/lib/servicenow/account-contacts.test.ts`

**Interfaces:**
- Produces: `fetchAccountContacts(config: SnConfig, accountSysId: string, fetcher?): Promise<{ sysId: string; name: string; email: string }[]>` — active `customer_contact` rows for an account. Returns `[]` for a non-sys_id account. Route `GET /api/clients/:slug/sn-contacts` returns `{ contacts: [...] }`.

- [ ] **Step 1: Write the failing gateway test**

Create `web/lib/servicenow/account-contacts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchAccountContacts } from "./gateway";
import type { SnConfig } from "./types";

const config: SnConfig = { instanceUrl: "https://x.service-now.com", username: "u", password: "p" };

function mockFetch(rows: Array<{ sys_id: string; name: string; email: string }>): typeof fetch {
  return (async (url: string) => {
    assert.ok(String(url).includes("customer_contact"));
    return { ok: true, status: 200, json: async () => ({ result: rows }) } as Response;
  }) as unknown as typeof fetch;
}

test("returns sysId/name/email rows", async () => {
  const out = await fetchAccountContacts(
    config, "7750e1e447bdf29c3c5e88f4116d4393",
    mockFetch([{ sys_id: "aa", name: "Angie Shropshire", email: "angie@shawmut.com" }]),
  );
  assert.deepEqual(out, [{ sysId: "aa", name: "Angie Shropshire", email: "angie@shawmut.com" }]);
});

test("rejects a non-sys_id account (injection guard) → []", async () => {
  const out = await fetchAccountContacts(config, "not-a-sysid^ORDERBYnope", mockFetch([]));
  assert.deepEqual(out, []);
});
```

> Confirm the `snGet` return shape: `fetchAccountContactEmails` maps over the array directly, so `snGet` returns `result` unwrapped. Match the mock to whatever `snGet` expects — inspect `web/lib/servicenow/http.ts` `snGet` and mirror the existing `fetchAccountContactEmails` test/mock if one exists (`grep -rl fetchAccountContactEmails web/lib`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/servicenow/account-contacts.test.ts`
Expected: FAIL — `fetchAccountContacts` is not exported.

- [ ] **Step 3: Implement `fetchAccountContacts`**

In `web/lib/servicenow/gateway.ts`, add after `fetchAccountContactEmails` (mirror its paging, sys_id validation, and constants `CONTACT_PAGE` / `CONTACT_MAX`):

```ts
// Active customer_contact rows for an account (sys_id + name + email), backing the intake-rule
// contact picker (FR #0000019). Same query/guard as fetchAccountContactEmails, more fields.
export async function fetchAccountContacts(
  config: SnConfig,
  accountSysId: string,
  fetcher: Fetcher = fetch
): Promise<{ sysId: string; name: string; email: string }[]> {
  if (!/^[0-9a-f]{32}$/i.test(accountSysId)) return [];
  assertConfig(config);
  const out: { sysId: string; name: string; email: string }[] = [];
  for (let offset = 0; offset < CONTACT_MAX; offset += CONTACT_PAGE) {
    const page = await snGet<Array<{ sys_id?: string; name?: string; email?: string }>>(
      config,
      "/api/now/table/customer_contact",
      {
        sysparm_query: `account=${accountSysId}^active=true`,
        sysparm_fields: "sys_id,name,email",
        sysparm_display_value: "false",
        sysparm_limit: String(CONTACT_PAGE),
        sysparm_offset: String(offset),
      },
      fetcher
    );
    for (const r of page) {
      const sysId = (r.sys_id ?? "").trim();
      if (sysId) out.push({ sysId, name: (r.name ?? "").trim(), email: (r.email ?? "").trim() });
    }
    if (page.length < CONTACT_PAGE) break;
  }
  return out;
}
```

> If `snGet`'s generic already unwraps `.result` (it does for `fetchAccountContactEmails`), the above compiles as-is. Import `Fetcher`, `assertConfig`, `snGet`, `SnConfig` are already in scope in gateway.ts (used by `fetchAccountContactEmails`).

- [ ] **Step 4: Run the gateway test to verify it passes**

Run: `cd web && npx tsx --test lib/servicenow/account-contacts.test.ts`
Expected: PASS — both tests.

- [ ] **Step 5: Create the populate route**

Create `web/app/api/clients/[slug]/sn-contacts/route.ts`:

```ts
// GET /api/clients/:slug/sn-contacts — the customer_contact people for this client's account, to
// populate the intake-rule contact picker (FR #0000019). Requires an authorized, in-scope operator.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { fetchAccountContacts, fetchAccountBySysId } from "@/lib/servicenow/gateway";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const c = await db.client.findUnique({ where: { slug: params.slug }, select: { serviceNowSysId: true, coreId: true } });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  let accountSysId = c.serviceNowSysId ?? "";
  // Fallback: resolve the account by CORE id if the sys_id isn't cached.
  if (!accountSysId && c.coreId) {
    try { accountSysId = (await fetchAccountBySysId?.(snConfigFromEnv(), c.coreId))?.sys_id ?? ""; } catch { accountSysId = ""; }
  }
  if (!accountSysId) return NextResponse.json({ error: "client has no ServiceNow account sys_id" }, { status: 409 });

  try {
    const contacts = await fetchAccountContacts(snConfigFromEnv(), accountSysId);
    return NextResponse.json({ contacts });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "ServiceNow lookup failed" }, { status: 502 });
  }
}
```

> The CORE-id fallback is best-effort. `web/lib/servicenow/gateway.ts:78` already has "One account by CORE id (u_core_id)" — use that function's real name (grep `by CORE id` in gateway.ts; it returns the account record with `sys_id`). Replace `fetchAccountBySysId` above with the actual exported name and its return shape. If no such helper is exported, drop the fallback and rely on `serviceNowSysId` (which Shawmut has), returning 409 when absent.

- [ ] **Step 6: Verify compile**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -E "sn-contacts|gateway" | head`
Expected: no errors (empty output).

- [ ] **Step 7: Commit**

```bash
git add web/lib/servicenow/gateway.ts web/lib/servicenow/account-contacts.test.ts web/app/api/clients/[slug]/sn-contacts
git commit -m "feat(sn): fetchAccountContacts + sn-contacts populate route (FR #0000019)"
```

---

### Task 7: Repository accessors + intake-rules read/write route

**Files:**
- Modify: `web/lib/clients/repository.ts` (add `getIntakeRules` / `setIntakeRules` near `getRules`/`setRules` ~line 458)
- Create: `web/app/api/clients/[slug]/intake-rules/route.ts`
- Test: `web/lib/clients/intake-rules-validate.test.ts`

**Interfaces:**
- Consumes: `parseIntakeRules` (Task 2), `Client.intakeRules` (Task 1).
- Produces:
  - `repo.getIntakeRules(slug): Promise<{ id: string; intakeRules: IntakeRulesDoc; systemKeys: string[] } | null>`
  - `repo.setIntakeRules(slug, doc: IntakeRulesDoc): Promise<Client>`
  - `validateIntakeRulesBody(body: unknown): { ok: true; value: IntakeRulesDoc } | { ok: false; error: string }`
  - Route `GET`/`PUT /api/clients/:slug/intake-rules`.

- [ ] **Step 1: Write the failing validator test**

Create `web/lib/clients/intake-rules-validate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIntakeRulesBody } from "./intake-rules-validate";

test("accepts a well-formed doc", () => {
  const r = validateIntakeRulesBody({
    rules: [{
      id: "shawmut-infinite", label: "Shawmut Infinite",
      match: { contacts: [{ sysId: "7750e1e447bdf29c3c5e88f4116d4393", name: "Angie Shropshire" }] },
      effects: { skipSystems: ["active-directory"], forceDomain: "shawmutinfinite.com" },
    }],
  });
  assert.equal(r.ok, true);
});

test("rejects an implausible forceDomain", () => {
  const r = validateIntakeRulesBody({
    rules: [{ id: "x", label: "x", match: { contacts: [{ sysId: "aa", name: "n" }] }, effects: { skipSystems: [], forceDomain: "not a domain" } }],
  });
  assert.equal(r.ok, false);
});

test("rejects a rule with no contacts", () => {
  const r = validateIntakeRulesBody({
    rules: [{ id: "x", label: "x", match: { contacts: [] }, effects: { skipSystems: ["m365"], forceDomain: null } }],
  });
  assert.equal(r.ok, false);
});

test("empty rules is valid (clears the config)", () => {
  assert.equal(validateIntakeRulesBody({ rules: [] }).ok, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx tsx --test lib/clients/intake-rules-validate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

Create `web/lib/clients/intake-rules-validate.ts`:

```ts
import { parseIntakeRules, type IntakeRulesDoc } from "../profiles/intake-rules";

// A plausible DNS domain (mirrors the check used for email domains): labels + a TLD.
function plausibleDomain(v: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(v);
}

export function validateIntakeRulesBody(
  body: unknown,
): { ok: true; value: IntakeRulesDoc } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { rules?: unknown }).rules)) {
    return { ok: false, error: "expected { rules: [] }" };
  }
  const doc = parseIntakeRules(body);
  for (const r of doc.rules) {
    if (r.match.contacts.length === 0) return { ok: false, error: `rule "${r.label}" has no contacts` };
    if (r.effects.forceDomain !== null && !plausibleDomain(r.effects.forceDomain)) {
      return { ok: false, error: `rule "${r.label}" has an invalid domain "${r.effects.forceDomain}"` };
    }
  }
  return { ok: true, value: doc };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx tsx --test lib/clients/intake-rules-validate.test.ts`
Expected: PASS — all four tests.

- [ ] **Step 5: Add repository accessors**

In `web/lib/clients/repository.ts`, after `setRules`, add (import `parseIntakeRules`, `IntakeRulesDoc` from `../profiles/intake-rules`, and reuse the existing `Prisma` import):

```ts
    async getIntakeRules(slug: string): Promise<{ id: string; intakeRules: IntakeRulesDoc; systemKeys: string[] } | null> {
      const c = await db.client.findUnique({
        where: { slug },
        select: { id: true, intakeRules: true, systems: { select: { systemKey: true }, orderBy: { systemKey: "asc" } } },
      });
      if (!c) return null;
      return { id: c.id, intakeRules: parseIntakeRules(c.intakeRules), systemKeys: c.systems.map((s) => s.systemKey) };
    },

    async setIntakeRules(slug: string, doc: IntakeRulesDoc) {
      return db.client.update({ where: { slug }, data: { intakeRules: doc as unknown as Prisma.InputJsonValue } });
    },
```

- [ ] **Step 6: Create the route**

Create `web/app/api/clients/[slug]/intake-rules/route.ts`:

```ts
// GET  /api/clients/:slug/intake-rules — load the client's intake rules + its system keys (editor).
// PUT  /api/clients/:slug/intake-rules — { rules: [...] } — validate, persist, audit (FR #0000019).
import { NextResponse } from "next/server";
import { guard, guardAuth } from "@/lib/auth/route-guard";
import { auditActor } from "@/lib/auth/audit";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { validateIntakeRulesBody } from "@/lib/clients/intake-rules-validate";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const data = await makeClientRepository(db).getIntakeRules(params.slug);
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PUT(req: Request, { params }: { params: { slug: string } }) {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const checked = validateIntakeRulesBody(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 422 });

  const repo = makeClientRepository(db);
  const existing = await repo.getIntakeRules(params.slug);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  const client = await repo.setIntakeRules(params.slug, checked.value);

  const who = auditActor(_g.user, "ui");
  await repo.writeAudit({
    actor: who.label,
    userId: who.userId,
    action: "client.intake_rules.edit",
    clientId: client.id,
    detail: {
      ruleCount: checked.value.rules.length,
      rules: checked.value.rules.map((r) => ({
        id: r.id, label: r.label,
        contacts: r.match.contacts.map((c) => c.name),
        skipSystems: r.effects.skipSystems,
        forceDomain: r.effects.forceDomain,
      })),
    },
  });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: Verify compile + run the new tests**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -iE "intake-rules|repository" | head && npx tsx --test lib/clients/intake-rules-validate.test.ts`
Expected: no type errors; validator tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/lib/clients/repository.ts web/lib/clients/intake-rules-validate.ts web/lib/clients/intake-rules-validate.test.ts web/app/api/clients/[slug]/intake-rules
git commit -m "feat(api): intake-rules read/write route + validation (FR #0000019)"
```

---

### Task 8: Intake-rules editor UI + client page wiring

**Files:**
- Create: `web/app/clients/_components/intake-rules-editor.tsx`
- Modify: `web/app/clients/[slug]/page.tsx` (import + render, near the other editors ~line 32)
- Modify: `web/app/clients/[slug]/page.tsx` loader/props to pass the client's `intakeRules` + `systemKeys` + `slug`.

**Interfaces:**
- Consumes: `GET/PUT /api/clients/:slug/intake-rules`, `GET /api/clients/:slug/sn-contacts`.
- Produces: an "Intake rules" card. No new lib interface.

- [ ] **Step 1: Build the editor component**

Create `web/app/clients/_components/intake-rules-editor.tsx`. A client component (`"use client"`) that:
- Loads current rules from `GET /api/clients/${slug}/intake-rules` on mount (or accepts them as a prop).
- Renders each rule: label input, a contacts multiselect, a skip-systems multiselect (options = the passed `systemKeys`), a force-domain text input, and a remove button. An "Add rule" button appends an empty rule.
- Has a **"Populate from ServiceNow"** button that sets a `loading` state, opens a small modal ("Loading contacts from ServiceNow…"), calls `GET /api/clients/${slug}/sn-contacts`, and fills a contact dropdown with `{ sysId, name, email }`. Selecting a person adds `{ sysId, name }` to the active rule's contacts.
- "Save" PUTs `{ rules }` and shows a success/error message.

Follow the existing component conventions (copy structure from `web/app/clients/_components/location-targets-editor.tsx` — same fetch/save/modal idioms, `className="badge"`, sentence-case labels, flat layout). Concretely:

```tsx
"use client";
import { useEffect, useState } from "react";

type Contact = { sysId: string; name: string };
type Rule = { id: string; label: string; match: { contacts: Contact[] }; effects: { skipSystems: string[]; forceDomain: string | null } };
type SnContact = { sysId: string; name: string; email: string };

export function IntakeRulesEditor({ slug, systemKeys }: { slug: string; systemKeys: string[] }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [snContacts, setSnContacts] = useState<SnContact[] | null>(null);
  const [populating, setPopulating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/clients/${slug}/intake-rules`).then((r) => r.json()).then((d) => {
      if (Array.isArray(d?.intakeRules?.rules)) setRules(d.intakeRules.rules);
    }).catch(() => {});
  }, [slug]);

  async function populate() {
    setPopulating(true); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}/sn-contacts`);
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "lookup failed");
      setSnContacts(d.contacts ?? []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "lookup failed"); setSnContacts(null);
    } finally { setPopulating(false); }
  }

  function addRule() {
    setRules((rs) => [...rs, { id: `rule-${rs.length}`, label: "New rule", match: { contacts: [] }, effects: { skipSystems: [], forceDomain: "" } }]);
  }
  function update(i: number, patch: Partial<Rule>) { setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); }

  async function save() {
    setMsg(null);
    const payload = { rules: rules.map((r) => ({ ...r, effects: { ...r.effects, forceDomain: r.effects.forceDomain?.trim() || null } })) };
    const r = await fetch(`/api/clients/${slug}/intake-rules`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const d = await r.json();
    setMsg(r.ok ? "Saved" : (d?.error ?? "Save failed"));
  }

  return (
    <section>
      <h2>Intake rules</h2>
      <p className="muted">When a listed ServiceNow contact submits an onboarding, skip the chosen systems and force the email domain. Everyone else gets the normal plan.</p>
      {rules.map((rule, i) => (
        <div key={i} className="card" style={{ marginBottom: 12 }}>
          <input value={rule.label} onChange={(e) => update(i, { label: e.target.value })} placeholder="Label" />
          <div>
            <strong>Contacts:</strong> {rule.match.contacts.map((c) => c.name).join(", ") || <span className="muted">none</span>}
            <button type="button" onClick={populate} disabled={populating} style={{ marginLeft: 8 }}>Populate from ServiceNow</button>
            {snContacts && (
              <select onChange={(e) => {
                const c = snContacts.find((x) => x.sysId === e.target.value);
                if (c) update(i, { match: { contacts: [...rule.match.contacts, { sysId: c.sysId, name: c.name }] } });
              }} defaultValue="">
                <option value="" disabled>Add a contact…</option>
                {snContacts.map((c) => <option key={c.sysId} value={c.sysId}>{c.name} — {c.email}</option>)}
              </select>
            )}
          </div>
          <div>
            <strong>Skip systems:</strong>
            {systemKeys.map((k) => (
              <label key={k} style={{ marginLeft: 8 }}>
                <input type="checkbox" checked={rule.effects.skipSystems.includes(k)}
                  onChange={(e) => update(i, { effects: { ...rule.effects, skipSystems: e.target.checked ? [...rule.effects.skipSystems, k] : rule.effects.skipSystems.filter((s) => s !== k) } })} /> {k}
              </label>
            ))}
          </div>
          <div>
            <strong>Force domain:</strong>
            <input value={rule.effects.forceDomain ?? ""} onChange={(e) => update(i, { effects: { ...rule.effects, forceDomain: e.target.value } })} placeholder="shawmutinfinite.com" />
          </div>
          <button type="button" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>Remove rule</button>
        </div>
      ))}
      <button type="button" onClick={addRule}>Add rule</button>
      <button type="button" onClick={save} style={{ marginLeft: 8 }}>Save</button>
      {msg && <span style={{ marginLeft: 8 }} className="muted">{msg}</span>}
      {populating && <div className="modal-backdrop"><div className="modal">Loading contacts from ServiceNow…</div></div>}
    </section>
  );
}
```

> Match the actual class names / modal markup used by the existing components (e.g. `location-targets-editor.tsx`, `create-in-delinea.tsx` for a modal). Replace `className="card"`, `modal-backdrop`, `modal` with whatever the codebase uses. The logic above is the contract; the markup adapts to the design system.

- [ ] **Step 2: Wire it into the client page**

In `web/app/clients/[slug]/page.tsx`, add the import near the other editor imports (~line 32):

```ts
import { IntakeRulesEditor } from "../_components/intake-rules-editor";
```

In the JSX, near where `RolesRulesView` / `EditRulesButton` render, add:

```tsx
<IntakeRulesEditor slug={client.slug} systemKeys={client.systems.map((s) => s.systemKey)} />
```

Confirm `client.systems` (with `systemKey`) is already loaded on this page (it renders the systems table, so it is). If `client.slug` isn't in scope under that name, use the existing slug variable.

- [ ] **Step 3: Verify build compiles**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -iE "intake-rules-editor|clients/\[slug\]/page" | head`
Expected: no errors.

- [ ] **Step 4: Manual smoke (optional, if a dev server is available)**

Load a client page, confirm the "Intake rules" card renders, "Populate from ServiceNow" opens the loading modal and lists contacts, and Save round-trips.

- [ ] **Step 5: Commit**

```bash
git add web/app/clients/_components/intake-rules-editor.tsx web/app/clients/[slug]/page.tsx
git commit -m "feat(ui): intake rules editor with SN contact picker (FR #0000019)"
```

---

### Task 9: "Planned via intake rule" badge on the case

**Files:**
- Modify: `web/app/cases/[id]/page.tsx` (case header, ~line 144)

**Interfaces:**
- Consumes: `payload.__intakeRule = { id, label }` stamped in Task 5.
- Produces: a badge on the case header when a rule was applied.

- [ ] **Step 1: Add the badge**

In `web/app/cases/[id]/page.tsx`, near the header line that renders `{c.serviceNowCaseNumber ?? "no SN case"} · <span className="badge">{c.status...}</span>`, read the stamp and render a badge:

```tsx
{(() => {
  const rule = (c.payload as { __intakeRule?: { label?: string } } | null)?.__intakeRule;
  return rule?.label ? <span className="badge" style={{ marginLeft: 6 }} title="This case was planned by a per-contact intake rule">Intake rule: {rule.label}</span> : null;
})()}
```

- [ ] **Step 2: Verify compile**

Run: `cd web && npx tsc --noEmit 2>&1 | grep -iE "cases/\[id\]/page" | head`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/app/cases/[id]/page.tsx
git commit -m "feat(ui): show intake-rule badge on planned cases (FR #0000019)"
```

---

### Task 10: Full verification + changelog + FR status

**Files:**
- Create: `web/lib/changelog/entries/<id>-intake-rules.ts` (one-file-per-entry; register in `_registry.ts`)
- (No code change) mark FR #0000019 handled where appropriate.

- [ ] **Step 1: Run the whole test suite**

Run: `cd web && npm test 2>&1 | tail -30`
Expected: all tests pass, including the new `intake-rules`, `intake-requester`, `orchestrator.intake-skip`, `planning-intake-rule`, `account-contacts`, `intake-rules-validate` files.

- [ ] **Step 2: Full type check**

Run: `cd web && npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors.

- [ ] **Step 3: Add a changelog entry**

Follow the changelog convention (see the memory index / `web/lib/changelog/entries/`): append a one-file-per-entry with an id-sorted filename, `time` = `TZ=America/New_York date +%H:%M` on a 15-minute boundary, and register it in `_registry.ts`. Content: per-contact intake rules — Shawmut split workflow (FR #0000019).

- [ ] **Step 4: Commit**

```bash
git add web/lib/changelog/entries
git commit -m "docs(changelog): per-contact intake rules (FR #0000019)"
```

- [ ] **Step 5: Push + open a draft PR**

```bash
git push -u origin worktree-shawmut-intake-rules-spec
gh pr create --draft --title "Per-contact intake rules (FR #0000019: Shawmut split workflow)" --body "$(cat <<'EOF'
Implements FR #0000019. When a configured ServiceNow contact submits an onboarding, the plan skips
named systems (Shawmut: active-directory + directory-sync) and forces an email domain
(shawmutinfinite.com). Everyone else gets the client's normal plan.

Includes: Client.intakeRules column + migration, matchIntakeRule, requester sys_id capture,
planCase skipSystems, plan/replan wiring + provenance stamp, SN contact picker (populate route),
rule editor UI, and the case badge.

**Deploy notes:** migration 20260721160000_client_intake_rules needs applying.

**Live validation still required (see spec):** (1) confirm the case field that carries the requesting
contact matches the customer_contact sys_id the picker returns; (2) confirm shawmutinfinite.com is a
verified tenant domain and add it to Shawmut's domains; (3) confirm the M365 lane creates the account
(vs. license-only) now that AD is dropped.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** storage (Task 1), matcher (Task 2), requester capture (Task 3), skip-systems (Task 4), domain-forcing + provenance at plan & replan (Task 5), SN contact query + populate route (Task 6), persistence route + validation (Task 7), editor UI with populate modal (Task 8), case badge (Task 9), verification + changelog + PR (Task 10). Every spec section maps to a task.
- **Naming consistency:** the payload keys `requestedByContactSysId` / `openedBySysId` are written in Task 3 and read in Task 2's `matchIntakeRule` and Task 5's composition test — identical spelling throughout. `skipSystems` is a `ReadonlySet<string>` end to end (Task 2 output → Task 4 param → Task 5 call).
- **Open validation items** are carried into the PR body (Task 10) rather than silently assumed, matching the spec's "Open validation items" section.
