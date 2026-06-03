# Porting the internal onboarding script onto iam-engine

Analysis of Coretelligent's own `Create-NewUser` provisioning script (the interactive
PowerShell wizard the Remote Support team runs to onboard internal staff) against the
`Coretelligent.*` runner modules. The goal: understand what already maps to a module, what's
a gap to fill, and what belongs in the app/profile rather than a module — before we fill the
gaps and write the `coretelligent` client profile.

Treat Coretelligent itself as one more client on the **`ad-synced`** backbone: on-prem AD is
the identity origin, Azure AD Connect syncs up, mailboxes are **hybrid remote mailboxes**
(`Enable-RemoteMailbox` on-prem, homed in Exchange Online).

## The shape mismatch (read this first)

The internal script is a single interactive program doing three jobs at once. iam-engine
splits those three apart on purpose:

| Layer in the script | Where it lives in iam-engine | Becomes a module? |
|---|---|---|
| The wizard (`Get-Role`, `Get-Location`, `Get-Manager`, `Validate-Inputs`, `$steps` loop, progress bar) | Intake — ServiceNow form + app-side case planning | No. Never runs on a runner. |
| The data tables (`$roles`, `$locations`, `$employeeTypes`, `$global_groups`) | Client profile JSON + `ClientSystem.config` rows | No. It is *data*, not code. |
| The body of `Invoke-UserProvisioning` (the actual changes) | Runner executors (`Coretelligent.*`) | Yes — this is the part that maps. |

So "breaking it out" means: the wizard and data tables dissolve into the app plus a
`profiles/coretelligent.json`, and only the *doing* lines get mapped to modules.

## Action-by-action mapping of `Invoke-UserProvisioning`

| Script action | Module / function | Status |
|---|---|---|
| Generate password (`Generate-Passphrase`, calls `makemeapassword.ligos.net`) | `New-CtgCompliantPassword` (`Coretelligent.M365`) | Replace. Module generates locally with a crypto RNG and guarantees policy classes. The external API call is a network-policy and availability risk — drop it. |
| `New-ADUser` (create in OU, enabled) | `Invoke-CtgADOnboarding` | Covered (create + OU + enable). |
| Set Company / City / State / Title / Manager / Department / OfficePhone(DID) / HomePhone(mobile); `ExtensionAttribute4`=startDate; `IpPhone`=extension; `employeeType`; `c`/`co`/`countrycode` | `Invoke-CtgADOnboarding` | **Gap.** The implemented function sets none of these. Largest executor gap. (Note: the module *spec* in `docs/modules/active-directory.md` already lists `Set-CtgADAttributes` + an `attributes` config key — the implementation is behind its own spec.) |
| Global + location + role group adds | `Invoke-CtgADOnboarding` (`groups` + `conditionalGroups`) | Partial — see "conditional groups are the wall" below. |
| OU chosen by condition (`role.OU` as an array of `{Path, Condition}`) | `ou` config (single value) | **Gap.** Module takes one OU; Field Services / Digital Transformation pick the OU by location. |
| `Enable-RemoteMailbox` / `Set-RemoteMailbox` (on-prem hybrid mailbox) | `Coretelligent.Exchange` | **Gap.** That module is offboard-only. No remote-mailbox *enablement* exists anywhere. `Confirm-CtgExchange` asserts "the mailbox is created with the M365 user" — true for cloud-only clients, **false for the hybrid `ad-synced` path**. |
| `Start-ADSyncSyncCycle -PolicyType Delta` | `Invoke-CtgDirectorySync` | Fully covered, and safer — it will not start a second cycle while one is in progress. |
| Poll `Get-Mailbox` until the mailbox appears in EXO | — | **Gap.** No "wait for the sync to land" primitive. This is orchestration the app should own, not a `Start-Sleep` loop inside an executor. |
| `Set-MailboxRegionalConfiguration` (language + timezone) | — | **Gap.** No EXO onboard lane. |
| Calendar permissions: manager → Reviewer; Project Managers → Project Engineer calendars | — | **Gap.** No mailbox-folder-permission executor. (See bug note below — the PM-calendar block is also broken as written.) |
| E5-if-seats-available **else** E3, via group membership | `Invoke-CtgM365Onboarding` | Partial. Module assigns licenses/groups from config but has no seat-count fallback. |
| Salesforce notification email (`RequiresSF`) | — | No module (Salesforce has none). Becomes a `manual` checklist item / notification step on the case. |

## Gaps, ranked by how much they block a faithful port

1. **Conditional groups are the wall.** The script's conditions are arbitrary script blocks —
   `{ $title -eq "Project Engineer" }`, `{ $location.Name -eq "CA" }`,
   `{ $script:user_title -match "^Remote Support" }`,
   `{ $location.Country.Short -eq "US" -and $employeeType.Name -eq "Full-Time" }`. The AD
   module's `Test-CtgCondition` (`Coretelligent.ActiveDirectory.psm1:46`) only understands
   **`field == true|false`**. String equality, regex, AND-combinations, and location-name
   matching are not expressible. Either the profile schema's condition grammar grows, or these
   conditions collapse into more granular roles. This blocks a faithful port more than anything
   else.

2. **AD attribute coverage.** `Invoke-CtgADOnboarding` creates the user + groups + home drive
   and stops. Title, manager, department, phones, country, employeeType, and the
   extensionAttributes are unimplemented. Mechanically simple to add (the spec already names
   `Set-CtgADAttributes`), but it is net-new module code plus an `attributes` config contract.

