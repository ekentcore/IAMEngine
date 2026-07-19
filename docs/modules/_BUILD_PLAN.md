# Consolidated build plan — genuinely-unwritten modules

This is the planning deliverable for every system in `docs/modules/` that has a spec but
**no runner executor**, after the a3d9d5be inventory sweep corrected the one false
negative (Slack — see `docs/modules/slack.md` / `web/lib/modules/catalog.ts`, now
`executor: "built"`). Everything below is still genuinely `planned` in
`web/lib/modules/catalog.ts`.

**Scope**: this document plans steps, permissions, and the exact Delinea field-requirements
template for each module. It does **not** implement any of the vendor PowerShell — those
need operator-supplied API details (base URLs, scopes, an actual Secret Server template id)
and a live tenant to validate against; building them blind would ship unvalidatable code.
When picked up, follow `.claude/skills/new-runner-module/SKILL.md` and model the module on
**Coretelligent.Spanning** (simple REST, 637 lines) or **Coretelligent.M365** (reference
implementation, group-membership helpers). Spec source for each module: `docs/modules/<key>.md`
(shape defined in `docs/modules/_TEMPLATE.md`).

## Delinea template mechanics (applies to every module below)

Per `web/lib/secrets/delinea-templates.ts` + `web/lib/secrets/field-requirements.ts`, a
credential's "exact Delinea template" has three parts:

1. **`FieldReq[]`** in `SECRET_FIELD_REQUIREMENTS` (`web/lib/secrets/field-requirements.ts`)
   — canonical field labels + synonym lists the guided-setup Test/create form validates
   against. **Knowable now** — this is what each section below provides, ready to paste.
   Synonyms MUST mirror whatever the runner's `Use-Ctg<System>Secret` picks by field name,
   so keep them in lockstep when the module ships.
2. **Secret Server numeric `templateId`** — per-Secret-Server-instance, so it is always an
   **operator/env input**: `DELINEA_TEMPLATE_<KEY>` (e.g. `mdm` → `DELINEA_TEMPLATE_MDM`) or
   an entry in the `DELINEA_TEMPLATE_MAP` JSON env var. There is no way to know this from the
   repo; someone with Secret Server admin access has to look up (or create) the template and
   set the env var.
3. **`fieldMap`** (our field label → Secret Server field slug) — auto-derived by
   `defaultFieldMap()` from the **first synonym** of each `FieldReq`, slugified
   (`defaultSlug`: lowercase, alnum only). Only needs a manual override in
   `DELINEA_TEMPLATE_MAP` if the real Secret Server template's field slugs differ from that
   default guess.

So step (a) below ships in this PR-sized unit of work for free once the `FieldReq[]` rows are
added; steps (b)/(c) need an operator with Secret Server access before a client's secret can
be *created* in-app (read-brokering of an already-existing secret needs none of this).

## Standard build steps (per `new-runner-module` skill — repeated per module below only where it differs)

1. **Module** `runner/modules/Coretelligent.<System>/Coretelligent.<System>.psm1` —
   `Set-StrictMode -Version Latest` + local `Get-CtgProp`; one HTTP seam
   `Invoke-Ctg<System>Api` (mocked in tests, never logs secret values);
   `Invoke-Ctg<System>Onboarding` / `…Offboarding` / `Confirm-Ctg<System>` returning
   `[pscustomobject]@{ System='<key>'; Status='ok'; Actions=$actions.ToArray() }`; idempotent
   (check state before changing it); `RetryAfterMinutes` on the return for vendor-side delays.
2. **Manifest** `…/Coretelligent.<System>.psd1` — `RootModule`, `FunctionsToExport`,
   `PowerShellVersion = '7.0'`.
3. **Import** in `runner/Start-IamRunner.ps1` — `Import-Module
   "$PSScriptRoot/modules/Coretelligent.<System>/….psd1" -Force` alongside the others.
4. **Dispatch** — `$DISPATCH['<key>'] = @{ Onboard=…; Offboard=…; Validate=… }` in the big
   `$DISPATCH = @{ … }` hashtable literal (existing entries e.g. `'slack'` at line 1305,
   `'spanning'` at 1296 — model the `Use-Ctg<System>Secret` bridge on
   `Use-CtgSpanningSecret`/`Use-CtgSlackSecret`, called at the start of each lane; skip
   `Connect` if auth is a pure local assignment).
