# Per-contact intake rules (contact-conditional onboarding)

**Date:** 2026-07-21
**Feature request:** #0000019 — "Shawmut Corporation - Split Workflow depending on requestor"
**Client:** Shawmut Corporation (`core2107`, CORE2107)

## Problem

Shawmut runs two identity worlds. Most new hires get the normal Shawmut flow: an
Active Directory account that syncs to Microsoft 365, on a `shawmutcorporation.com`
address. But when a **specific ServiceNow contact** submits the onboarding — today
that's Angie Shropshire (customer_contact sys_id `7750e1e447bdf29c3c5e88f4116d4393`) —
the new user must instead be created **cloud-only in M365** (no AD account, no
directory-sync) on a `shawmutinfinite.com` address, because `shawmutinfinite.com`
users have no on-prem AD presence.

The engine currently plans every onboard for a client the same way, derived from the
client's modeled systems and its single email domain. There is no mechanism to alter
the plan based on *who* opened the case.

## Goal

Let an operator configure, per client, a small list of **intake rules**: "when the
requesting contact is one of these people, skip these systems and force this email
domain." When a matching onboard case is planned, the engine drops the named systems
(so no AD account / directory-sync step is created) and derives the user's identity on
the forced domain. Every other requester falls through to the client's normal plan
unchanged.

The mechanism is generic (configurable systems + domain, list of contacts), so a
future client with a similar split needs configuration, not code.

## Non-goals

- No new *offboard* behavior. This is onboard-only for now. (Offboard already
  identifies an existing user by name/UPN and doesn't derive a domain.)
- No matching on the *new user's* requested domain or on the client generally — the
  trigger is strictly **the requesting contact**. (Confirmed with the requester.)
- No per-rule persona/OU/group effects in v1 — only `skipSystems` and `forceDomain`.
  The storage shape leaves room to grow.
- Not verifying that `shawmutinfinite.com` is a verified domain in the tenant or that
  the M365 lane creates (vs. licenses) the account — those are **live validation
  items** (see "Open validation items"), not code this feature ships.

## Approach (chosen: A — intake rules)

Store an ordered list of intake rules on the client as JSON, evaluate it with a pure
function at the shared plan/replan path, and apply two effects:

1. **Skip systems** — thread the matched rule's `skipSystems` into `planCase` so those
   systems (and any synthetic steps that depend on them, e.g. `ad-email-writeback`,
   `ad-consistency-check`) are never planned.
2. **Force domain** — override the resolved email/UPN domain *before* identity
   derivation so the user's UPN, sam, mail-nickname, and work email are all built on
   the forced domain.

This mirrors existing payload-driven plan mutations at the same choke point (rehire →
`adopt` collision policy, `mirrorPermissionsFromUser`, requestor groups) rather than
inventing a new subsystem. Personas (approach B) and the dormant `identity.domainRules`
schema block (approach C) were considered and rejected: B bends persona semantics, and
C's domain-routing block is defined in `profiles/_schema.json` but wired nowhere, and
neither models "skip a system."

## Data model

### New column: `Client.intakeRules Json?`

Nullable, alongside the existing plan-time JSON blocks (`personas`, `globals`,
`locations`). Requires a Prisma migration (additive, no backfill).

Shape:

```jsonc
{
  "rules": [
    {
      "id": "shawmut-infinite",                    // stable slug, used in provenance
      "label": "Shawmut Infinite (cloud-only)",     // shown in UI + on the case
      "match": {
        "contacts": [
          { "sysId": "7750e1e447bdf29c3c5e88f4116d4393", "name": "Angie Shropshire" }
        ]
      },
      "effects": {
        "skipSystems": ["active-directory", "directory-sync"],
        "forceDomain": "shawmutinfinite.com"
      }
    }
  ]
}
```

- `match.contacts[]` holds `{ sysId, name }` pairs. `sysId` is the customer_contact
  sys_id (the value the picker resolves); `name` is stored only for display so the UI
  and the case badge can show a human name without a re-lookup.
- `effects.skipSystems` is a list of `systemKey`s. `effects.forceDomain` is a domain
  string (validated as a plausible domain on save).
- Rules are evaluated **in order; first match wins**. v1 applies a single matched
  rule; if two rules match the same contact, the first is used (a save-time lint can
  warn on overlapping contacts later).

### Zod / TypeScript type

A shared `IntakeRules` schema (Zod) validates the JSON on API write and gives the
resolver a typed shape. Lives with the other profile config types.

## Intake capture (the requester's sys_id)

**Today the requester's sys_id is dropped.** `intake-mapper.ts` keeps only the display
name (`requestedBy: disp(r, "opened_by")`); no sys_id reaches the payload. We must
capture it.

The picker resolves **customer_contact** sys_ids (see UI below), so the payload must
carry the case's **customer_contact** reference to match against. Plan:

1. Add the case's contact reference field to `INTAKE_FIELDS` in
   `web/lib/servicenow/intake.ts` and capture its sys_id in `onboardPayload`
   (`intake-mapper.ts`) as `payload.requestedByContactSysId`.
2. Also capture `opened_by`'s sys_id as `payload.openedBySysId` (a `sys_user`
   reference — kept as a secondary match key and for provenance).