3. **Hybrid mailbox onboarding does not exist.** `Enable-RemoteMailbox` is the load-bearing
   step for hybrid identity and there is no executor for it. Needs a new
   `Invoke-CtgExchangeOnboarding` (on-prem remote mailbox via the Exchange management session),
   distinct from the cloud-mailbox assumption baked into the current modules.

4. **EXO post-provisioning is unmodeled** — regional config (language/timezone) and calendar
   delegation — and so is the **sync-wait** (poll until the mailbox lands in EXO).

5. **Seat-aware licensing.** The E5-else-E3 fallback (read `PrepaidUnits.Enabled` vs
   `ConsumedUnits`, then add to the matching group) is a policy the M365 onboarding function
   does not express.

## What the port buys you for free

- **Idempotency.** The script is not re-runnable: a second run hits `New-ADUser` /
  `Enable-RemoteMailbox` and throws. Every module checks-before-changing, so a re-run after a
  partial failure converges to the same state. Biggest correctness win.
- **Secrets and config out of the script.** Everything hardcoded at the top — `exchangeServer`,
  `domainController`, `azsync`, `entraTenantId`, `entraApplicationId`, the certificate subject,
  the E5 SkuId and group GUIDs — becomes `ClientSystem.config` plus Delinea `secretNames`. The
  interactive `Get-Credential` and the `Cert:\CurrentUser\My` lookup disappear; the app brokers
  a short-TTL scoped credential at execution time.
- **Verification.** The `Confirm-Ctg*` read-backs give the "did it actually work" check the
  script never had.

## Two bugs worth fixing regardless of the port

- **Project Managers calendar block:** the `else` is dangling — it sits after the
  `Add-MailboxFolderPermission` call inside the `foreach`, with no `if` it can bind to as
  intended. It does not do what the comment describes. The comment's own `#TODO` already flags
  that the logic should grant the *group*, not enumerate current members.
- **`Send-MailMessage`** is deprecated and unreliable for automation, and the `RequiresSF`
  path swallows failures into `Write-Error` — acceptable interactively, invisible when run
  headless.

## Out of scope for the executors (rides along as AD groups)

Zoom, Egnyte, Centrify, RDS, VPN, Outreach, etc. are provisioned in the script purely as AD
**group memberships** (`SSO - Zoom Pro Users`, `Egnyte-CS-*`, `RDS-Users`, `VPN-Split`). For
Coretelligent-internal these are SSO-by-group, so the dedicated SaaS modules
(`Coretelligent.Zoom`, etc.) are not invoked — the group adds in `active-directory` cover
them. Worth confirming when we write the profile.

## Design decisions (locked)

How per-client variation scales without modules sprouting per-client branches. A module is a
generic engine; a client is data; a module never branches on client identity.

- **Conditional logic resolves in the planner, not the modules.** The app already holds the
  full intake + profile, so it flattens `globals + persona + location + conditionals` into a
  concrete per-job `config` (resolved groups, attributes, OU). The runner receives decisions,
  not rules — and the UI can preview the exact plan before anything runs.
- **Only live-state conditions stay in the modules** — the ones the app cannot see: seat-aware
  E5/E3 fallback (reads consumed units) and keep-license-if-mailbox-over-threshold (reads
  mailbox size). Everything role/location/title/option-driven is plan-time data.
- **Personas are a reusable schema concept** (`personas` + `globals`), usable by any role-driven
  client — not a Coretelligent special case. Cloud-only clients omit them.
- **Attributes are a generic map**, not named per-attribute parameters: the module loops over
  `attributes` and sets each (`-Replace`), so a new attribute is a profile edit, zero module
  change.
- **One condition + template grammar** (`$defs/condition`, `{token}` interpolation) used
  everywhere a `when` or a value template appears, across all systems.
- **Schema tightening is light-touch:** AD and M365 config get documented `$defs`
  (`adOnboardConfig`, `m365OnboardConfig`, …) that validate known keys but keep
  `additionalProperties: true`; long-tail systems stay fully open.

## Schema changes shipped (`profiles/_schema.json`, v2.1)

Backward compatible — `schemaVersion` accepts `2.0` and `2.1`; all existing v2 profiles still
validate (raith is a stale `1.0` file that never conformed and is untouched).

- `schemaVersion` widened to `["2.0", "2.1"]`.
- New top-level `globals` and `personas` blocks (config fragments keyed by system key).
- New `$defs`: `condition` (the grammar), `groupList` (plain + conditional group entries),
  `attributeMap` (generic attribute → templated/conditional value), `ouSpec` (string or
  conditional `{path, when}` list), `configFragment`, `persona`.
- AD/M365 config `$defs` wired via `if/then` on the system `key`; `m365OnboardConfig` adds
  `seatAwareLicenses` for the run-time E5/E3 fallback.
- Token templating documented at the schema root (`$comment`).

## Next steps

1. **Planner resolution** (web/app): the merge + condition engine + `{token}` interpolation
   that turns profile + intake → flat `job.config`; ingest `personas`/`globals` in the seed.
2. **Module gaps** (now smaller — they apply flat data): `Set-CtgADAttributes` (generic
   `-Replace` loop over the resolved `attributes`), `Invoke-CtgExchangeOnboarding`
   (`Enable-RemoteMailbox`), EXO regional + calendar, seat-aware E5/E3.
3. **`profiles/coretelligent.json`**: author from the `$roles` / `$locations` /
   `$global_groups` tables against v2.1 — the proof the abstraction holds.