5. **Connection-test probe** — `$CONNTEST_PROBE['<key>'] = { param($job, $creds) … }` in the
   `$CONNTEST_PROBE` block (starts line 2315; per-key overrides like `'slack'` at 2571) — one
   cheap live read so `/health` can prove real access.
6. **Web catalog** — `web/lib/modules/catalog.ts` row (`executor: "built"`, `secret`, `group`,
   optional `helpSlug`) + `web/prisma/seed.ts` `CATALOG` tuple `[key, name, buildTier,
   moduleName]` (a `SystemCatalog` row must exist before any `ClientSystem` can reference the
   key — seed/upsert it before wiring a real client to it).
7. **Field requirements** — the `FieldReq[]` given per module below, in
   `web/lib/secrets/field-requirements.ts`.
8. **Version** — bump `runner/VERSION` (currently `1.74.0`; minor bump for a new module).
9. **Tests** — `runner/tests/Coretelligent.<System>.Tests.ps1` mocking the HTTP seam; cover
   onboard, idempotent re-run, offboard. Run via the `runner-test` skill
   (`~/.local/pwsh/pwsh`, not the system `pwsh`).

Verify: `[Parser]::ParseFile` on the new `.psm1` + `Start-IamRunner.ps1`; `runner-test
<System>` green; `npx tsc --noEmit` in `web/` for the catalog/seed/field-requirements edits.

---

## sharepoint

**Not a new module** — extend `Coretelligent.M365` with site-member add/remove. Secret
`m365-admin` already exists and is already wired (no new Delinea work).

**⚠ Overlap**: PR #125 (in-flight per open threads) already adds a SharePoint PnP
site-collection-admin grant on the M365 module. Reconcile scope at merge — check whether
#125's grant functions already cover "site membership" here, or whether this adds a
different capability (member vs site-collection-admin are different Graph/PnP surfaces).

### Steps
1. Add `Add-CtgSharePointSiteMember` / `Remove-CtgSharePointSiteMember` to
   `Coretelligent.M365.psm1` (Graph `Sites.ReadWrite.All` — check whether the existing
   `m365-admin` app registration already has this scope granted; if not, that's an operator
   action in Entra, not a code change).
2. Add to `Coretelligent.M365.psd1` `FunctionsToExport`.
3. No new `$DISPATCH` entry needed if it hangs off the existing `'m365'` or a new
   `'sharepoint'` key routed through the same `Connect` — decide based on whether SharePoint
   should be independently claimable/retryable from M365 (recommend a separate `$DISPATCH['sharepoint']`
   reusing `$DISPATCH['m365'].Connect`, same pattern as `$DISPATCH['tap']`).
4. `catalog.ts`: flip `sharepoint` row `executor: "planned"` → `"built"` (already has `secret:
   "m365-admin"` — no change needed there). `seed.ts`: add `"Coretelligent.M365"` as the
   `moduleName` on the `sharepoint` CATALOG tuple (currently `["sharepoint", "SharePoint", 3]`
   with no moduleName).
5. No new field-requirements entry — `m365-admin` is already fully specified.
6. Bump `runner/VERSION`.
7. Tests: extend `Coretelligent.M365.Tests.ps1` (or a focused
   `Coretelligent.M365.SharePoint.Tests.ps1`) mocking the site-member Graph calls.

### Permissions / instructions (from docs/modules/sharepoint.md)
Graph `Sites.ReadWrite.All` (or narrower `Sites.Selected` if scoping per-site is preferred —
operator decision, `Sites.Selected` needs an additional per-site grant step). Offboard is
mostly covered by existing M365 group removal + OneDrive handling; this module is onboard
site-membership plus an explicit offboard site-removal path if the group cascade doesn't
already cover it.

### Delinea field-requirements
None — reuses the existing `m365-admin` entry in `field-requirements.ts` verbatim.

### Operator inputs needed
- Confirm the `m365-admin` app registration already has `Sites.ReadWrite.All` (or decide on
  `Sites.Selected` + per-site consent, which is more setup but least-privilege).
- Reconcile with PR #125's PnP grant work before merging — avoid two code paths writing
  SharePoint permissions differently.
- Per-client `sites[]` config values (site names/ids) — these come from the client's
  onboarding runbook, not the repo.

---

## teams

**Hand-written module** (`Coretelligent.Teams`) — Teams/Graph calling + 3-way write-back
(ServiceNow, AD, case notes). Too bespoke for the connector-builder (declarative HTTP can't
express "assign a phone number by area-code lookup, then write to three other systems").

