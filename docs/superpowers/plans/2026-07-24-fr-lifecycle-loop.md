# FR Lifecycle Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Work all 8 loop-scoped open feature requests (#26, #27, #28, #29, #30, #31, #33, #34) end-to-end: plan each (status → `planned` + All-clients chat post), implement each (status → `building` + chat post), and ship each (merged to main with tests green → status → `done` + resolution note + changelog + chat post).

**Architecture:** No new lifecycle code — the loop drives the production app's existing APIs (`PATCH /api/feature-requests/:id`, `POST /api/admin/feature-requests/:id/announce`) with a minted `global_admin` session. Each FR's code change follows repo conventions: own worktree, TDD, changelog entry, PR merged via `scripts/prs.sh`, `runner/VERSION` bump for runner changes.

**Tech Stack:** Next.js/TypeScript/Prisma (web), PowerShell 7 + Pester (runner), `node:test` via `tsx --test` (web tests), psql against the shared Azure DB.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-24-fr-lifecycle-loop-design.md`. Done gate = **merged to main + tests green** (never flip `done` before merge).
- Status flip FIRST, announce SECOND; a failed announce never reverts a flip.
- Announce response `{ "results": [] }` means **nothing was sent** — stop the loop and report to Evan (preflight failure).
- Runner code changes bump `runner/VERSION` (currently `1.96.1`; `prs.sh` auto-resolves VERSION conflicts to max+patch). Resolution notes for runner FRs say "takes effect with the next runner deploy."
- Chat comment prefixes: planning posts start `Planning:`, scripting posts start `Scripting:`, done posts start `Implemented:`.
- Changelog entries: one file per entry in `web/lib/changelog/entries/<id>.ts`, registered in `_registry.ts` (id-sorted), `date`/`time` in `TZ=America/New_York`, time rounded DOWN to :00/:15/:30/:45.
- Web tests: `cd web && npm test` (runs `tsx --test "lib/**/*.test.ts"`). Runner tests: `~/.local/pwsh/pwsh -Command "Invoke-Pester -Path runner/tests/<file> -Output Detailed"`.
- FR#32 and FR#35 are OUT of the loop (stay `new`).
- FR id map (prod DB): #26=`cmrxgc1e8000yyxffyl8iydjf` #27=`cmrxgj9ay001fyxff1j30cvt7` #28=`cmrxhcjdk007pyxffbpxm9f9d` #29=`cmrxn1qzh0000z4w6j51ur96c` #30=`cmrxn5lxr000fz4w603k9k2t2` #31=`cmrxn92x3000kz4w64wg5s2jz` #33=`cmrxsv24p002kckv101egdp8d` #34=`cmrxzt1rt0033vnwcvb14st4a`

---

### Task 0: Lifecycle mechanics — mint session, preflight, helpers

**Files:**
- Create: `$CLAUDE_JOB_DIR/tmp/fr-loop.sh` (helper functions; never committed)
- No repo changes.

**Interfaces:**
- Produces: shell functions `fr_status <id> <status> [resolutionNote]` and `fr_announce <id> <comment>` used by every later task.

- [ ] **Step 1: Verify the All-clients chat destination is configured**

```sql
-- via mcp__postgres__query (read-only)
SELECT value FROM "AppSetting" WHERE key = 'failure_notifications';
```
Expected: JSON where at least one of `channels.{teams,slack,zoom}.default` has `enabled: true` and a non-empty `webhookUrl` (or `channels.email.default.enabled` with recipients). If none: STOP — report "no All-clients destination configured; enable one in Settings before the loop".

- [ ] **Step 2: Pick the acting admin user**

```sql
SELECT id, email, role FROM "User" WHERE status = 'active' AND role IN ('global_admin','super_admin') ORDER BY role DESC;
```
Use Evan's own account (`internallicensing@core.tech`) if present; audit rows will carry that actor.

- [ ] **Step 3: Mint a 12h session (psql — MCP is read-only)**

```bash
TOKEN=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')
HASH=$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$TOKEN")
# DATABASE_URL from web/.env / web/.env.local in the MAIN checkout (worktrees may lack env files)
psql "$DATABASE_URL" -c "INSERT INTO \"Session\" (id, \"userId\", \"tokenHash\", \"createdAt\", \"expiresAt\") VALUES ('frloop-' || substr(md5(random()::text),1,20), '<userId>', '$HASH', now(), now() + interval '12 hours');"
```

- [ ] **Step 4: Write the helpers and smoke-test auth**

```bash
cat > "$CLAUDE_JOB_DIR/tmp/fr-loop.sh" <<'EOF'
APP=https://iamengine.core.tech
fr_status() { # fr_status <id> <status> [note]
  local body
  if [ -n "$3" ]; then body=$(jq -n --arg s "$2" --arg n "$3" '{status:$s, resolutionNote:$n}'); else body=$(jq -n --arg s "$2" '{status:$s}'); fi
  curl -sS -X PATCH "$APP/api/feature-requests/$1" -H "Content-Type: application/json" -H "Cookie: iam_session=$FRTOKEN" -d "$body"
}
fr_announce() { # fr_announce <id> <comment>
  curl -sS -X POST "$APP/api/admin/feature-requests/$1/announce" -H "Content-Type: application/json" -H "Cookie: iam_session=$FRTOKEN" -d "$(jq -n --arg c "$2" '{audience:"all", comment:$c}')"
}
EOF
export FRTOKEN=$TOKEN
source "$CLAUDE_JOB_DIR/tmp/fr-loop.sh"
curl -sS "$APP/api/feature-requests" -H "Cookie: iam_session=$FRTOKEN" | head -c 200
```
Expected: JSON list (not 401). If 401: re-check hash/user/AUTH_ENABLED.

- [ ] **Step 5: End-of-loop cleanup note** — when the whole loop finishes (or aborts), revoke the session: `psql "$DATABASE_URL" -c "UPDATE \"Session\" SET \"revokedAt\" = now() WHERE \"tokenHash\" = '$HASH';"`

### Task 1: Planning pass — flip all 8 to Planned + announce

**Files:** none (API calls only).

**Interfaces:**
- Consumes: `fr_status` / `fr_announce` from Task 0; FR id map from Global Constraints.

For each FR in number order run `fr_status <id> planned`, confirm the JSON response shows `"status":"planned"`, then `fr_announce <id> "<comment>"` and confirm `results` is non-empty with `ok:true` entries. **After the FIRST announce (#26): if `results` is `[]`, STOP the loop** (preflight failed despite Step 0.1 — destinations changed).

- [ ] **#26** comment: `Planning: The Fleet M365 setup tool will skip clients marked as having no runner. We're adding a per-client "no runner" flag (set it on the client page, e.g. for Dianthus) and the fleet sweep will exclude flagged clients so they no longer queue tests that can never run.`
- [ ] **#27** comment: `Planning: Offboarding will treat a mailbox that is ALREADY a shared mailbox as safely converted. Today the engine only trusts conversions it performed itself, so pre-converted mailboxes parked the case with "license KEPT". The runner will detect the existing shared state and proceed to license removal automatically.`
- [ ] **#28** comment: `Planning: Location lists will exclude inactive ServiceNow locations. The location sync will only pull active cmn_location records, so retired sites stop appearing in case forms and location pickers.`
- [ ] **#29** comment: `Planning: Fixing the password-reset dialog layout. We'll reproduce the visual breakage that appears when changing/typing a custom password and stabilize the dialog so it stays readable in both generate and manual modes.`
- [ ] **#30** comment: `Planning: Onboarding cases will accept additional groups under Fields. You'll be able to type extra group names on the case review panel; they merge into the engine's planned group adds on the right lane (AD vs cloud), with the same protected-groups safety filter as ticket-requested groups.`
- [ ] **#31** comment: `Planning: Password reset before the engine runs. The existing reset action will become available from the case Actions menu while an imported case is still paused, so you can reset the user's password ahead of execution.`
- [ ] **#33** comment: `Planning: Per-client calendar delegate grants. Clients like Logicsource can configure fixed calendar reviewers (e.g. calendar.delegate.reviewer@logicsource.com gets Reviewer) applied to every onboarded user's calendar automatically during the Exchange finish step.`
- [ ] **#34** comment: `Planning: Automated mailbox auditing for CVP clients. The documented Set-Mailbox audit command from the CVP runbook becomes a config-driven onboarding action (audit flags are allowlisted settings, not free-form script), enabled across the CVP family.`

