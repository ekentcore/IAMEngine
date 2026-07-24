# FR Lifecycle Loop 2 — Implementation Plan (2026-07-24)

**Goal:** Work the 5 remaining open feature requests (#32, #35, #36, #37, #38) end-to-end:
plan each (status → `planned` + All-clients chat post), implement each (status → `building`
+ post), and ship each (ready PR + tests green → status → `done` + resolution note +
changelog + post).

**How this run differs from loop 1** (`2026-07-24-fr-lifecycle-loop.md`): PRs are opened
**ready** but NOT merged by the loop — merging stays Evan's call (feedback rule). `done`
resolution notes therefore name the PR and the deploy dependency. Announce posts use the
same `Planning:` / `Scripting:` / `Implemented:` prefixes as loop 1.

**Lifecycle mechanics:** identical to loop 1 — `PATCH /api/feature-requests/:id
{status, resolutionNote}` + `POST /api/admin/feature-requests/:id/announce
{audience:"all", comment}` with a minted `global_admin+` session (mint script staged in
the job tmp dir; the classifier blocks Claude minting, Evan runs the one-liner).
Statuses: `planned` → `building` ("Being scripted") → `done` ("Implemented").

**FR id map (prod):** #32=`cmrxpdzjt006jz4w6khgnyo9o` #35=`cmry1f8hg0063vnwcyv8etrft`
#36=`cmryx1txn00e510f5z6efizhi` #37=`cmrz1gkmg001wclmh0pjv5os2` #38=`cmrz1tjqw00004e6wj2sapjx0`

Runner VERSION assignments (from 1.100.0): #36→1.101.0, #37→1.102.0, #38→1.103.0,
#35→1.104.0. Conflicts between unmerged branches are expected; `prs.sh` resolves to
max+patch at merge time.

---

## FR#32 — Personas: AD stuck in "Every user" options (web-only)

**Root cause:** `Client.globals` on core802 carries an empty `"active-directory": {}`
fragment; the rules editor has `addSystem()` but no way to remove a system key from a
scope — every save PUTs the whole `globals` object back. Not a persona at all ("Every
user (globals)" section), not corruption, planning-inert (no AD ClientSystem on core802).

**Fix:** `removeSystem()` in `web/app/clients/_components/rules-editor.tsx` + per-system
remove control (shown only when the scope's fragment map has the key). Persona scopes
reuse `withPersonaSystem(persona, key, false, action)` — identical semantics to the FR#22
checklist uncheck. Never prune empty persona fragments (membership semantics).

**After deploy:** operator removes AD from Everyone on /clients/core802 and saves — no SQL.

## FR#35 — Google Workspace 400 on core1751 (runner)

**Root cause:** token exchange succeeds; the Directory probe
`GET /users?customer=<x>&maxResults=1` 400s because `Use-CtgGoogleSecret`
(`Start-IamRunner.ps1:643-649`) reads the customer from the secret's `ClientID` field and
Delinea 57051's ClientID holds a non-customer-id value (almost certainly the SA's numeric
OAuth client_id). Bare "400" survives because `Invoke-CtgGoogleApi` rethrows without
`$_.ErrorDetails.Message` and the conn-test error walker reads only InnerException. The
web value-probe hardcodes `my_customer`, so app-side checks all pass.

**Fix:** validate customer shape (`my_customer` or `^C[0-9a-zA-Z]{4,}$`), fall back to
`my_customer` with a WARN naming the field and the correct source (Admin Console →
Account settings → Customer ID); append the scrubbed Google error body to rethrown API
errors. Runner 1.104.0.

**Per-client unblock:** fix Delinea 57051's ClientID (blank it or set the real `C0…` id);
with the runner fix the bad value also self-heals to `my_customer` + WARN. Re-run the
deep retest on /clients/core1751 after deploy.

## FR#36 — AD-synced offboards hide from GAL via AD (web + runner)

**Root cause:** hide-from-GAL is EXO/Google-lane only; EXO refuses dirsynced mailboxes and
WARNs. The AD runner module already honors `hideFromGal: {attribute, value}` on the AD
step, but the planner never injects it — it only honors hand-written client config.

**Fix (web):** `injectHideFromGal` (`web/lib/profiles/plan-resolve.ts:118-135`) gains a
backbone-aware first pass: when `backbone === "ad_synced"`, inject
`{attribute: "msExchHideFromAddressLists", value: "TRUE"}` on the active-directory lane
(respecting `skipGalHide`, per-lane opt-outs on either lane, and explicit client
attributes, which win). `adOwnsHide` computed post-injection makes exchange stand down —
AD hide replaces the EXO attempt.

**Fix (runner):** harden the AD hide write (`Coretelligent.ActiveDirectory.psm1:667-675`):
read-first idempotence, value defaults to TRUE, WARN-and-continue on schema-missing
(never abort disable/OU-move), and `Confirm-CtgAD` verifies the configured attribute
instead of the hardcoded one (skip when unreadable). Runner 1.101.0.

**Post-deploy:** planned cases need a re-plan to pick up the injected config (snapshot
semantics).

## FR#37 — Offboard leaves Microsoft 365 (Unified) groups (runner)

**Root cause (case cmrz0kprn0002clmhy2mmvujx, Six One):** step 3 of
`Invoke-CtgM365Offboarding` skips every mail-enabled group as "managed in Exchange"
(`Coretelligent.M365.psm1:1762`), but the Exchange DL sweep only enumerates
`Get-DistributionGroup`, which never returns Unified groups — 5 groups (61C LNG, 61C
Europe, 61C Market Data, Tomorrow Energy Due Diligence Documents, GAGE) fell between the
lanes silently. Onboard already routes Unified correctly (`mailEnabled -and -not
isUnified`, `:301-303`).

**Fix:** evidence snapshot captures `Unified` (groupTypes); the skip becomes
`MailEnabled -and -not Unified`, so Unified groups flow to the existing idempotent
`Remove-MgGroupMemberByRef`. Dynamic groups stay skipped. Runner 1.102.0.

**Post-deploy:** re-run the m365 step on the case — idempotent, clears the 5 leftovers.

## FR#38 — OneDrive archive target accepts a site name (runner + web cosmetic)

**Root cause:** `Resolve-CtgDriveTarget` (`Coretelligent.M365.psm1:1390-1405`) accepts
only a site URL or a user email; Six One's config stores the runbook's prose name
"Offboarded User Data SharePoint site" → throws, and the catch appends the misleading
Files.ReadWrite.All hint for what is a config-parse error. All 3 clients with
`oneDriveBackup` (six-one, regal, yuma) are broken the same way. The FR's
"<leaver drive>/<target drive> not filled in" is the UI preview's by-design run-time
placeholders (cosmetic confusion).

**Fix:** third resolver branch — bare string = SharePoint site display name, resolved via
Graph `/sites?search=` (strip trailing "SharePoint site"/"site" from the prose; exact
match preferred; refuse zero/ambiguous matches — never guess an archive destination);
app-role hint only on real 403s; preview note "(drives resolved at run time)". Runner
1.103.0.

**Follow-up (config sweep, not this loop):** regal/yuma's "365 Admin OneDrive" names an
account, not a site — set those targets to the client's admin email.

---

## Announce comments

Planning (posted at `planned`):
- **#32** `Planning: Fixing the client rules editor so a system can be REMOVED from a scope. CVP's "Every user" section has an empty active-directory entry that can't be deleted today — the editor can add systems but never remove them. The stray entry is display-only (no AD jobs are planned from it).`
- **#35** `Planning: Root-caused the Google Workspace 400 on connection tests — the credential is fine; the secret's ClientID field is being used as the Workspace customer id and it isn't one. The runner will validate the value, fall back safely, and surface Google's real error text instead of a bare 400.`
- **#36** `Planning: AD-synced offboards will hide the user from the GAL via Active Directory. The engine will set msExchHideFromAddressLists on the AD step automatically (syncs up via Entra Connect) instead of warning that Exchange Online can't modify a directory-synced mailbox.`
- **#37** `Planning: Fixing offboard group removal so Microsoft 365 (Unified) groups are removed too. They were skipped as "managed in Exchange" but the Exchange sweep can't see them — that's why some groups survived offboarding. Dynamic rule-managed groups remain excluded by design.`
- **#38** `Planning: The OneDrive archive step will accept a SharePoint site NAME as its destination (e.g. "Offboarded User Data SharePoint site"), resolving it via Graph site search. Runbooks speak in site names, so the engine will too; ambiguous names are refused rather than guessed.`

Scripting (posted at `building`): per-FR one-liners describing the change being coded
(drafted at flip time from the implementer's actual approach).

Implemented (posted at `done`): per-FR summary naming what shipped, how verified, the PR,
and the deploy dependency (web auto-deploy vs runner version).

## Wrap-up

- Statuses all `done` with resolution notes naming PR + deploy dependency.
- Revoke the minted session (`UPDATE "Session" SET "revokedAt" = now() WHERE "tokenHash" = '<hash>'`).
- Report: PR list for Evan to merge via `./scripts/prs.sh <n> --yes`, runner deploy
  reminder (1.101.0–1.104.0 queue behind the already-pending 1.99.x/1.100.0), the
  regal/yuma config follow-up, and the Delinea 57051 manual fix.