### Steps
Follow the standard 9 steps above. Notable specifics:
- `Invoke-CtgTeamsPhone` (assign by area-code lookup against `phoneByAreaCode{office:code}`)
  and `Set-CtgPhoneWriteBack` (ServiceNow work note + AD `telephoneNumber` attribute + case
  notes — reuse the AD attribute-set helper pattern from `Coretelligent.ActiveDirectory`'s
  `Set-CtgADAttributes` rather than reinventing an LDAP write).
- Depends on `m365` (user must be licensed for Teams Phone/Calling Plan — check via Graph
  before attempting assignment, fail with an actionable message if unlicensed rather than a
  raw API error) and `active-directory` (for the writeback target).
- `$DISPATCH['teams']`: onboard-only lane (per catalog `Lanes: onboard`) — no `Offboard`
  block needed, or route it to a no-op/manual note if the system requires one for
  consistency with the dispatch shape.

### Permissions / instructions (from docs/modules/teams.md)
Secret `teams-admin`: Teams Admin / Graph app registration with Teams calling rights.
**Operator input needed before build**: confirm whether phone-number assignment
(`Set-CsPhoneNumberAssignment`-equivalent) is reachable via pure Graph app-only auth
(client secret, like `m365-admin`) or requires the `MicrosoftTeams` PowerShell module's
app-only auth, which for several calling cmdlets needs a **certificate**, not a client
secret (same shape as the `exchange` secret, not `m365-admin`). This determines whether the
`teams-admin` FieldReq below is correct as written or needs a cert-based field set mirroring
`exchange`'s `CertificateThumbprint`/`CertificateBase64` fields. Verify against a real tenant
before finalizing.

### Delinea field-requirements
Add to `SECRET_FIELD_REQUIREMENTS` in `web/lib/secrets/field-requirements.ts` (mirrors
`m365-admin`'s shape per the task brief — confirm cert-vs-secret per the note above before
shipping):

```ts
// Teams Phone admin app (Teams Admin / Graph with calling rights). Shape mirrors m365-admin
// (appId/secret/tenant) — VERIFY against a live tenant whether Set-CsPhoneNumberAssignment
// actually authenticates with a client secret or needs certificate app-only auth instead
// (several MicrosoftTeams-module calling cmdlets require a cert, like `exchange`'s shape).
"teams-admin": [
  { label: "admin username / app id", anyOf: ["Username", "appID", "AppId", "ApplicationId", "ClientId"], hint: "Entra admin → App registrations → the Teams-calling app → Overview → Application (client) ID" },
  { label: "admin password / client secret", anyOf: ["Password", "Secret", "ClientSecret", "AppSecret"], hint: "same app registration → Certificates & secrets → New client secret → copy the Value (shown once)" },
  { label: "tenant id / domain", anyOf: ["TenantId", "Tenant", "Domain"], orClientDomain: true, hint: "same Overview page → Directory (tenant) ID; or leave blank to use the client's primary domain" },
],
```

### Operator inputs needed
- Confirm client-secret vs certificate app-only auth (see note above) before finalizing the
  FieldReq shape.
- `DELINEA_TEMPLATE_TEAMS_ADMIN` (Secret Server template id) once a template is chosen/created.
- Per-client `phoneByAreaCode{}` and `writeBack[]` config — from each client's runbook
  (`profiles/six-one.json` has a real example already).
- Which Graph/Teams admin roles the app registration needs assigned (Teams Administrator at
  minimum) — an Entra role-assignment action, not a code change.

---

## avd

**Hand-written module** (`Coretelligent.AVD`) — Azure service-principal auth against an AVD
host pool, with stateful reuse-highest-unassigned / deploy-if-none / stop-before-unassign
logic. Imperative state machine, not a good connector-builder fit.