---

### Task 2: FR#28 — inactive locations are not pulled

**Files:**
- Modify: `web/lib/servicenow/locations.ts:36` (the `sysparm_query` in `fetchCmnLocations`)
- Test: `web/lib/servicenow/locations.test.ts`
- Create: `web/lib/changelog/entries/locations-active-only.ts`; Modify: `web/lib/changelog/entries/_registry.ts`

**Interfaces:**
- Consumes: `fetchCmnLocations(config, accountSysId, fetcher)` — `fetcher: typeof fetch` is injectable.
- Produces: unchanged signature; the ServiceNow query gains `^active=true`.

- [ ] **Step 1: Lifecycle** — `fr_status cmrxhcjdk007pyxffbpxm9f9d building`; `fr_announce cmrxhcjdk007pyxffbpxm9f9d "Scripting: Adding an active=true filter to the ServiceNow location sync so refreshing a client's locations only pulls active sites. Existing stored inactive locations disappear on the next refresh."`
- [ ] **Step 2: Failing test** — in `locations.test.ts` add:

```ts
test("fetchCmnLocations asks ServiceNow for active locations only", async () => {
  let captured = "";
  const fetcher = (async (url: RequestInfo | URL) => {
    captured = String(url);
    return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  await fetchCmnLocations({ instanceUrl: "https://x.service-now.com", user: "u", password: "p" } as never, "a".repeat(32), fetcher);
  const q = new URL(captured).searchParams.get("sysparm_query") ?? "";
  assert.ok(q.includes("^active=true"), `sysparm_query missing active filter: ${q}`);
});
```
(Adjust the `SnConfig` literal to the real shape exported from `locations.ts`/`gateway.ts` — copy the config fixture style already used in `gateway.test.ts`.)

- [ ] **Step 3: Run** `cd web && npx tsx --test lib/servicenow/locations.test.ts` — expect FAIL (no `active=true`).
- [ ] **Step 4: Implement** — change the query line to append the filter (mirrors `gateway.ts:124`):

```ts
sysparm_query: `(company=${accountSysId}^ORaccount=${accountSysId})^active=true`,
```
Note the parentheses: `^OR` binds loosely; without grouping, `active=true` would apply only to the second branch. Verify the encoded query in the test.

- [ ] **Step 5: Run** the test again — expect PASS. Run the full suite `npm test`.
- [ ] **Step 6: Changelog + commit** — entry id `locations-active-only`, title `Locations: inactive ServiceNow locations are no longer pulled for clients`, one item explaining refresh behavior. Register in `_registry.ts`. Commit.
- [ ] **Step 7: Ship** — push branch, `gh pr create` (ready, not draft — the loop merges immediately), merge via `./scripts/prs.sh <n> --yes`, confirm merged.
- [ ] **Step 8: Lifecycle done** — `fr_status cmrxhcjdk007pyxffbpxm9f9d done "Location refresh now requests only active ServiceNow locations (active=true on cmn_location). Refresh a client's locations to drop already-stored inactive sites. Web-only; live on next auto-deploy."`; then `fr_announce cmrxhcjdk007pyxffbpxm9f9d "Implemented: The location sync now pulls only ACTIVE ServiceNow locations. Verified by unit test on the ServiceNow query and the full web suite. Inactive sites vanish from pickers after the client's next location refresh. Live with the next auto-deploy."`

