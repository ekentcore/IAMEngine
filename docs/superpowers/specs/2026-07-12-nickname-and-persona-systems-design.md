# Nickname-aware identity + persona-gated systems — design

Date: 2026-07-12. Status: implemented in this branch (autonomous session — decisions below
are flagged for review on the PR).

## Ask

1. AD first name uses the intake **Nickname** when filled, else the legal first name.
2. **SamAccountName and UPN** derive from the nickname when filled: William Smith,
   nickname Bill, pattern `{firstInitial}{last}` → `BSmith`, not `WSmith`.
3. Some systems are needed only by certain personas/departments (e.g. xMatters) —
   support **per-persona system inclusion**.

## Part 1 — nickname-aware identity derivation

Everything funnels through `deriveIdentity()` (`web/lib/servicenow/intake-mapper.ts`),
which computes `displayName / samAccountName / userPrincipalName / mailNickname /
workEmail`; the runner consumes those verbatim (`New-ADUser -GivenName $User.FirstName
-SamAccountName ... -UserPrincipalName ...`). So the whole feature is web-side — **no
runner change, no fleet deploy**.

Changes:

- **Capture**: add `u_nickname` to the UM variable fetch list (`intake.ts`) and map it in
  `onboardPayload()` (`nickname`). The incident path already maps `u_nickname`; it was
  previously dead.
- **Derive** (`deriveIdentity`): `effectiveFirst = nickname || legalFirst`. The effective
  first feeds the `{first}/{firstinitial}/{f}` username tokens (→ sam, UPN, mailNickname,
  fallback UPNs), and, when a nickname is present:
  - `firstName` in the derived payload becomes the nickname — this is what the runner
    writes to AD `givenName` / Graph `GivenName`, satisfying ask #1 with zero runner change.
  - `legalFirstName` preserves the intake first name. Idempotent across re-plans:
    `legalFirst = payload.legalFirstName ?? payload.firstName`.
  - `displayName` is recomputed as `"<nickname> <last>"` (the intake-built displayName was
    assembled from the legal first, so it can't be trusted once a nickname exists).
- **UI**: `nickname` / `legalFirstName` labels in `intake-labels.ts`.

Decision: nickname **replaces** the first name everywhere (AD givenName, display name,
username tokens) rather than adding a `{nickname}` pattern token. That matches the ask
("Bill Smith → BSmith") and keeps client username patterns untouched.

## Part 2 — persona-gated systems (`by-persona` lane)

Today a system's inclusion is decided only by its lane (`always | on-request | never`) in
`orchestrator.included()`; personas shape job *config* (groups/OU/licenses) but never the
*set* of jobs.

New lane value **`by-persona`** (DB enum `by_persona`):

- A system whose onboard/offboard lane is `by-persona` is included **iff the selected
  persona's bundle lists it** — onboard: a key in `persona.systems`; offboard: a key in
  `persona.systems` **or** `persona.offboardSystems` (union, so whatever a persona granted
  at onboard gets cleaned up even without an explicit offboard fragment).
- Persona selection reuses `buildPlanContext()` — the same path PR #9 (persona confirm /
  `personaOverride`) hooks, so the two features compose when that lands.
- No persona matched → `by-persona` systems are simply excluded (same shape as an
  unsignalled `on-request` system).
- Existing persona `systems` fragments on `always` systems keep their config-only meaning —
  presence only *includes* a system when that system's lane is explicitly `by-persona`.

Touchpoints: Prisma `Lifecycle` enum + migration (`ALTER TYPE ... ADD VALUE`),
`profiles/_schema.json` `when` enum, `seed.ts` laneMap, `orchestrator.planCase` (new
optional persona-keys arg), `personaSystemKeys()` helper (`plan-resolve.ts`),
planning/replan services, systems editor + systems API lane lists.

Operator workflow for "give Ops xMatters": set the xmatters system's onboard lane to
"by persona" in the systems editor, and add an `xmatters` entry (even `{}`) to the Ops
persona's `systems` in the rules editor.

## Out of scope

- A `{nickname}` username-pattern token (nickname replaces `{first}` instead).
- Parenthetical-nickname parsing ("William (Bill)") — the SN field is a plain string.
- Persona-conditional *config* changes — already exist via fragment `when` clauses.