### Steps
Follow the standard 9 steps. Notable specifics:
- `Invoke-CtgAvdAssign`: query the host pool's session hosts, pick the highest-numbered
  **unassigned** one (reuse before deploying new); if none free and `deployIfNone` is set,
  deploy a new session host then assign. `Invoke-CtgAvdUnassign`: **stop the AVD before
  unassigning** if unassign fails first (ordering matters — codify as try-unassign,
  on-failure stop-then-retry, per the spec's stated gotcha).
- Depends on `m365` (licensing) and — on onboard — `active-directory` group membership for
  an "AVD core" security group (reuse `Add-ADGroupMember`/`Resolve-CtgAdGroup`, same helpers
  `printix` below reuses).
- Real client config example: `profiles/six-one.json` (`hostPool`).

### Permissions / instructions (from docs/modules/avd.md)
Secret `m365-admin` per the catalog row today — **but this is very likely wrong as a literal
reuse**: AVD host-pool management is an **Azure Resource Manager** operation
(`Microsoft.DesktopVirtualization/hostPools/*`), not a Microsoft Graph one. The existing
`m365-admin` app registration's Graph client-secret credential does not automatically carry
ARM RBAC rights — that's a separate Azure role assignment (`Desktop Virtualization Virtual
Machine Contributor` or similar, scoped to the host-pool resource group) even if the *same*
app registration is reused for both. Decide at build time whether to literally reuse the
`m365-admin` app id/secret (just add the ARM role assignment to it) or provision a dedicated
service principal — the FieldReq below assumes the former (no new secret) but flag this to
whoever picks it up.

### Delinea field-requirements
None if reusing `m365-admin` as an ARM-authenticated principal (recommended — add the ARM
role assignment to the existing app registration rather than proliferating secrets). If a
dedicated AVD service principal is chosen instead, add an `"avd"` entry with the same
appId/secret/tenant shape as `m365-admin` (copy that block, rename the key).

### Operator inputs needed
- Decide: reuse `m365-admin` app registration (add ARM RBAC role) vs a dedicated AVD service
  principal. Either way, an Azure-side role assignment is a manual portal/CLI action, not
  something the runner can bootstrap.
- Per-client `hostPool`, `reuseHighestUnassigned`, `deployIfNone` config — from the client's
  runbook (`profiles/six-one.json` has a live example).
- If deploying new session hosts is in scope: confirm the VM image/template and networking
  the deploy should use (not knowable from this repo).

---

## mdm

**Hand-written module with a vendor switch** (Addigy / Jamf / Intune) — or three separate
connectors keyed by vendor, if the connector-builder's declarative REST shape is enough per
vendor (worth prototyping Addigy there first since its API is the simplest token+REST shape).
Wipe is a `requiresApproval` destructive action gated server-side (same posture as the
existing Google device-wipe gate — reuse that gating code path, don't reinvent it).

**Name reconciliation**: `catalog.ts`/`seed.ts` already use the key `mdm`; `docs/modules/mdm.md`
calls the secret `mdm-admin`. Recommend keeping `mdm` as the canonical secret name (matches
what's already live in the catalog — less churn) and fixing the doc when this ships.

### Steps
Follow the standard 9 steps, with a vendor dispatch inside the module:
- `Invoke-CtgMdmEnroll` / `Invoke-CtgMdmRetire`, each branching on `$Config.vendor` (addigy |
  jamf | intune) to the right `Invoke-Ctg<Vendor>Api` HTTP seam. **Intune is a special case**:
  it's Graph-native (`deviceManagement/managedDevices`), so an `intune` vendor value could
  route through the *existing* `m365-admin` secret/connection instead of the `mdm` secret —
  decide this up front, since it changes whether `mdm` is even a required secret for
  Intune-only clients.
- Wipe/retire (`Invoke-CtgMdmRetire` with a wipe flag) must check `wipeRequiresApproval` and
  the same server-side approval-gate mechanism used for Google device wipe before executing
  — never gate this in the UI alone.

### Permissions / instructions (from docs/modules/mdm.md)
Per-vendor API, one interface. Real-world field shapes differ enough that this genuinely
needs vendor-specific handling, not one generic REST call:
- **Addigy**: single Bearer API token (Settings → API → generate), region-scoped base URL
  (`https://<region>.addigy.com`).
- **Jamf Pro**: OAuth2 client-credentials (API Role + API Client → Client ID + Client Secret)
  against `https://<instance>.jamfcloud.com/api/oauth/token`, OR legacy Basic Auth
  (username/password) on older Jamf Pro versions — confirm which this client's Jamf instance
  supports.
- **Intune**: Graph `DeviceManagementManagedDevices.ReadWrite.All` — likely reuses
  `m365-admin` rather than a new secret (see above).

### Delinea field-requirements
```ts
// MDM (Addigy | Jamf | Intune, vendor set per-client in config, not in the secret). Intune
// clients should reuse m365-admin instead of this secret — see build-plan note. Synonyms
// cover Addigy's single-token shape and Jamf's OAuth client-credentials shape; confirm
// against Coretelligent.Mdm's actual Use-CtgMdmSecret picks once written.
mdm: [
  { label: "api token / client secret", anyOf: ["ApiKey", "API Key", "Token", "AccessToken", "Access Token", "ClientSecret", "Secret", "Password"], hint: "Addigy: Settings → API → generate a token. Jamf Pro: Settings → API roles and clients → your API client → Client Secret." },
  { label: "client id / username", anyOf: ["ClientId", "ClientID", "Client ID", "Username", "AppId"], optional: true, hint: "Jamf Pro OAuth API Client ID (client-credentials flow). Not needed for Addigy's single-token auth." },
  { label: "instance url / region", anyOf: ["BaseUrl", "Base URL", "Url", "URL", "InstanceUrl", "Instance URL", "Region"], hint: "Addigy: https://<region>.addigy.com — Jamf Pro: https://<instance>.jamfcloud.com" },
],
```

### Operator inputs needed
- Which vendor(s) are actually in use across the client base (Addigy/Jamf/Intune mix) —
  determines whether all three branches are needed on day one or just the most common one.
- Per-vendor credentials for each client that has MDM configured (token, OAuth client
  id/secret, or reuse `m365-admin` for Intune clients).
- Confirm Jamf Pro auth style per client (OAuth vs legacy Basic) — this is an instance-level
  setting, not knowable in advance.
- `DELINEA_TEMPLATE_MDM` once a Secret Server template is chosen/created.
- Sign-off on reusing the existing Google-wipe approval-gate mechanism for MDM wipe, or
  whether it needs its own gate.

---

## dropbox

**Connector-builder candidate** (named explicitly in `docs/CONNECTOR_BUILDER.md`) — plain
REST CRUD (invite member / team-folder add / file-transfer / deactivate member), no
PowerShell needed. Build as an `http`-kind Connector (Prisma `Connector` row, `key
custom-dropbox` or similar), not a new `Coretelligent.*` module.

**Name reconciliation**: `catalog.ts`/`seed.ts` key is `dropbox`; `docs/modules/dropbox.md`
calls the secret `dropbox-admin`. Recommend the connector's `secretNames` use `dropbox` to
match the existing catalog entry.

### Steps (connector-builder path, per docs/CONNECTOR_BUILDER.md — NOT the 9-step runner-module checklist)
1. Author the connector definition in `/connectors`: `baseUrl` (`https://api.dropboxapi.com`
   / `https://api.dropbox.com`), host allowlist, auth (Bearer token), operations for
   invite/add-to-team-folder/transfer-files/deactivate, lanes (onboard: invite + team-folder;
   offboard: transfer then deactivate — ordering matters, never deactivate before transfer
   confirms).
2. Import via HAR capture (`import-har.ts`) if the exact request/response shapes aren't
   already known from Dropbox's API docs, or hand-author if they are (Dropbox's Business API
   is well-documented REST/JSON, so hand-authoring may be faster than a HAR capture here).