### Task 3: FR#26 — fleet setup skips no-runner clients

**Files:**
- Modify: `web/prisma/schema.prisma` (Client model, near `runCloudOnOwnAgent` ~line 146) + new migration
- Modify: `web/lib/jobs/fleet-m365-test.ts:240-271` (`loadTargets`)
- Modify: `web/app/api/clients/[slug]/route.ts` (new action, model on `runCloudOnOwnAgent` handling ~line 195)
- Modify: `web/lib/cases/repository.ts` (setter beside `setRunCloudOnOwnAgent` ~line 376)
- Create: `web/app/clients/_components/no-runner-toggle.tsx` (copy `own-agent-toggle.tsx` shape); Modify: `web/app/clients/[slug]/page.tsx` to render it beside the own-agent toggle
- Test: `web/lib/jobs/fleet-m365-test.test.ts`
- Create: `web/lib/changelog/entries/fleet-m365-skips-no-runner.ts`; Modify: `_registry.ts`

**Interfaces:**
- Produces: `Client.noRunner Boolean @default(false)` — "this client is expected to have no runner; skip fleet sweeps"; `loadTargets` filters `noRunner: false`.

- [ ] **Step 1: Lifecycle** — `fr_status cmrxgc1e8000yyxffyl8iydjf building`; `fr_announce cmrxgc1e8000yyxffyl8iydjf "Scripting: Adding a 'no runner' flag on the client page and teaching the Fleet M365 setup sweep to skip flagged clients (Dianthus first). Flagged clients stop queueing connection tests that would sit pending forever."`
- [ ] **Step 2: Schema** — add to Client:

```prisma
  // This client is expected to have NO runner/agent at all (e.g. Dianthus): fleet sweeps skip it
  // so it never queues tests that can only sit pending.
  noRunner               Boolean      @default(false)
```
`cd web && npx prisma migrate dev --create-only --name client_no_runner` then `npx prisma migrate deploy` is handled at merge (prs.sh offers it). NEVER `migrate dev` without `--create-only` against the shared DB. Run `npx prisma generate`.

- [ ] **Step 3: Failing test** — in `fleet-m365-test.test.ts` add a `loadTargets`-through-`startFleetM365Test` style test using the hand-rolled fakeDb pattern from `web/lib/clients/parent-inheritance.test.ts:34-55`:

