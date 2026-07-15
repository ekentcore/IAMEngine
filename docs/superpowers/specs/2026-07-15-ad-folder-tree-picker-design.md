# AD folder tree picker — full tree, and make the pick take effect

**Date:** 2026-07-15
**Status:** approved (scope A+C), implementing
**Origin:** UM0029706 (PureTech) failed onboarding — `OU=Users` did not exist. The operator
could not pick the right folder because (a) discovery only enumerated OUs, not containers, and
(b) the rules-editor OU picker writes to a field that is silently overridden at plan time.

## Problem

Two independent defects combine into "I can't set the OU, and when I do it doesn't take":

1. **Discovery only returns OUs.** `Invoke-CtgAdDiscovery` runs `Get-ADOrganizationalUnit -Filter *`,
   which never returns *containers* (`CN=Users`, `CN=Computers`, `CN=Builtin`, …). Clients whose
   users live in the default `CN=Users` container (like PureTech, which has no user OU at all) have
   no valid node to pick.

2. **The rules-editor OU picker writes to a shadowed field.** The rules editor writes the OU into the
   persona/global `Fragment.ou` (`Client.globals`/`Client.personas`). At plan time
   `resolveSystemConfig` merges layers `[globals, persona, own]` with `own` last, where `own` is the
   system's own config (`ClientSystem.config.onboard`). Because an OU value is a string/array (not a
   mergeable object), `own.ou` **replaces** the fragment OU. So an operator's rules-editor edit is
   silently overridden by `ClientSystem.config.onboard.ou`, which the rules editor does not expose.
   (Empirically confirmed: setting `config.onboard.ou = CN=Users,…` and replanning produced an AD job
   with `config.ou = CN=Users,…`; the rules-editor value never wins while `own.ou` is set.)

## Goals

- Discovery reports the **full directory tree** — every OU, every container, and the domain root —
  so any folder a user could be created under is pickable.
- The tree picker is available **where the winning value lives** (`ClientSystem.config.onboard.ou`),
  so what you pick is what the runner uses.
- Where the shadowing can still surprise an operator (an OU set in the rules editor while the system
  config also sets one), **warn** rather than silently override.

Non-goal: changing the resolver precedence globally (persona-over-own). That ripples across ~200
clients and is out of scope; we surface and route around the shadowing instead.

## Design

### Part 1 — Full-tree discovery + picker labels

**Runner (`runner/Start-IamRunner.ps1`, `Invoke-CtgAdDiscovery`).** Replace the OU-only query with a
full folder enumeration:

```powershell
$folders = @(Get-ADObject -LDAPFilter '(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=builtinDomain)(objectClass=domainDNS))' -ErrorAction Stop |
  Select-Object -ExpandProperty DistinguishedName)
```

This returns every OU, every container (incl. `CN=Users` and system containers — operator chose
"Everything"), `CN=Builtin` (class `builtinDomain`), and the domain root (`domainDNS`, giving a single
connected tree). Reported back in the existing `ous` field of `POST /api/agents/ad-objects` — the
wire/storage key is unchanged (no migration); it now carries all folder DNs. Groups query unchanged.
Log line updates to "reported N folders, M groups". Bump `runner/VERSION` 1.60.0 → **1.61.0** (minor;
backward-compatible — the app already accepts an arbitrary DN list).

**Picker (`web/app/clients/_components/ad-pickers.tsx`).** The tree already nests by parent DN, so
containers/OUs mix correctly. Fixes:
- `ouName(dn)` → a general `folderLabel(dn)` that strips any leading RDN (`OU=`, `CN=`, `DC=…`). For a
  domain root (`DC=ad,DC=puretechscientific,DC=com`) render the dotted domain (`ad.puretechscientific.com`).
- Icon hint: 📁 for an OU, 🗄 for a `CN=` container, 🌳 (or the domain) for the root — so the operator
  can tell a container from an OU.