3. Publish → `syncCatalog` creates the `SystemCatalog` row automatically (`defaultMode:
   "api"`) — no manual `catalog.ts`/`seed.ts` edit needed, unlike a hand-written module.
4. Add the `dropbox` `FieldReq[]` below regardless of connector vs hand-written path (the
   guided-setup Test still validates against `field-requirements.ts`).

### Permissions / instructions (from docs/modules/dropbox.md)
Dropbox Business API (team admin scope). Onboard: provision member + add to team folders.
Offboard (the dominant case — ~19% of clients, offboard-weighted): **transfer files to the
delegate first, then deactivate** — never deactivate before the transfer completes (data-loss
risk). See `data-transfer` below for how the recipient is resolved.

### Delinea field-requirements
```ts
// Dropbox Business API — a long-lived team-admin access token is the common integration
// shape; app key/secret are only needed if refreshing a short-lived OAuth token instead.
dropbox: [
  { label: "team admin access token", anyOf: ["AccessToken", "Access Token", "Token", "ApiToken", "API Token", "Password"], hint: "Dropbox App Console → your Business app → generate an access token scoped to team management (members.write, members.read, team_data.member)" },
  { label: "app key", anyOf: ["ClientId", "ClientID", "Client ID", "AppKey", "App Key", "Username"], optional: true, hint: "Dropbox App Console → your app → App key — only needed if refreshing a short-lived access token via OAuth" },
  { label: "app secret", anyOf: ["ClientSecret", "Client Secret", "AppSecret", "App Secret", "Secret"], optional: true, hint: "Dropbox App Console → your app → App secret — only needed alongside the app key for OAuth refresh" },
],
```