```ts
test("fleet sweep excludes noRunner clients", async () => {
  const rows = [
    { id: "c1", slug: "a", name: "A", coreId: "1", primaryDomain: "a.com", noRunner: false, systems: [{ systemKey: "m365", mode: "api", secretNames: [], config: null }], secrets: [] },
  ];
  let captured: unknown;
  const fakeDb = { client: { findMany: async (args: unknown) => { captured = args; return rows; } } } as unknown as PrismaClient;
  await rollupFleetM365Test(fakeDb, { kind: "all" } as never);
  assert.deepEqual((captured as { where: { noRunner: boolean } }).where.noRunner, false);
});
```
(Match `rollupFleetM365Test`'s real signature/scope type from `fleet-m365-test.ts`; assert the `where` clause carries `noRunner: false`.)

- [ ] **Step 4: Run** `npx tsx --test lib/jobs/fleet-m365-test.test.ts` — FAIL. **Step 5: Implement** — in `loadTargets` add `noRunner: false` to the `where` object and `noRunner: true` to `select` is NOT needed. **Step 6: Run** — PASS; full `npm test`.
- [ ] **Step 7: API + setter + toggle** — repository setter:

```ts
async setNoRunner(clientId: string, value: boolean) {
  await db.client.update({ where: { id: clientId }, data: { noRunner: value } });
}
```
Route action (copy the `runCloudOnOwnAgent` block in `web/app/api/clients/[slug]/route.ts`, action name `"set-no-runner"`, same guard, `recordAudit("client.no_runner.set", ...)`). Toggle component: copy `own-agent-toggle.tsx`, label `No runner`, help text `Fleet sweeps skip this client (no agent will ever serve it).` Render on the client page beside the own-agent toggle.

- [ ] **Step 8: Changelog + commit + ship** — entry id `fleet-m365-skips-no-runner`. PR → `prs.sh <n> --yes` (accept the `migrate deploy` prompt). After merge, flag Dianthus: use the new toggle on `/clients/core1180` (or `psql ... "UPDATE \"Client\" SET \"noRunner\" = true WHERE slug = 'core1180';"`) and confirm `/tools/fleet-m365` no longer lists it.
- [ ] **Step 9: Lifecycle done** — `fr_status cmrxgc1e8000yyxffyl8iydjf done "Added a per-client No runner flag (client page toggle, audited) and the Fleet M365 sweep now excludes flagged clients. Dianthus is flagged. Web-only; live on auto-deploy."`; `fr_announce cmrxgc1e8000yyxffyl8iydjf "Implemented: Clients can be marked 'No runner' on their client page, and Fleet M365 setup now skips them — verified by unit tests and by confirming Dianthus (flagged) no longer appears in the sweep. Live now."`

### Task 4: FR#29 — password reset GUI breakage

**Files:**
- Likely modify ONE of: `web/app/cases/_components/generate-password-button.tsx` (manual-mode modal) or `web/app/clients/_components/m365-password-editor.tsx` (inline "Change" box) — decided by reproduction.
- No lib test possible (components aren't under the `lib/**` test glob); verification is visual via Playwright.
- Create: `web/lib/changelog/entries/password-reset-gui-fix.ts`; Modify: `_registry.ts`

**Interfaces:** none (visual fix, no signature changes).

- [ ] **Step 1: Lifecycle** — `fr_status cmrxn1qzh0000z4w6j51ur96c building`; `fr_announce cmrxn1qzh0000z4w6j51ur96c "Scripting: Reproducing the broken password-change layout in a browser (both the case reset dialog's manual mode and the client-page initial-password editor), then fixing whichever breaks so the dialog stays stable while typing a custom password."`
- [ ] **Step 2: Reproduce** — start the worktree dev server (`cd web && npm run dev -- --port 3105`; per the web-dev-verify recipe mint a local session/cookie for the dev DB, or `AUTH_ENABLED=false`). With Playwright MCP: (a) open a case with a verified account line → password reset dialog → switch to **manual** mode → type into the password box, screenshot each state; (b) open `/clients/<slug>` with m365 → Initial password → **Change** → switch modes, screenshot. Identify the visual breakage (overflow, jumping layout, overlapping error text).
- [ ] **Step 3: Fix** — apply the smallest stable-layout change to the broken component (e.g. reserve space for the error/notes with `minHeight`, prevent the modal body reflow, constrain input width). Match existing inline-style idiom.
- [ ] **Step 4: Verify** — re-run the Playwright walk; screenshot before/after states; confirm no breakage in BOTH generate and manual modes (and both editor modes if candidate B). Run `npm test` (guards against accidental lib changes).
- [ ] **Step 5: Changelog + commit + ship** — entry id `password-reset-gui-fix`; PR → `prs.sh <n> --yes`.
- [ ] **Step 6: Lifecycle done** — `fr_status cmrxn1qzh0000z4w6j51ur96c done "<one-liner naming the actual broken component and fix>"`; `fr_announce cmrxn1qzh0000z4w6j51ur96c "Implemented: <what actually broke> is fixed — the password dialog keeps a stable layout while typing a custom password. Verified in-browser on the dev server (before/after screenshots). Live with the next auto-deploy."` (Fill in the real findings.)

### Task 5: FR#31 — password reset before the engine runs

**Files:**
- Modify: `web/lib/jobs/password-reset.ts` (add `pickResetSourceJob`)
- Modify: `web/app/cases/[id]/page.tsx:78-90,151-162` (compute + pass source job)
- Modify: `web/app/cases/_components/case-actions-menu.tsx:57-67` (new row rendering `GeneratePasswordButton`)
- Test: `web/lib/jobs/password-reset.test.ts` (new file)
- Create: `web/lib/changelog/entries/case-prerun-password-reset.ts`; Modify: `_registry.ts`

**Interfaces:**
- Consumes: `PASSWORD_RESET_KEY` map; `GeneratePasswordButton({ jobId, ... })` (check its exact props in `generate-password-button.tsx:100-115` and pass what it requires); the reset route `POST /api/jobs/[id]/reset-password` already works on paused cases.
- Produces: `pickResetSourceJob(jobs: { id: string; systemKey: string; status: string }[]): string | null` — first job whose `systemKey` is in `PASSWORD_RESET_KEY`, preferring `active-directory` > `m365` > `entra` > `google-workspace`.

- [ ] **Step 1: Lifecycle** — `fr_status cmrxn92x3000kz4w64wg5s2jz building`; `fr_announce cmrxn92x3000kz4w64wg5s2jz "Scripting: Surfacing the existing password-reset action in the case Actions menu while a case is paused/pre-run (the reset API already supports paused cases — the button was only shown after the account step ran). Resets queue as a standalone job the runner executes immediately."`
- [ ] **Step 2: Failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResetSourceJob } from "./password-reset";

test("prefers the AD line and falls back through cloud lanes", () => {
  assert.equal(pickResetSourceJob([
    { id: "j2", systemKey: "m365", status: "pending" },
    { id: "j1", systemKey: "active-directory", status: "pending" },
  ]), "j1");
  assert.equal(pickResetSourceJob([{ id: "j3", systemKey: "mimecast", status: "pending" }]), null);
});
```
- [ ] **Step 3: Run** — FAIL (not exported). **Step 4: Implement**

```ts
const RESET_SOURCE_ORDER = ["active-directory", "m365", "entra", "google-workspace"];
export function pickResetSourceJob(jobs: { id: string; systemKey: string; status: string }[]): string | null {
  for (const key of RESET_SOURCE_ORDER) {
    const j = jobs.find((j) => j.systemKey === key);
    if (j) return j.id;
  }
  return null;
}
```
- [ ] **Step 5: Run** — PASS. **Step 6: Wire the UI** — in `page.tsx` compute `const resetSourceJobId = caseMeta.dryRun ? null : pickResetSourceJob(c.jobs)`; pass to `CaseActionsMenu`; there render (gated the same way as `RevealPasswordButton`'s `case.dispatch`-derived flag):

```tsx
{resetSourceJobId && canDispatch && <div className="case-actions-row"><GeneratePasswordButton jobId={resetSourceJobId} /></div>}
```
(Match `GeneratePasswordButton`'s real prop names; if it expects verdict/system context, pass the minimal real values from the source job row.) Verify on the dev server: a paused imported case shows "Reset password" in Actions before any step ran; triggering it creates the ad-hoc job.
- [ ] **Step 7: Changelog + commit + ship** — entry id `case-prerun-password-reset`; PR → `prs.sh <n> --yes`.
- [ ] **Step 8: Lifecycle done** — `fr_status cmrxn92x3000kz4w64wg5s2jz done "The case Actions menu now offers Reset password before the case runs (paused/imported included), reusing the existing ad-hoc reset job + one-time reveal. Web-only; live on auto-deploy."`; `fr_announce cmrxn92x3000kz4w64wg5s2jz "Implemented: You can reset a user's password from the case Actions menu while the case is still paused — before the engine runs anything. Uses the same one-time-reveal reset flow as before; verified on a paused case in the dev environment. Live now."`

### Task 6: FR#30 — additional groups from case fields

**Files:**
- Modify: `web/lib/profiles/plan-resolve.ts:242-262` (extend `strList`; merge `extraGroups` into `reqSec`)
- Modify: `web/app/cases/_components/run-report-view.tsx:534-595` (`ReviewPanel`: editable "Additional groups" input; save via existing fields PATCH; trigger re-plan when changed)
- Modify: `web/lib/servicenow/intake-labels.ts` (label for `extraGroups`)
- Test: `web/lib/profiles/plan-resolve.test.ts` (model on the FR#4 tests at lines 232-302)
- Create: `web/lib/changelog/entries/case-extra-groups.ts`; Modify: `_registry.ts`

**Interfaces:**
- Produces: `payload.extraGroups` (comma-separated string or string array) — routed like security groups: AD lane if present, else m365/entra; filtered by `PROTECTED_GROUPS`; applied on (re-)plan.

- [ ] **Step 1: Lifecycle** — `fr_status cmrxn5lxr000fz4w603k9k2t2 building`; `fr_announce cmrxn5lxr000fz4w603k9k2t2 "Scripting: Adding an 'Additional groups' field to the case review panel. Extra group names merge into the engine's planned group adds on the correct lane (AD when the client has one, otherwise cloud), pass the protected-groups safety filter (no Domain Admins etc.), and apply on re-plan."`
- [ ] **Step 2: Failing tests** — in `plan-resolve.test.ts` (reuse the `job()` factory + payload fixture):

```ts
test("extraGroups land on the AD lane when the client has one", () => {
  const planned = [job("active-directory", {}), job("m365", {})];
  const resolved = resolvePlannedConfigs(client, { ...payload, extraGroups: "GIS Users, Finance Share" }, "onboard", planned);
  assert.deepEqual(resolved.find((j) => j.systemKey === "active-directory")!.config.groups, ["GIS Users", "Finance Share"]);
  assert.equal(resolved.find((j) => j.systemKey === "m365")!.config.groups, undefined);
});
test("extraGroups never add a protected group", () => {
  const planned = [job("active-directory", {})];
  const resolved = resolvePlannedConfigs(client, { ...payload, extraGroups: ["Domain Admins", "Sales"] }, "onboard", planned);
  assert.deepEqual(resolved.find((j) => j.systemKey === "active-directory")!.config.groups, ["Sales"]);
});
```
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** — extend `strList` to split strings and merge extras into `reqSec`:

```ts
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x !== "")
  : typeof v === "string" ? v.split(/[,;]/).map((x) => x.trim()).filter((x) => x !== "")
  : [];