3. `matchIntakeRule` matches a rule's `contactSysId` against
   `requestedByContactSysId` first, then `openedBySysId`.

> **Open validation item (must confirm on a live case):** which field on
> `sn_customerservice_user_management` carries the *requesting contact*, and whether
> its sys_id equals the customer_contact sys_id the picker returns (Angie =
> `7750e1e4…`). `opened_by` is a `sys_user` reference and may differ from the
> customer_contact sys_id. If the case's requester lives in a `contact` (customer_contact)
> field, capture that; if only `opened_by` is available and it's a `sys_user`, the
> picker must additionally resolve each contact's linked `sys_user` for matching. The
> capture is designed to grab both so matching is robust either way; the exact field
> name is confirmed against a real Shawmut case before merge.

## Plan-time wiring

New module `web/lib/profiles/intake-rules.ts`:

```ts
export type MatchedIntakeRule = {
  id: string;
  label: string;
  skipSystems: ReadonlySet<string>;
  forceDomain: string | null;
};

// Pure + unit-testable. First matching rule wins; null when none match or client has no rules.
export function matchIntakeRule(
  intakeRules: unknown,
  payload: Record<string, unknown>,
): MatchedIntakeRule | null;
```

Match logic: parse `intakeRules` (tolerant of null/legacy), for each rule test whether
any `match.contacts[].sysId` equals `payload.requestedByContactSysId` or
`payload.openedBySysId`; return the first hit's effects.

### `planning-service.ts` (create) and `replan-service.ts` (replan)

Both already compute a `domain` and then call
`deriveIdentity(payload, { …, primaryDomain: domain })` followed by
`resolvePlannedConfigs(client, payload, action, planCase(…))`. Insert the rule between
domain resolution and derivation:

```ts
const rule = action === "onboard" ? matchIntakeRule(client.intakeRules, payload) : null;
if (rule?.forceDomain) domain = rule.forceDomain;
payload = action === "onboard"
  ? deriveIdentity(payload, { usernamePatterns, primaryDomain: domain })
  : payload;
// stamp provenance so the plan is explainable and re-derivable
if (rule) payload = { ...payload, __intakeRule: { id: rule.id, label: rule.label } };

const planned = resolvePlannedConfigs(client, payload, action,
  planCase(client.systems, action, payload, personaSystemKeys(…), notNeeded, wiredOptional,
           rule?.skipSystems /* NEW arg */));
```

### `planCase` (orchestrator.ts)

Add an optional trailing parameter `skipSystems?: ReadonlySet<string>`. In `included()`
(or as a filter over `active`), return `false` for any system whose `systemKey` is in
`skipSystems`. Because the synthetic `ad-email-writeback` and `ad-consistency-check`
steps are only injected when `active-directory` is in `activeKeys`, skipping
`active-directory` automatically prevents them too — no extra handling.

### `change-plan.ts`

`changePlan` seeds from the case's existing jobs rather than re-running `planCase`, so
it inherits whatever system set the original plan produced. No change needed for v1; a
case first planned under a rule keeps its reduced system set through a persona/location
change. (Documented, not a gap.)

## Provenance / auditability

- Stamp `payload.__intakeRule = { id, label }` (above) so the plan is self-describing
  and re-derivable on replan.
- Include the matched rule in the `case.plan` audit detail.
- Surface a small badge on the case detail view: *"Planned via intake rule: Shawmut
  Infinite (cloud-only)"* so an operator reviewing the held case sees immediately why
  AD is absent and why the address is `shawmutinfinite.com`.

## UI

New component `web/app/clients/_components/intake-rules-editor.tsx`, surfaced on the
client detail page next to the other config editors (rules-editor, location-targets-editor).

**Card: "Intake rules"** — lists configured rules; each row shows the label, the
matched contacts (names), and the effects ("No AD / directory-sync · shawmutinfinite.com").
Add / edit / remove rules.

**Rule editor (per rule):**

- **Label** — free text.
- **Contacts** — a multiselect of people. A **"Populate from ServiceNow"** button
  fetches this client's contacts; while it runs, a modal shows a running/loading state
  ("Loading contacts from ServiceNow…"). The list is `Name` values from
  `customer_contact` for this client's account; selecting a person stores its
  `{ sysId, name }`. (Requester's explicit request.)
- **Skip systems** — a multiselect of the client's modeled `systemKey`s (e.g.
  `active-directory`, `directory-sync`).