### Operator inputs needed
- Confirm connector-builder vs hand-written module (recommend connector-builder — REST CRUD,
  no bespoke state machine).
- Whether a long-lived access token is acceptable per client, or the OAuth refresh flow is
  required (Dropbox tokens can be scoped as long-lived for team-admin apps — confirm per
  Dropbox's current API terms at build time).
- `DELINEA_TEMPLATE_DROPBOX`.
- Per-client `transferTarget`/`teamFolders[]` config from the runbook.

---

## notion

**Connector-builder candidate** for the invite call; "accept the invite from the user's
mailbox" stays a manual/checklist step regardless (it requires the new user's own mailbox
access, which no admin credential can do on their behalf).

**Name reconciliation**: `catalog.ts`/`seed.ts` key is `notion`; `docs/modules/notion.md`
calls the secret `notion-admin`. Recommend `notion` to match the catalog.

**⚠ Design fork — resolve before building**: Notion's public API has no general-purpose
"add a workspace member" endpoint outside of Enterprise-plan SCIM. On Team/Plus/Business
plans (the likely case for a ~1%-of-clients long-tail system), membership is actually driven
by **Google SSO auto-provisioning** — i.e. there may be nothing to call at all beyond
ensuring the user exists in `google-workspace` and is in the right Google group, with Notion
picking them up on first SSO sign-in. Confirm each Notion client's plan tier before deciding
between:
  - **(a) SCIM path** (Enterprise only): a real `notion` Bearer-token secret + connector,
    genuinely provisions the member via API.
  - **(b) Google-SSO path** (Team/Plus/Business): no new secret at all — this "module" is
    really just a config flag on the `google-workspace` lane (ensure group membership) plus
    a manual checklist item for "invite via Notion admin console" if the client wants
    day-one enrollment rather than waiting for first sign-in.

### Steps (assuming path (a), SCIM — the only path that's a real API integration)
1. Connector definition: `baseUrl https://api.notion.com`, Bearer auth, one operation
   (`POST /scim/v2/Users` or whichever SCIM endpoint Notion Enterprise exposes — confirm
   against Notion's current SCIM docs at build time, this is Enterprise-gated and not
   documented in this repo).
2. Publish → `syncCatalog`, same as `dropbox`.
3. Manual checklist item for mailbox-invite-accept stays regardless of path chosen.

### Permissions / instructions (from docs/modules/notion.md)
Secret: `notion-admin` per the doc (often the Google admin credential for SSO — reinforcing
the design-fork above). Onboard-only lane, `on-request`.

### Delinea field-requirements
```ts
// Notion — ONLY needed if the client is on Notion Enterprise (SCIM). Team/Plus/Business
// clients provision via Google SSO auto-provisioning instead (no secret here — see
// docs/modules/_BUILD_PLAN.md's notion section for the design fork).
notion: [
  { label: "SCIM bearer token", anyOf: ["Token", "ApiToken", "API Token", "AccessToken", "Access Token", "Password"], hint: "Notion Enterprise only — Admin → Security → SCIM Provisioning → generate a token. Team/Plus/Business plans have no member-provisioning API; use Google SSO auto-provisioning instead" },
],
```

### Operator inputs needed
- Confirm each Notion client's plan tier (Team/Plus/Business vs Enterprise) — this decides
  whether any new secret/connector is even built, or whether it's just a `google-workspace`
  config flag + manual checklist item.