...
const reqSec = safeGroups([...strList(payload.securityGroups), ...strList(payload.extraGroups)]);
```
- [ ] **Step 5: Run** — PASS; full `npm test` (the strList string-split now also affects `securityGroups`/`emailDistroGroups` — confirm no existing test breaks; string support is strictly additive).
- [ ] **Step 6: UI** — in `ReviewPanel`, under the read-only Groups line add a labeled input `Additional groups (comma-separated)` bound to `payload.extraGroups`; include it in the fields-PATCH body on save; when it changed, after the PATCH succeeds call the re-plan endpoint the `ReplanButton` uses (read its fetch URL in `web/app/cases/_components/replan-button.tsx`) so the new groups take effect immediately; `router.refresh()`. Add `extraGroups: "Additional groups"` to `intake-labels.ts`. Verify on the dev server: type a group, save, re-plan runs, the group appears in the planned AD/cloud step config.
- [ ] **Step 7: Changelog + commit + ship** — entry id `case-extra-groups`; PR → `prs.sh <n> --yes`.
- [ ] **Step 8: Lifecycle done** — `fr_status cmrxn5lxr000fz4w603k9k2t2 done "Case review panel accepts Additional groups; they merge into the planned group adds (AD lane when present, else cloud) with the protected-groups filter, applied via automatic re-plan on save. Web-only; live on auto-deploy."`; `fr_announce cmrxn5lxr000fz4w603k9k2t2 "Implemented: Cases now take Additional groups under Fields — extra names merge into the engine's planned group adds on the right lane and the case re-plans automatically on save. Privileged groups are refused. Verified by planner unit tests and a dev-server walkthrough. Live now."`

### Task 7: FR#27 — already-shared mailbox unblocks license removal

**Files:**
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` (`Invoke-CtgExchangeOffboarding`, after `$hasExoMailbox` at line 889; convert block ~895-961)
- Modify: `runner/VERSION` (→ next minor, e.g. `1.97.0`)
- Test: `runner/tests/Coretelligent.Exchange.Tests.ps1` (`Describe 'Invoke-CtgExchangeOffboarding'`, line 190)
- Create: `web/lib/changelog/entries/offboard-already-shared-mailbox.ts`; Modify: `_registry.ts`
- No web code changes (`isConvertConfirmed` already matches the phrase — `web/lib/jobs/mailbox-convert.ts:30`, test at `mailbox-convert.test.ts:18`).

**Interfaces:**
- Produces: a new action line, exact phrase must contain `already a shared mailbox` (the web regex `CONVERT_CONFIRMED` keys on it).