- Copy: "OUs"/"filter OUs…"/"No OUs discovered" → "folders"/"filter folders…"/"No folders discovered".
- The extracted `folderLabel`, `parentDn`, and `buildTree` become pure exported helpers with unit tests
  (none exist today).

### Part 2A — OU picker on the winning field (`SystemsEditor`)

`SystemsEditor` (`web/app/clients/_components/systems-editor.tsx`) is the only surface that persists
`ClientSystem.config` (via `PUT /api/clients/:slug/systems` → `repo.replaceSystems`). Today `config` is
a raw JSON textarea; `requiresApproval`/`captureEvidence`/`offboardIntent` are already lifted into
structured controls and merged back into `config` at save (the `offboardIntent` → `config.intent.offboard`
pattern at save time is the model to follow).

- Add a per-row **"Onboarding OU / folder"** control, shown only for the `active-directory` system.
  It has a text input (full DN) plus a 📁 Browse button opening `OuTreePicker`. `onPick` sets the row's
  `onboardOu` state; on save it is merged into `config.onboard.ou` (mirroring `offboardIntent`), so the
  raw JSON textarea stays authoritative for everything else and we avoid live text↔object sync bugs.
- On load, extract `config.onboard?.ou` into `onboardOu` so the field round-trips.
- Data path: `SystemsEditor` needs `adObjects.ous`. The server page (`web/app/clients/[slug]/page.tsx`)
  already selects `adObjects`; thread it through `EditSystemsButton` → `SystemsEditor` as a prop
  (no extra fetch). If empty, the Browse button shows the existing "No folders discovered — use Refresh"
  empty state; the text input still accepts a hand-typed DN.

### Part 2C — Shadow warning in the rules editor

In `rules-editor.tsx`, when a fragment sets `.ou` for a system whose `ClientSystem.config.onboard.ou`
is also set, render a ⚠ note: "The system's base OU (`<dn>`) overrides this. Edit it in Edit systems."
- `getRules` (`repository.ts`) additionally returns a `systemOnboardOu: Record<systemKey, string>` map
  (systems whose `config.onboard.ou` is set). The route (`/api/clients/:slug/rules`) passes it through.
- The rules editor shows the warning next to the OU input for the active system when that map has an
  entry. Purely advisory; no behavior change.

## Testing

- **Runner (Pester):** new test for `Invoke-CtgAdDiscovery` mocking `Get-ADObject` to return a mixed
  OU/container/root set; assert the LDAP filter includes all four classes and the posted `ous` carries
  every DN. (Follows the module's existing mock patterns; run via `~/.local/pwsh/pwsh`.)
- **Web (tsx --test):** unit tests for `folderLabel` (OU/CN/DC/root cases) and `buildTree` (mixed
  container+OU nesting, root as single parent). A test that `SystemsEditor` save merges `onboardOu` into
  `config.onboard.ou` (pure merge helper extracted for testability).
- **Verify:** drive the SystemsEditor OU picker against a client with discovered folders (worktree dev
  server per the web-dev-verify recipe) and confirm the saved `config.onboard.ou`.

## Rollout / files touched

- `runner/Start-IamRunner.ps1` (discovery), `runner/VERSION` (1.61.0), runner Pester test.
- `web/app/clients/_components/ad-pickers.tsx` (labels/icons + exported helpers + test).
- `web/app/clients/_components/systems-editor.tsx`, `edit-systems-button.tsx`,
  `web/app/clients/[slug]/page.tsx` (thread `adObjects`), config-merge helper + test.
- `web/app/clients/_components/rules-editor.tsx`, `web/lib/clients/repository.ts`,
  `web/app/api/clients/[slug]/rules/route.ts` (shadow-warning data + UI).
- `web/lib/changelog/entries.ts` (new entry at top).

No DB migration (reuses `Client.adObjects` JSON and `ClientSystem.config` JSON).