- If Enterprise/SCIM: the exact SCIM endpoint path/payload shape (not in this repo; pull from
  Notion's current Enterprise SCIM docs).
- `DELINEA_TEMPLATE_NOTION` if the SCIM path is built.

---

## printix

**Not a vendor API integration** — per `docs/modules/printix.md`, printers are assigned by
geo security-group membership, so this is "verify/assign a group", not a Printix API call.
Cheapest of the unbuilt modules: reuse the *existing* group-membership helpers rather than
write new ones.

- Entra/M365 side: `Add-CtgGroupMember` + `Resolve-CtgEntraGroupId` in
  `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (already idempotent — "already
  a member" counts as success).
- AD side: the native `Add-ADGroupMember` cmdlet + `Resolve-CtgAdGroup` in
  `runner/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psm1`.

**No new secret needed if group-driven** — it rides on whichever backbone secret
(`m365-admin` or `ad-dc`) is already wired for that client. The catalog's current `secret:
"printix"` on the `printix` row (still `planned`) should be **removed** when this ships —
there is no Printix-specific credential to broker.

### Steps
1. New thin file `runner/modules/Coretelligent.Printix/Coretelligent.Printix.psm1` (or fold
   directly into the dispatch block with no new module, since it's just calling existing
   helpers — a thin module is still preferable for a clean `Confirm-CtgPrintix` verify step
   and Pester coverage) — `Invoke-CtgPrintixOnboarding` resolves `geoGroups{location:group}`
   for the user's location and calls `Add-CtgGroupMember`/`Add-ADGroupMember` depending on
   which backbone the group lives in; `Confirm-CtgPrintixAssignment` re-reads membership.
2. No offboard lane needed per the catalog (`Lanes: onboard` only) — offboard cascades
   automatically via the existing AD/M365 group-removal-on-disable path, nothing
   Printix-specific to do.
3. `$DISPATCH['printix']` — `Onboard` calls the new function; `Connect` reuses
   `$DISPATCH['m365'].Connect` or the AD connect, whichever backbone applies (may need a
   per-client branch if some clients are AD-groups and others are M365-groups for this).
4. `catalog.ts`: flip to `executor: "built"`, **drop** `secret: "printix"` (no credential).
   `seed.ts`: add `"Coretelligent.Printix"` as moduleName (or the M365/AD module name if
   folded in without a new module).
5. No new field-requirements entry (see above).
6. Bump `runner/VERSION`.
7. `Coretelligent.Printix.Tests.ps1` mocking `Add-CtgGroupMember`/`Add-ADGroupMember`, cover:
   already-a-member idempotency, group-not-found config error, geo lookup miss.

### Permissions / instructions (from docs/modules/printix.md)
No Printix API auth. Whatever permissions the backbone secret (`m365-admin` Graph
`GroupMember.ReadWrite.All`, or the AD service account's group-write rights) already has is
sufficient — this is pure group membership.

### Delinea field-requirements
None. No new secret.

### Operator inputs needed
- Per-client `geoGroups{location:group}` mapping (which AD/M365 group corresponds to which
  office) — from the client's onboarding runbook, not the repo.
- Confirm no client actually needs a direct Printix API call (e.g. for reporting/print-quota,
  not covered by group membership) — the doc only describes the assignment side.

---

## data-transfer

**Not a module** — cross-cutting offboard plumbing that calls other modules' own transfer
functions (mailbox delegate/convert in `exchange`, OneDrive backup in `m365`/`sharepoint`,
Google Drive/Calendar ownership transfer in `google-workspace`, file transfer in `dropbox`).
Centralizing this doc section is about defining the recipient/retention rules **once** per
case rather than duplicating them in every owning module.

### Steps
This does **not** get its own `$DISPATCH` entry, `catalog.ts` row's build status flip, or
Delinea secret — it's implemented as:
1. A shared resolver (e.g. `lib/offboard/resolve-recipient.ts` on the app side, or a runner
   helper called by each owning module) that reads `provideMailboxAccessTo` /
   `allowedToMaintainEmail` / `recipient` (manager|delegate|named) once per case and hands
   the resolved identity to every owning module's offboard function.
2. Each owning module's `…Offboarding` function calls its own transfer primitive against
   that resolved recipient **before** the corresponding access-removal step in the same
   function (ordering is the safety property here — never remove access before the transfer
   is confirmed). This means `exchange`, `m365`/`sharepoint`, `google-workspace`, and
   `dropbox` each need a transfer branch added to their existing `…Offboarding` functions,
   not a new module.
3. `captureEvidence` (existing pattern, see the cross-cutting notes in `docs/modules/_INDEX.md`)
   records the pre-removal state on each transfer for audit.
4. Retention-aware: only back up when `retention.backupIfUnderDays` says the mailbox/data is
   under the policy window — otherwise skip the backup and go straight to conversion/removal.

The `data-transfer` row already exists in `catalog.ts`'s "Backlog (no executor)" group; once
each owning module's transfer branch is real, either leave that row as documentation-only (it
has no dispatch key to flip) or repurpose it to point at whichever module now implements the
default recipient-resolution logic.

### Permissions / instructions (from docs/modules/data-transfer.md)
No new auth — uses whatever secret each owning module already has (`exchange`, `m365`,
`google-admin`, `dropbox`). The functionally interesting part is recipient resolution and
ordering, not new API surface.

### Delinea field-requirements
None — no new secret.

### Operator inputs needed
- Confirm the recipient-resolution precedence (explicit `recipient` field vs manager
  lookup vs a hard "no recipient configured" failure mode) matches how clients actually fill
  out the offboard intake today — this is a business-logic decision, not an API detail.
- Per-client `retention{backupIfUnderDays,target}` defaults where a client hasn't specified
  one.

---

## archive

**Infra-blocked, not a vendor module.** The Google/M365 archive *actions* themselves are
simple (move to an Inactive Users OU + Archive User in Google; confirm mailbox
shared+licensed appropriately in M365 — Spanning archive licensing is already handled
elsewhere per `spanning-archive-not-convertible` memory). What's missing is the **scheduling
substrate**: today's `Job` model (`web/prisma/schema.prisma` `model Job`) has no
`notBefore`/`scheduledFor` column — every job is claimable the moment it's created. A 30–90
day deferred step needs a due-date mechanism that doesn't exist yet.

### Steps (infra first, then the thin action layer)
1. **Decide the scheduling shape** — two viable designs:
   - (a) Add `notBefore DateTime?` to `Job` and filter it into the existing candidate-fetch
     query (`@@index([status, mode])` path) — cheapest, but touches the hot polling path
     every runner hits every ~5s; needs care not to regress the existing index.
   - (b) A separate `ScheduledArchive` table (clientId, userId, dueAt, target config) plus a
     lightweight cron/heartbeat sweep (mirrors the existing `ProcurementWatch`
     heartbeat-driven pattern already in this schema) that **creates** the real `Job` row
     when `dueAt` arrives, rather than teaching the hot job-claim path about a `notBefore`
     filter. Recommended — reuses a pattern already proven in this codebase
     (`ProcurementWatch`) instead of inventing a new one on the hot path.
2. Once (b) is in place: `Invoke-CtgArchive` (Google: ensure Inactive Users OU + Archive
   User; M365: confirm mailbox conversion/licensing state) — this part is a normal module
   build following the standard 9 steps, `$DISPATCH['archive']`, etc.
3. `immediateTermination` in the case payload should collapse the scheduled wait to "due
   now" — the sweep/creation logic needs to check this flag at case-creation time, not only
   at the eventual due date.
4. The window (`offsetDaysMin`/`offsetDaysMax`) must be captured before case close — if a
   client's runbook doesn't specify one, the engine should flag it for the requestor rather
   than silently defaulting (per the existing spec note: "it cannot be skipped").

### Permissions / instructions (from docs/modules/archive.md)
Reuses `google-admin`/`m365-admin` — no new secret. The work here is entirely the scheduling
substrate, not new API auth.

### Delinea field-requirements
None — no new secret.

### Operator inputs needed
- Sign-off on scheduling design (a) vs (b) above — an infrastructure decision with
  performance implications on the hot job-claim path, worth a deliberate choice rather than
  defaulting silently.
- Sweep interval (how often the due-date check runs) — an operational tuning knob, not
  knowable from the repo alone.
- Per-client default `offsetDaysMin`/`offsetDaysMax` where a runbook doesn't specify one.

---

## tableau, uniflow — manual by design, do not build

Both are **out of backlog**, not merely deprioritized:

- **tableau**: `docs/modules/tableau.md` states it explicitly — "champion-driven; not worth
  API automation at current volume" (<1% of clients, onboard-only, license handled by a named
  application champion, not a self-service path). It is not even present in
  `web/lib/modules/catalog.ts`'s `MODULES` list today (only in `seed.ts`'s `SystemCatalog`
  seed, tier 3) — leave it that way; do not add a catalog row implying it's a build
  candidate.
- **uniflow**: has **no spec doc** in `docs/modules/` at all (only a `SystemCatalog` seed row,
  `["uniflow", "UniFlow secure printing", 3]`, tier 3, no moduleName). Same treatment as
  tableau: not in `catalog.ts`, no build candidate. If UniFlow automation is ever requested,
  it needs a spec doc written first (following `_TEMPLATE.md`) before any build planning is
  meaningful — there's nothing in this repo to plan against today.

Rationale for recording this here rather than silently skipping both: it closes out the
inventory sweep's question of "is this actually unplanned, or just missing a checkbox" —
both are intentionally manual/out of scope, not gaps.