- [ ] **Step 1: Lifecycle** — `fr_status cmrxgj9ay001fyxff1j30cvt7 building`; `fr_announce cmrxgj9ay001fyxff1j30cvt7 "Scripting: Teaching the Exchange offboard step to recognize a mailbox that is ALREADY shared and report it as converted. The license step then proceeds to remove licenses automatically instead of parking the case with 'license KEPT'."`
- [ ] **Step 2: Failing Pester test** — inside the offboarding Describe:

```powershell
It 'reports an already-shared mailbox as converted and does not convert again' {
    Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'SharedMailbox' } }
    Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '10 GB (10,737,418,240 bytes)' } }
    $r = Invoke-CtgExchangeOffboarding -User ([pscustomobject]@{ userToOffboard = 'jane.doe@x.com' }) -Config $null
    ($r.Actions -join "`n") | Should -Match 'already a shared mailbox'
    Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -ParameterFilter { $Type -eq 'Shared' }
}
```
(Match the existing tests' `-User` payload shape at lines 200-262 — copy their param style exactly; offboard payloads carry `userToOffboard`, no UPN.)
- [ ] **Step 3: Run** `~/.local/pwsh/pwsh -Command "Invoke-Pester -Path runner/tests/Coretelligent.Exchange.Tests.ps1 -Output Detailed"` — new test FAILS.
- [ ] **Step 4: Implement** — after `$hasExoMailbox` (line 889), independent of `$wantConvert`:

```powershell
$alreadyShared = $hasExoMailbox -and (Test-CtgCloudMailboxShared -Upn $upn)
if ($alreadyShared) {
    $actions.Add("already a shared mailbox - no conversion needed; the licence is safe to remove")
}
```
and guard the convert work inside the `$wantConvert` block to skip `Set-Mailbox -Type Shared` when `$alreadyShared` (keep the block's other bookkeeping intact).
- [ ] **Step 5: Run** — PASS, full Exchange + M365 suites green. **Step 6:** bump `runner/VERSION` to `1.97.0`.
- [ ] **Step 7: Changelog + commit + ship** — entry id `offboard-already-shared-mailbox`; PR → `prs.sh <n> --yes`.
- [ ] **Step 8: Lifecycle done** — `fr_status cmrxgj9ay001fyxff1j30cvt7 done "The Exchange offboard now emits 'already a shared mailbox' when the cloud mailbox is pre-converted; the license gate (which already recognized the phrase) proceeds to strip licenses without an operator decision. Runner 1.97.0 — takes effect with the next runner deploy."`; `fr_announce cmrxgj9ay001fyxff1j30cvt7 "Implemented: Offboarding no longer keeps licenses when the mailbox was already a shared mailbox — the runner now detects the pre-converted state and the license removal proceeds automatically. Verified with runner unit tests covering the already-shared path end to end. Takes effect with the next runner deploy (1.97.0)."`

### Task 8: FR#34 — CVP mailbox auditing on onboard

The documented script (from core870's runbook, Ardmore Animal Hospital; CVP parent = core802 Community Veterinary Partners, 27 active inheriting children):

```
Set-Mailbox -identity <upn> -AuditEnabled $true
  -AuditAdmin    copy,create,folderbind,harddelete,move,movetodeleteditems,sendas,sendonbehalf,softdelete,update
  -AuditDelegate create,folderbind,harddelete,move,movetodeleteditems,sendas,sendonbehalf,softdelete,update
  -AuditOwner    create,harddelete,mailboxlogin,move,movetodeleteditems,softdelete,update