- **Force domain** — a text input validated as a plausible domain; helper text notes
  it must be a domain the tenant can assign (e.g. added to the client's `domains`).

Follows the host design system (flat, minimal borders, sentence case, no gradients).

### Populate route

New API route `web/app/api/clients/[slug]/sn-contacts/route.ts` (GET). Loads
`snConfigFromEnv()` (same pattern as `scan-servicenow`, `worknote`, `intake` routes),
resolves the client's account sys_id (`Client.serviceNowSysId`, falling back to a
`u_core_id=<coreId>` lookup), and returns `[{ sysId, name, email }]`.

Backed by a new gateway helper `fetchAccountContacts(config, accountSysId)` in
`web/lib/servicenow/gateway.ts`, modeled on the existing `fetchAccountContactEmails`
(same `account=<sysId>^active=true` query on `customer_contact`, sys_id-validated to
prevent query injection, paged), but selecting `sys_id,name,email` instead of just
`email`.

## Permissions & security

- Editing intake rules uses the **same authorization gate** as the other client-config
  editors (the rules/location editors' write gate). Enforced server-side on the write
  route, not just in the UI.
- The `sn-contacts` populate route requires the same operator auth as the other
  ServiceNow-backed routes and is scoped to a client the operator may see (client-scope
  check).
- `accountSysId` is sys_id-validated (`^[0-9a-f]{32}$`) before interpolation into the
  ServiceNow query, matching `fetchAccountContactEmails`.
- Every rule create/edit/delete writes an `AuditLog` row.

## Testing

- **Unit — `matchIntakeRule`:** matches on `requestedByContactSysId`; matches on
  `openedBySysId` fallback; first-match-wins with two rules; no match → null; null /
  malformed `intakeRules` → null; non-onboard action → null.
- **Unit — intake capture:** `onboardPayload` populates `requestedByContactSysId` and
  `openedBySysId` from a fixture SN record; absent fields → undefined (no throw).
- **Unit — `planCase` skipSystems:** with `skipSystems = {active-directory,
  directory-sync}`, neither lane nor the synthetic `ad-email-writeback` /
  `ad-consistency-check` steps appear; other lanes (entra/m365/exchange) remain.
- **Integration — planning-service:** a Shawmut-like client + a payload whose
  `requestedByContactSysId` is Angie's produces a plan with **no** `active-directory` /
  `directory-sync` jobs and a UPN/work email on `shawmutinfinite.com`; a payload with a
  different requester produces the normal AD-synced plan on `shawmutcorporation.com`.
- **Integration — replan:** replanning a rule-matched case keeps the reduced system set
  and forced domain.
- **Gateway — `fetchAccountContacts`:** parses `{sys_id,name,email}` rows; rejects a
  non-sys_id accountSysId (returns `[]`); pages.
- **Route:** `sn-contacts` returns contacts for an authorized operator; 401/403 for an
  unauthorized or out-of-scope one.

## Open validation items (live, before/after merge)

1. **Requester field:** confirm on a real Shawmut case which field carries the
   requesting contact and that its sys_id matches the picker's customer_contact sys_id
   (see "Intake capture"). Adjust the captured field name if needed.
2. **Domain assignability:** confirm `shawmutinfinite.com` is a verified domain in
   Shawmut's M365 tenant and add it to `Client.domains`, else account creation on that
   UPN suffix fails.
3. **M365 creates the account:** with AD dropped, the M365 lane must *create* the user
   (the reference `Coretelligent.M365` module does check-exists→create→adopt), not
   assume a directory-synced object. Confirm Shawmut's `m365` lane config isn't set to
   license-only.

## Files touched (summary)

- `web/prisma/schema.prisma` + migration — `Client.intakeRules Json?`.
- `web/lib/servicenow/intake.ts` — add contact reference field(s) to `INTAKE_FIELDS`.
- `web/lib/servicenow/intake-mapper.ts` — capture `requestedByContactSysId` /
  `openedBySysId` in `onboardPayload`.
- `web/lib/profiles/intake-rules.ts` (new) — `matchIntakeRule` + `IntakeRules` type/Zod.
- `web/lib/orchestrator.ts` — `planCase` `skipSystems` param.
- `web/lib/cases/planning-service.ts`, `web/lib/cases/replan-service.ts` — apply rule
  (force domain + skip systems + stamp provenance).
- `web/lib/servicenow/gateway.ts` — `fetchAccountContacts`.
- `web/app/api/clients/[slug]/sn-contacts/route.ts` (new) — populate route.
- `web/app/api/clients/[slug]/…` config write route — accept `intakeRules`.
- `web/app/clients/_components/intake-rules-editor.tsx` (new) + client page wiring.
- Case detail view — "Planned via intake rule" badge.
- Tests as above.