```
(Practice-manager/lead-vet variant adds `MailItemsAccessed` to AuditAdmin — expressible later as a persona-level config override; v1 ships the regular variant.)

**Files:**
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` (new `Invoke-CtgExchangeMailboxAudit`, modeled on `Invoke-CtgExchangeDefaultMailboxAccess` at lines 1220-1298; export it — update BOTH `Export-ModuleMember` and the `.psd1` `FunctionsToExport`)
- Modify: `runner/Start-IamRunner.ps1:1176-1198` (m365 Onboard handler: read `mailboxAudit` config, extend the ExoFinish trigger + pass-through) and `Invoke-CtgM365ExoFinish` (`:1087-1164`, new `-MailboxAudit` param + call)
- Modify: `runner/VERSION` (next minor after Task 7's, e.g. `1.98.0`)
- Test: `runner/tests/Coretelligent.Exchange.Tests.ps1` (new Describe, model on `Invoke-CtgExchangeDefaultMailboxAccess` at lines 111-161)
- Create: `web/lib/changelog/entries/cvp-mailbox-auditing.ts`; Modify: `_registry.ts`
- Config write (post-merge): CVP family `ClientSystem.config.onboard.mailboxAudit`

**Interfaces:**
- Produces: `Invoke-CtgExchangeMailboxAudit -Upn <string> -Config <object>` returning action strings. Config shape (allowlisted — flags are validated against the EXO audit-action enums, never free text):

```json
{ "enabled": true,
  "auditAdmin":    ["copy","create","folderbind","harddelete","move","movetodeleteditems","sendas","sendonbehalf","softdelete","update"],
  "auditDelegate": ["create","folderbind","harddelete","move","movetodeleteditems","sendas","sendonbehalf","softdelete","update"],
  "auditOwner":    ["create","harddelete","mailboxlogin","move","movetodeleteditems","softdelete","update"] }
```

- [ ] **Step 1: Lifecycle** — `fr_status cmrxzt1rt0033vnwcvb14st4a building`; `fr_announce cmrxzt1rt0033vnwcvb14st4a "Scripting: Building a config-driven mailbox-audit action for onboarding — the CVP runbook's Set-Mailbox audit command becomes allowlisted per-client settings the Exchange finish step applies to every new user. Enabling it for the CVP family once the runner ships."`
- [ ] **Step 2: Failing Pester tests** — new Describe with the module's mock style (`Set-Mailbox` is already stubbed):

```powershell
Describe 'Invoke-CtgExchangeMailboxAudit' {
    It 'applies the configured audit flags' {
        $cfg = [pscustomobject]@{ enabled = $true; auditAdmin = @('copy','create'); auditDelegate = @('create'); auditOwner = @('create','mailboxlogin') }
        $r = Invoke-CtgExchangeMailboxAudit -Upn 'new.user@x.com' -Config $cfg
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $AuditEnabled -eq $true -and ($AuditAdmin -contains 'copy') -and ($AuditOwner -contains 'mailboxlogin') }
        ($r -join "`n") | Should -Match 'enabled mailbox auditing'
    }
    It 'refuses unknown audit actions (allowlist)' {
        $cfg = [pscustomobject]@{ enabled = $true; auditOwner = @('create','Invoke-Expression') }
        $r = Invoke-CtgExchangeMailboxAudit -Upn 'new.user@x.com' -Config $cfg
        ($r -join "`n") | Should -Match 'WARN'
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { -not ($AuditOwner -contains 'Invoke-Expression') }
    }
    It 'does nothing when not enabled' {
        (Invoke-CtgExchangeMailboxAudit -Upn 'x@x.com' -Config ([pscustomobject]@{ enabled = $false })).Count | Should -Be 0
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0
    }
}
```
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** the function following the `DefaultMailboxAccess` pattern (idempotence note: `Set-Mailbox` audit flags are safely re-appliable, so idempotence = unconditional set is fine; WARN-not-throw on failures; `[CmdletBinding(SupportsShouldProcess)]`). Allowlist constant:

```powershell
$script:CtgAuditActionAllowlist = @('copy','create','folderbind','harddelete','mailboxlogin','mailitemsaccessed','move','movetodeleteditems','sendas','sendonbehalf','softdelete','update','send','updatecalendardelegation','updatefolderpermissions','updateinboxrules','applyrecord','recorddelete')
```
Filter each configured list case-insensitively against it; WARN on dropped entries; skip entirely (with WARN) if a filtered list ends up empty while configured. Build the `Set-Mailbox` splat only from surviving flags.
- [ ] **Step 5: Wire the m365 lane** — in `Start-IamRunner.ps1`'s Onboard handler add `$audit = Get-CtgProp $job.config 'mailboxAudit'` and include `-MailboxAudit $audit` when `$audit` (extend the `elseif` trigger condition `... -or $audit`); in `Invoke-CtgM365ExoFinish` add the param and call `Invoke-CtgExchangeMailboxAudit -Upn $u -Config $MailboxAudit` per user inside the connected-EXO section.
- [ ] **Step 6: Run** full Exchange Pester suite — PASS. Bump `runner/VERSION` to `1.98.0`. Verify `.psd1` `FunctionsToExport` includes the new function (module-manifest-export drift gotcha).
- [ ] **Step 7: Changelog + commit + ship** — entry id `cvp-mailbox-auditing`; PR → `prs.sh <n> --yes`.
- [ ] **Step 8: Config rollout** — write the config for the CVP family's m365 systems (parent core802 + the 27 inheriting children resolve systems from the parent — set it on the PARENT's m365 `ClientSystem.config.onboard.mailboxAudit` first, then verify one child's planned onboard config carries it; if inheritance does NOT merge parent config, script per-child updates instead):

```sql
-- inspect first
SELECT cs.id, c.slug, cs.config->'onboard' FROM "ClientSystem" cs JOIN "Client" c ON c.id = cs."clientId" WHERE c.slug = 'core802' AND cs."systemKey" = 'm365';
```
then update via psql `jsonb_set(config, '{onboard,mailboxAudit}', '<json above>')`. Confirm by planning a dry-run onboard for a CVP child and seeing `mailboxAudit` in the exchange/m365 step config.
- [ ] **Step 9: Lifecycle done** — `fr_status cmrxzt1rt0033vnwcvb14st4a done "Onboarding can now apply the CVP-documented Set-Mailbox audit settings automatically: allowlisted mailboxAudit config on the m365 lane, executed in the Exchange finish step. Config set for the CVP family. Runner 1.98.0 — takes effect with the next runner deploy."`; `fr_announce cmrxzt1rt0033vnwcvb14st4a "Implemented: CVP onboarding now enables mailbox auditing per the documented runbook command — audit flags are allowlisted per-client config applied to every new mailbox during the Exchange finish step. Verified with runner unit tests (apply, allowlist-refusal, disabled paths) and a dry-run plan check on a CVP client. Takes effect with the next runner deploy (1.98.0)."`

### Task 9: FR#33 — per-client fixed calendar reviewers (Logicsource)

**Files:**
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` (new `Invoke-CtgExchangeCalendarReviewers`; export in psm1 + psd1)
- Modify: `runner/Start-IamRunner.ps1` (Onboard handler + `Invoke-CtgM365ExoFinish`: read `config.calendar.reviewers`, pass through, call per user) and `Invoke-CtgExchangeHybridOnboard`/`Invoke-CtgExchangeCloudOnboard` callers if the client is exchange-lane (check where `Set-CtgMailboxRegional` is invoked and add the call beside its calendar block at `Coretelligent.Exchange.psm1:439-444`)
- Modify: `runner/VERSION` (→ `1.99.0`)
- Test: `runner/tests/Coretelligent.Exchange.Tests.ps1` (`Add-MailboxFolderPermission` already stubbed at line 22)
- Create: `web/lib/changelog/entries/calendar-reviewer-grants.ts`; Modify: `_registry.ts`
- Config write (post-merge): Logicsource (core1748) `config.onboard.calendar.reviewers`

**Interfaces:**
- Produces: `Invoke-CtgExchangeCalendarReviewers -Identity <string> -Reviewers <array>` returning action strings. Config shape: `config.onboard.calendar.reviewers: [{ "user": "calendar.delegate.reviewer@logicsource.com", "accessRights": "Reviewer" }]`; `accessRights` allowlisted to the EXO folder-permission enum (`Reviewer`,`Editor`,`Author`,`Contributor`,`NonEditingAuthor`,`PublishingAuthor`,`PublishingEditor`,`AvailabilityOnly`,`LimitedDetails`), default `Reviewer`.

- [ ] **Step 1: Lifecycle** — `fr_status cmrxsv24p002kckv101egdp8d building`; `fr_announce cmrxsv24p002kckv101egdp8d "Scripting: Per-client fixed calendar delegates — a config list of reviewers granted on every onboarded user's calendar during the Exchange finish step (Logicsource: calendar.delegate.reviewer gets Reviewer). Same allowlisted-config pattern as the mailbox-audit work; no free-form commands."`
- [ ] **Step 2: Failing Pester tests**

```powershell
Describe 'Invoke-CtgExchangeCalendarReviewers' {
    It 'grants each configured reviewer on the calendar' {
        $rs = @([pscustomobject]@{ user = 'calendar.delegate.reviewer@logicsource.com'; accessRights = 'Reviewer' })
        $r = Invoke-CtgExchangeCalendarReviewers -Identity 'new.user@logicsource.com' -Reviewers $rs
        Should -Invoke Add-MailboxFolderPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $Identity -eq 'new.user@logicsource.com:\Calendar' -and $User -eq 'calendar.delegate.reviewer@logicsource.com' -and $AccessRights -eq 'Reviewer' }
        ($r -join "`n") | Should -Match 'granted calendar.delegate.reviewer@logicsource.com Reviewer on calendar'
    }
    It 'skips a grant the user already holds (idempotent)' {
        Mock Get-MailboxFolderPermission -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ User = 'calendar.delegate.reviewer@logicsource.com'; AccessRights = @('Reviewer') } }
        Invoke-CtgExchangeCalendarReviewers -Identity 'u@x.com' -Reviewers @([pscustomobject]@{ user = 'calendar.delegate.reviewer@logicsource.com' })
        Should -Invoke Add-MailboxFolderPermission -ModuleName Coretelligent.Exchange -Times 0
    }
    It 'falls back to Reviewer for an unlisted accessRights value' {
        Invoke-CtgExchangeCalendarReviewers -Identity 'u@x.com' -Reviewers @([pscustomobject]@{ user = 'd@x.com'; accessRights = 'Owner' })
        Should -Invoke Add-MailboxFolderPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $AccessRights -eq 'Reviewer' }
    }
}
```
(`Get-MailboxFolderPermission` may need a global stub added in `BeforeAll` beside the `Add-MailboxFolderPermission` stub at line 22.)
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** modeled on the manager-reviewer block (`:439-444`) + `DefaultMailboxAccess` iteration/idempotence/WARN pattern: read existing permission via `Get-MailboxFolderPermission -Identity "<id>:\Calendar" -User <user> -ErrorAction SilentlyContinue`, skip when the right is already held, else `Add-MailboxFolderPermission -Identity "${Identity}:\Calendar" -User $u -AccessRights $rights -Confirm:$false`, WARN-not-throw on not-found.
- [ ] **Step 5: Wire** — m365 lane: Onboard handler reads `$cal = Get-CtgProp (Get-CtgProp $job.config 'calendar') 'reviewers'`, extends the ExoFinish trigger, `Invoke-CtgM365ExoFinish ... -CalendarReviewers $cal` calls per user; exchange hybrid/cloud lane: call it where `Set-CtgMailboxRegional` runs (same connected session), reading the same config path.
- [ ] **Step 6: Run** full suite — PASS. Bump `runner/VERSION` to `1.99.0`. Check psd1 exports.
- [ ] **Step 7: Changelog + commit + ship** — entry id `calendar-reviewer-grants`; PR → `prs.sh <n> --yes`.
- [ ] **Step 8: Config rollout** — set Logicsource's m365 (or exchange, whichever lane their onboard uses — check `ClientSystem` rows for core1748) `config.onboard.calendar.reviewers` to `[{"user":"calendar.delegate.reviewer@logicsource.com","accessRights":"Reviewer"}]` via psql `jsonb_set`; verify with a dry-run onboard plan for core1748 showing the config on the step.
- [ ] **Step 9: Lifecycle done** — `fr_status cmrxsv24p002kckv101egdp8d done "Per-client calendar reviewer grants: config-driven list applied to every onboarded user's calendar in the Exchange finish step. Logicsource configured (calendar.delegate.reviewer → Reviewer). Runner 1.99.0 — takes effect with the next runner deploy."`; `fr_announce cmrxsv24p002kckv101egdp8d "Implemented: Every Logicsource onboard now grants calendar.delegate.reviewer@logicsource.com Reviewer on the new user's calendar automatically — expressed as safe per-client config (usable for any client), not a custom script. Verified with runner unit tests (grant, idempotent re-run, rights allowlist). Takes effect with the next runner deploy (1.99.0)."`

---

### Wrap-up (after Task 9)

- [ ] Revoke the minted session (Task 0 Step 5).
- [ ] Confirm the board: `SELECT number, status FROM "FeatureRequest" WHERE number IN (26,27,28,29,30,31,33,34);` — all `done`. #32/#35 untouched (`new`).
- [ ] Report to Evan: per-FR one-liners, runner deploy reminder (1.97.0→1.99.0 pending deploy), and that #32/#35 remain for separate debugging.
