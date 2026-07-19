# M365 data-access permissioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make offboard OneDrive/SharePoint delegate access work and be diagnosable — surface Graph's real error, grant OneDrive full access + SharePoint site access reliably (PnP site-collection-admin), model the permissions in the rights test + help page, and keep the mailbox-mirror evidence precise.

**Architecture:** Runner-side PowerShell changes to `Coretelligent.M365` / `Coretelligent.Exchange` and `Start-IamRunner.ps1` (a Graph-error helper, a hardened OneDrive grant, a new PnP app-only connection + site-collection-admin grant, a fail-soft PnP module gate), plus web-side permission modeling in `graph-caps.ts` (+ its hand-synced PowerShell copy, pinning tests, and the auto-generated help page).

**Tech Stack:** PowerShell 7 runner (Microsoft.Graph SDK, ExchangeOnlineManagement, **PnP.PowerShell** new dependency); Next.js/TypeScript web; Pester + `tsx --test`.

## Global Constraints

- **Commit + changelog per part** (each of the 4 parts is its own commit with its own `web/lib/changelog/entries/*.ts` entry; changelog `time` = `TZ=America/New_York date +%H:%M` floored to a 15-min boundary **≤ now**, never future — see [[changelog-times-eastern]] and [[changelog-after-every-commit]]).
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Runner exports:** any new function must be in BOTH the module's `Export-ModuleMember` and the `.psd1` `FunctionsToExport` (`ModuleExportParity.Tests.ps1` enforces it).
- **graph-caps.ts and its PowerShell copy (`$script:GRAPH_*` in Start-IamRunner.ps1) are hand-synced** and pinned by `web/lib/secrets/graph-caps.test.ts`. The pre-existing `MailboxSettings.Read` TS-only entry is **intentional** (web-scanner-only; test-annotated) — do NOT "fix" it.
- **tsc baseline:** `npx tsc --noEmit` in `web/` is NOT clean on main (3 pre-existing `warningsDismissed` errors in `run-report-view.tsx`); gate is "no NEW errors beyond those 3".
- **Runner tests:** Pester via `~/.local/pwsh/pwsh`; parse-check edited scripts with `[System.Management.Automation.Language.Parser]::ParseFile`.
- **Part 2 (PnP) live-validation caveat:** PnP.PowerShell + a real SharePoint tenant are NOT available in this environment. Build + unit-test with mocked PnP cmdlets; the actual grant must be validated by the operator on a live tenant (called out in the changelog + PR).
- **Graph app-role ids** must be the APPLICATION ids — verify any new id with `npx tsx scripts/verify-graph-role-ids.ts` before finalizing (the test at `graph-caps.test.ts` pins them).

---

## File Structure
- `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` — new `Get-CtgGraphError`; hardened OneDrive grant (Part 1); OneDrive-full-access-via-PnP call (Part 2).
- `runner/modules/Coretelligent.M365/Coretelligent.SharePoint/` **(new module)** `Coretelligent.SharePoint.psm1` + `.psd1` — `Connect-CtgSharePointPnP`, `Grant-CtgSharePointSiteAccess` (Part 2).
- `runner/Start-IamRunner.ps1` — `Install-CtgPnPModule` + load gate; wire the SharePoint grant into the m365 offboard dispatch; VERSION bump.
- `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` — mailbox-mirror line polish (Part 4).
- `web/lib/secrets/graph-caps.ts` (+ `graph-caps.test.ts`), `runner/Start-IamRunner.ps1` `$script:GRAPH_*` — permission modeling (Part 3).
- `web/app/help/cloud-auth/page.tsx` — hard-coded SharePoint permission block (Part 3).
- `web/lib/changelog/entries/*.ts` (+ `_registry.ts`) — one entry per part.
- Tests: `runner/tests/GraphError.Tests.ps1`, `runner/tests/OneDriveGrant.Tests.ps1`, `runner/tests/SharePointGrant.Tests.ps1`, `runner/tests/MailboxMirrorEvidence.Tests.ps1`.

---

## Task 1 — `Get-CtgGraphError` + harden the OneDrive grant (Part 1)

**Files:** Modify `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (add helper ~near other helpers; edit the two OneDrive catches at ~1512 and ~1550, and the export list ~2337 + `.psd1`). Test: `runner/tests/GraphError.Tests.ps1`.

**Interfaces:**
- Produces: `Get-CtgGraphError` → `[pscustomobject]@{ Status:[int]; Code:[string]; Message:[string] }` from a caught `Invoke-MgGraphRequest` error record. Reused by Tasks 2/5.

- [ ] **Step 1: Write the failing Pester test**

Create `runner/tests/GraphError.Tests.ps1`:
```powershell
BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psd1" -Force }
Describe 'Get-CtgGraphError' {
    It 'extracts code + message from a Graph JSON error body in ErrorDetails' {
        $err = $null
        try {
            $e = [System.Management.Automation.ErrorRecord]::new(
                [Exception]::new('BadRequest'), 'x', 'InvalidOperation', $null)
            $e.ErrorDetails = [System.Management.Automation.ErrorDetails]::new('{"error":{"code":"invalidRequest","message":"The recipient is invalid."}}')
            throw $e
        } catch { $err = $_ }
        $g = Get-CtgGraphError $err
        $g.Code    | Should -Be 'invalidRequest'
        $g.Message | Should -Be 'The recipient is invalid.'
    }
    It 'falls back to the exception message when there is no body' {
        $err = $null
        try { throw [Exception]::new('boom') } catch { $err = $_ }
        (Get-CtgGraphError $err).Message | Should -Match 'boom'
    }
}
```

- [ ] **Step 2: Run it — expect FAIL** (`~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/GraphError.Tests.ps1 -Output Detailed"`) → `Get-CtgGraphError` not recognized.

- [ ] **Step 3: Add the helper** (model on the Zoom 3-tier pattern). In `Coretelligent.M365.psm1`:
```powershell
function Get-CtgGraphError {
    # Extract the real Microsoft Graph error (code + message + HTTP status) from a caught
    # Invoke-MgGraphRequest error record. Graph puts the JSON body in $_.ErrorDetails.Message;
    # fall back to the response stream, then the bare exception message.
    param([Parameter(Mandatory)]$ErrorRecord)
    $status = 0
    try { $status = [int]$ErrorRecord.Exception.Response.StatusCode } catch {}
    $raw = ''
    try { if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $raw = [string]$ErrorRecord.ErrorDetails.Message } } catch {}
    if (-not $raw) { try { $raw = [string]$ErrorRecord.Exception.Message } catch {} }
    $code = ''; $message = $raw
    try {
        $j = $raw | ConvertFrom-Json -ErrorAction Stop
        $inner = if ($j.PSObject.Properties['error']) { $j.error } else { $j }
        if ($inner.PSObject.Properties['code'])    { $code = [string]$inner.code }
        if ($inner.PSObject.Properties['message']) { $message = [string]$inner.message }
    } catch { } # not JSON — keep the raw text as the message
    [pscustomobject]@{ Status = $status; Code = $code; Message = $message }
}
```
Add `'Get-CtgGraphError'` to the `Export-ModuleMember` list (line ~2337) AND to `FunctionsToExport` in `Coretelligent.M365.psd1`.

- [ ] **Step 4: Run it — expect PASS.**

- [ ] **Step 5: Rewrite the OneDrive catches to use it.** Replace the drive-read catch (~1512) and grant catch (~1550):
```powershell
        try { $drive = Get-CtgUserDrive -UserId $userId }
        catch {
            $ge = Get-CtgGraphError $_
            $hint = if ($ge.Status -eq 403 -or $ge.Code -match 'Authorization_RequestDenied') { " — the m365-admin app registration needs the Files.ReadWrite.All application role (grant + admin-consent)" } else { "" }
            $driveReadFailed = $true; $actions.Add("WARN could not read $upn's OneDrive: $($ge.Code) $($ge.Message)$hint")
        }
```
and
```powershell
                catch {
                    $ge = Get-CtgGraphError $_
                    $hint = if ($ge.Status -eq 403 -or $ge.Code -match 'Authorization_RequestDenied') { " — the m365-admin app registration needs the Files.ReadWrite.All application role (grant + admin-consent)" } else { "" }
                    $actions.Add("WARN could not grant $dMail access to $upn's OneDrive: $($ge.Code) $($ge.Message)$hint")
                }
```
(Note the removal of the unconditional "(needs the Files.ReadWrite.All app role?)" text — the hint now appears ONLY on a real 403.)

- [ ] **Step 6: Parse-check + run the module's existing Pester** (`Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1`) → still green; `runner/tests/GraphError.Tests.ps1` green.

- [ ] **Step 7: Changelog + commit.** Add `web/lib/changelog/entries/onedrive-grant-real-error.ts` (`id: "onedrive-grant-real-error"`, today's date, floored Eastern time), title "Offboard OneDrive grant now reports Graph's real error", 1-2 items (the WARN now carries Graph's actual error code + message instead of a bare "BadRequest", and only suggests Files.ReadWrite.All on an actual 403; runner needs deploy). Register in `_registry.ts` id-sorted. Verify `cd web && npx tsx --test lib/changelog/*.test.ts`. Commit `feat(runner): OneDrive grant surfaces Graph's real error (was a bare BadRequest)` + trailer; a second commit `docs(changelog): onedrive grant real error` + trailer.

---

## Task 2 — Model Files.ReadWrite.All as an optional Graph cap (Part 3)

**Files:** Modify `web/lib/secrets/graph-caps.ts`, `web/lib/secrets/graph-caps.test.ts`, `runner/Start-IamRunner.ps1` (`$script:GRAPH_OPTIONAL_CAPS`). Help page auto-updates.

**Interfaces:** adds one entry to `GRAPH_OPTIONAL_CAPS` (both copies) + its Graph app-role id.

- [ ] **Step 1: Verify the app-role id.** Run `cd web && npx tsx scripts/verify-graph-role-ids.ts` (existing) to confirm the APPLICATION app-role id for `Files.ReadWrite.All` (expected `75359482-378d-4052-8f01-80520e7db3cd`) and `Sites.ReadWrite.All` (`9492366f-7969-46a4-8d15-ed1a20078fff`). Use the verified value in Step 3.

- [ ] **Step 2: Update the TS pinning tests first (RED).** In `graph-caps.test.ts`:
  - Append to the `GRAPH_OPTIONAL_CAPS.map(c=>c.anyOf)` deepEqual (after the `Device.ReadWrite.All` entry): `["Files.ReadWrite.All", "Sites.ReadWrite.All"],`
  - Append to the `GRAPH_APP_ROLE_IDS` deepEqual: `"Files.ReadWrite.All": "75359482-378d-4052-8f01-80520e7db3cd",`
  - Add a `need`-regex entry to the "every optional cap maps to a call site" test (~line 225) matching the new cap's `need` (e.g. `/OneDrive.*delegate|delegate.*OneDrive/`).
  Run `npx tsx --test lib/secrets/graph-caps.test.ts` → FAIL (caps not yet added).

- [ ] **Step 3: Add the cap + id (TS).** In `graph-caps.ts`, append to `GRAPH_OPTIONAL_CAPS`:
```ts
  {
    need: "grant a delegate access to a leaver's OneDrive on offboard",
    anyOf: ["Files.ReadWrite.All", "Sites.ReadWrite.All"],
    why: "without it the offboard OneDrive delegate hand-off fails with a permission error; the step warns and continues",
  },
```
Add to `GRAPH_APP_ROLE_IDS`: `"Files.ReadWrite.All": "75359482-378d-4052-8f01-80520e7db3cd",` (verified value).

- [ ] **Step 4: Run the TS tests — expect PASS** (`npx tsx --test lib/secrets/graph-caps.test.ts` and `lib/changelog/*.test.ts`). `npx tsc --noEmit` → only the 3 known errors.

- [ ] **Step 5: Sync the PowerShell copy.** In `runner/Start-IamRunner.ps1` `$script:GRAPH_OPTIONAL_CAPS`, append:
```powershell
    @{ need = "grant a delegate access to a leaver's OneDrive on offboard"; anyOf = @('Files.ReadWrite.All', 'Sites.ReadWrite.All') }
```
(The runner uses this cap — it drives the OneDrive grant — so it belongs in BOTH copies, unlike the web-only MailboxSettings.Read.) Parse-check the script.

- [ ] **Step 6: Confirm the help page renders it.** The optional list in `web/app/help/cloud-auth/page.tsx` maps `GRAPH_OPTIONAL_CAPS` — no edit needed; sanity-read that the new line would render (`suggestedRole` = `Files.ReadWrite.All`).

- [ ] **Step 7: Changelog + commit.** `web/lib/changelog/entries/model-files-readwrite-perm.ts` — title "Files.ReadWrite.All is now in the rights test + setup guide", items (the connection test/fleet audit/help page now ask for Files.ReadWrite.All for the OneDrive delegate hand-off; optional — a miss warns). Commit `feat(perms): model Files.ReadWrite.All as an optional Graph capability` + changelog commit, both with trailer.

---

## Task 3 — SharePoint permission as a non-Graph used role + help block (Part 3, for Part 2)

**Files:** `web/lib/secrets/graph-caps.ts` (`USED_NON_GRAPH_ROLES`, `GRAPH_ESCALATION_ROLES`), `graph-caps.test.ts`, `runner/Start-IamRunner.ps1` (`$script:USED_NON_GRAPH_ROLES`, `$script:GRAPH_ESCALATION_ROLES`), `web/app/help/cloud-auth/page.tsx`.

**Rationale:** the SharePoint site-collection-admin grant (Task 5) needs `Sites.FullControl.All` on the **Office 365 SharePoint Online** resource — a non-Graph app role, exactly like `Exchange.ManageAsApp`. It must therefore be treated like Exchange: added to `USED_NON_GRAPH_ROLES` (so the surplus scan doesn't flag it as unexpected) and documented in a hard-coded help block — NOT added to the Graph caps table, and NOT left as a pure escalation flag (which would contradict the fact that the engine now uses it).

- [ ] **Step 1: Inspect how `USED_NON_GRAPH_ROLES` and `GRAPH_ESCALATION_ROLES` interact.** Read `graphSurplusRoles`/the surplus logic in `graph-caps.ts` (and `Get-CtgGraphSurplusRoles` in the runner). Confirm whether a role in BOTH `USED_NON_GRAPH_ROLES` and `GRAPH_ESCALATION_ROLES` is reported as used or as escalation. Whichever the code does, the goal is: **a granted SharePoint `Sites.FullControl.All` is reported as "used" (needed), NOT as escalation.** If `USED_NON_GRAPH_ROLES` already suppresses escalation, only add to it. If not, also remove/guard the `Sites.FullControl.All` entry in `GRAPH_ESCALATION_ROLES`. Note the finding in your report.

- [ ] **Step 2: Update the tests (RED).** Add `Sites.FullControl.All` to whatever `USED_NON_GRAPH_ROLES` deepEqual/assertion exists (mirror how `Exchange.ManageAsApp` is pinned); adjust the escalation-roles assertion if you removed/guarded the entry. Run `npx tsx --test lib/secrets/graph-caps.test.ts` → FAIL.

- [ ] **Step 3: Make the change (TS).** In `graph-caps.ts`: `const USED_NON_GRAPH_ROLES: readonly string[] = ["Exchange.ManageAsApp", "Sites.FullControl.All"];` and, per Step 1's finding, remove or guard `"Sites.FullControl.All"` in `GRAPH_ESCALATION_ROLES` so the engine's own required role isn't reported as an escalation. Run the tests → PASS.

- [ ] **Step 4: Sync the runner copy.** `$script:USED_NON_GRAPH_ROLES = @('Exchange.ManageAsApp', 'Sites.FullControl.All')` and the matching escalation change in `$script:GRAPH_ESCALATION_ROLES`. Parse-check.

- [ ] **Step 5: Add the hard-coded SharePoint help block** in `web/app/help/cloud-auth/page.tsx`, mirroring the Exchange Online `<h3>` block:
```tsx
      <h3>SharePoint Online — a different API, not Microsoft Graph</h3>
      <ul>
        <li><b>APIs my organization uses</b> → <b>Office 365 SharePoint Online</b> → Application permissions → <code>Sites.FullControl.All</code> — only if this client uses the offboard SharePoint / OneDrive full-access hand-off. The engine adds the delegate as a site-collection administrator via PnP, which Graph cannot do; this is the SharePoint-resource role, not the Graph one.</li>
        <li><code>Sites.FullControl.All</code> here is broad (full control of every site) — grant it only for clients that use this hand-off, and remember the connection test cannot tell the SharePoint grant from the Graph one by name, so verify it against the offboard result.</li>
      </ul>
```

- [ ] **Step 6: Changelog + commit.** `web/lib/changelog/entries/sharepoint-fullcontrol-used-role.ts` — title "SharePoint Sites.FullControl.All is a used permission, not an escalation flag", items. Commit `feat(perms): treat SharePoint Sites.FullControl.All as a used non-Graph role + document it` + changelog commit, trailer.

---

## Task 4 — PnP connection + fail-soft module gate (Part 2)

**Files:** Create `runner/modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psm1` + `.psd1`. Modify `runner/Start-IamRunner.ps1` (`Install-CtgPnPModule` + load gate, mirroring `Install-CtgExoPin`/`$exoAvail`). Test: part of `runner/tests/SharePointGrant.Tests.ps1`.

**Interfaces:**
- Produces: `Connect-CtgSharePointPnP -Url <string> -AppId <string> -Tenant <string> -CertificateBase64 <string> -CertificatePassword <string> -CertificateThumbprint <string>` (cert forms mirror `Connect-CtgExchange`). Uses `Connect-PnPOnline`.

- [ ] **Step 1: Write the failing Pester test** (mock `Connect-PnPOnline`). Create `runner/tests/SharePointGrant.Tests.ps1` (connection part):
```powershell
BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psd1" -Force }
Describe 'Connect-CtgSharePointPnP' {
    BeforeEach { Mock -CommandName Connect-PnPOnline -ModuleName Coretelligent.SharePoint -MockWith { } }
    It 'connects app-only with a base64 cert (writes a temp pfx, passes ClientId+Tenant)' {
        Connect-CtgSharePointPnP -Url 'https://x.sharepoint.com/sites/s' -AppId 'app-id' -Tenant 'x.onmicrosoft.com' -CertificateBase64 ([Convert]::ToBase64String([byte[]](1..10)))
        Should -Invoke Connect-PnPOnline -ModuleName Coretelligent.SharePoint -Times 1 -ParameterFilter { $ClientId -eq 'app-id' -and $Tenant -eq 'x.onmicrosoft.com' -and $Url -eq 'https://x.sharepoint.com/sites/s' }
    }
    It 'throws a clear error when no cert form is provided' {
        { Connect-CtgSharePointPnP -Url 'https://x/s' -AppId 'a' -Tenant 't' } | Should -Throw
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (module/function missing).

- [ ] **Step 3: Create the module.** `Coretelligent.SharePoint.psm1`:
```powershell
# App-only SharePoint access via PnP.PowerShell, reusing the m365-admin certificate (the same
# CertificateBase64/Thumbprint the EXO lane uses). Requires the app to hold the SharePoint-resource
# Sites.FullControl.All application role. Fail-soft: callers WARN and continue if PnP is unavailable.
function Connect-CtgSharePointPnP {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [string]$CertificateBase64,
        [string]$CertificatePassword,
        [string]$CertificateThumbprint
    )
    if ($CertificateBase64) {
        $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-pnp-" + [guid]::NewGuid().ToString('N') + ".pfx")
        try {
            [System.IO.File]::WriteAllBytes($tmp, [Convert]::FromBase64String(($CertificateBase64 -replace '\s', '')))
            $sec = if ($CertificatePassword) { ConvertTo-SecureString ([string]$CertificatePassword) -AsPlainText -Force } else { $null }
            $a = @{ Url = $Url; ClientId = $AppId; Tenant = $Tenant; CertificatePath = $tmp }
            if ($sec) { $a['CertificatePassword'] = $sec }
            Connect-PnPOnline @a
        }
        finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
    elseif ($CertificateThumbprint) {
        if (-not $IsWindows) { throw "a CertificateThumbprint only works on a Windows runner — store the cert as CertificateBase64 on the m365-admin secret (cross-platform)." }
        Connect-PnPOnline -Url $Url -ClientId $AppId -Tenant $Tenant -Thumbprint $CertificateThumbprint
    }
    else {
        throw "Connect-CtgSharePointPnP needs app-only cert auth: CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows). The m365-admin secret has neither."
    }
}
```
`.psd1`: `RootModule='Coretelligent.SharePoint.psm1'`, `FunctionsToExport=@('Connect-CtgSharePointPnP','Grant-CtgSharePointSiteAccess')` (Grant added in Task 5), and `Export-ModuleMember -Function Connect-CtgSharePointPnP, Grant-CtgSharePointSiteAccess` at the end of the psm1. (Both functions must exist before the tests import; add a stub `Grant-CtgSharePointSiteAccess` now, filled in Task 5.)

- [ ] **Step 4: Run — expect PASS** for the connection tests.

- [ ] **Step 5: Add the fail-soft module gate** in `Start-IamRunner.ps1`, mirroring `Install-CtgExoPin` + the `$exoAvail` load gate:
```powershell
function Install-CtgPnPModule {
    if (Get-Module -ListAvailable -Name PnP.PowerShell -ErrorAction SilentlyContinue) { return }
    Write-Warning "PnP.PowerShell not installed — installing it so SharePoint/OneDrive full-access grants can run (offboard hand-off). Best-effort; a host with no gallery access will skip SharePoint grants."
    Initialize-CtgGallery
    try { Install-Module PnP.PowerShell -Scope CurrentUser -Force -AllowClobber -Confirm:$false -AcceptLicense -ErrorAction Stop; Write-Host "  installed PnP.PowerShell" -ForegroundColor Yellow }
    catch { Write-Warning "  could not install PnP.PowerShell: $($_.Exception.Message)" }
}
Install-CtgPnPModule
$pnpAvail = Get-Module -ListAvailable PnP.PowerShell
if ($pnpAvail) { Import-Module "$PSScriptRoot/modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psd1" -Force }
```
Parse-check the script.

- [ ] **Step 6: Commit** (folded with Task 5's changelog — this is the connection scaffolding for the SharePoint feature). `feat(runner): PnP app-only SharePoint connection + fail-soft module gate` + trailer. (No separate changelog; Task 5 ships the user-facing entry.)

---

## Task 5 — SharePoint site + OneDrive full-access grant (Part 2)

**Files:** `runner/modules/Coretelligent.SharePoint/Coretelligent.SharePoint.psm1` (`Grant-CtgSharePointSiteAccess`); wire into the m365 offboard in `Coretelligent.M365.psm1` (OneDrive §4) and/or `Start-IamRunner.ps1` dispatch. Test: `runner/tests/SharePointGrant.Tests.ps1`.

**Interfaces:**
- Consumes: `Connect-CtgSharePointPnP` (Task 4).
- Produces: `Grant-CtgSharePointSiteAccess -SiteUrl <string> -Delegate <string>` → adds the delegate as a site-collection admin; returns an action string; idempotent + fail-soft.

- [ ] **Step 1: Write the failing Pester test** (mock `Add-PnPSiteCollectionAdmin`, `Get-PnPSiteCollectionAdmin`):
```powershell
Describe 'Grant-CtgSharePointSiteAccess' {
    BeforeEach {
        Mock -CommandName Connect-CtgSharePointPnP -ModuleName Coretelligent.SharePoint -MockWith { }
        Mock -CommandName Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { }
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @() }
    }
    It 'adds the delegate as a site collection admin' {
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x.sharepoint.com/sites/s' -Delegate 'amelia@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 1
        $r | Should -Match 'granted amelia@x.com site-collection admin'
    }
    It 'is idempotent when already an admin' {
        Mock -CommandName Get-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -MockWith { @([pscustomobject]@{ Email = 'amelia@x.com' }) }
        $r = Grant-CtgSharePointSiteAccess -SiteUrl 'https://x/s' -Delegate 'amelia@x.com' -AppId a -Tenant t -CertificateBase64 'Yg=='
        Should -Invoke Add-PnPSiteCollectionAdmin -ModuleName Coretelligent.SharePoint -Times 0
        $r | Should -Match 'already'
    }
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `Grant-CtgSharePointSiteAccess`:**
```powershell
function Grant-CtgSharePointSiteAccess {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][string]$SiteUrl,
        [Parameter(Mandatory)][string]$Delegate,
        [Parameter(Mandatory)][string]$AppId,
        [Parameter(Mandatory)][string]$Tenant,
        [string]$CertificateBase64,
        [string]$CertificatePassword,
        [string]$CertificateThumbprint
    )
    Connect-CtgSharePointPnP -Url $SiteUrl -AppId $AppId -Tenant $Tenant -CertificateBase64 $CertificateBase64 -CertificatePassword $CertificatePassword -CertificateThumbprint $CertificateThumbprint
    $existing = @(Get-PnPSiteCollectionAdmin -ErrorAction SilentlyContinue)
    $has = @($existing | Where-Object { [string]((Get-CtgProp $_ 'Email') ?? (Get-CtgProp $_ 'LoginName')) -like "*$Delegate*" }).Count -gt 0
    if ($has) { return "$Delegate already a site-collection admin on $SiteUrl — no change" }
    if ($PSCmdlet.ShouldProcess($SiteUrl, "Add $Delegate as site-collection admin")) {
        Add-PnPSiteCollectionAdmin -Owners $Delegate -ErrorAction Stop
        return "granted $Delegate site-collection admin on $SiteUrl"
    }
    return "would grant $Delegate site-collection admin on $SiteUrl (WhatIf)"
}
```
(This module needs a `Get-CtgProp` copy — add the standard one at the top of `Coretelligent.SharePoint.psm1`.)

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Wire into the offboard.** In the M365 offboard OneDrive §4, when `$pnpAvail` and a delegate is named: after (or instead of) the fragile root `/invite`, call `Grant-CtgSharePointSiteAccess` for the leaver's OneDrive site (derive the site URL from `$drive.WebUrl` — strip the `/Documents...` path to the site root). Also read `sharePointDelegateSites` from config (a string[] of site URLs) and grant each. All fail-soft (wrap in try/catch, WARN via `Get-CtgGraphError`/the PnP error). Pass the m365-admin cert args (`Get-CtgExoCertArgs`) + AppId + tenant through the dispatch (`Start-IamRunner.ps1` `$DISPATCH['m365'].Offboard` / the ExoFinish path already has `$creds['m365-admin']`). Show the exact wiring in the dispatch.

- [ ] **Step 6: Exports + parse-check + regression Pester** (`SharePointGrant.Tests.ps1` green; existing M365/Exchange suites green).

- [ ] **Step 7: Changelog + commit.** `web/lib/changelog/entries/sharepoint-onedrive-fullaccess-grant.ts` — title "Offboard grants the delegate full OneDrive + SharePoint site access (PnP)", items (delegate becomes a site-collection admin on the leaver's OneDrive + any configured SharePoint sites; needs PnP.PowerShell on runners + the SharePoint Sites.FullControl.All app role; **validate on a live tenant**). Commit `feat(runner): SharePoint/OneDrive full-access delegate grant via PnP site-collection-admin` + changelog commit, trailer.

---

## Task 6 — Mailbox-mirror evidence polish (Part 4)

**Files:** `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` (`Invoke-CtgExchangeSharedMailboxMirror`). Test: `runner/tests/MailboxMirrorEvidence.Tests.ps1`.

**Note:** the mirror ALREADY emits one line per changed mailbox+permission (`shared mailbox FullAccess: <name>` etc.). The only gap: those lines don't name the mirror source, so an auditor reading a single line can't tell whose access was copied. Polish: include the source and the SMTP.

- [ ] **Step 1: Write the failing test** (mock `Get-Mailbox`/`Add-MailboxPermission`, assert the action line names the mailbox SMTP + the mirror source):
```powershell
It 'names the mailbox and the mirror source on each grant line' {
    # ... mock a shared mailbox the mirror user has FullAccess on, target does not ...
    $actions = Invoke-CtgExchangeSharedMailboxMirror -NewUser 'jane@x.com' -MirrorUser 'John Smith' # + required mocks
    ($actions -join ';') | Should -Match 'FullAccess on shared mailbox finance@x.com \(mirrored from John Smith\)'
}
```

- [ ] **Step 2: Run — FAIL** (current line is `shared mailbox FullAccess: $name`).

- [ ] **Step 3: Change the grant lines** to include the SMTP + source, e.g. replace `$actions.Add("shared mailbox FullAccess: $name")` with `$actions.Add("granted FullAccess on shared mailbox $($mbx.PrimarySmtpAddress) ($name) — mirrored from $MirrorUser")`, and the same shape for SendAs / SendOnBehalf. Keep the rollup summary. (Small, mechanical; do all three permission lines.)

- [ ] **Step 4: Run — PASS; regression Exchange suite green; parse-check.**

- [ ] **Step 5: Changelog + commit.** `web/lib/changelog/entries/mailbox-mirror-names-source.ts` — title "Shared-mailbox mirror now names each mailbox and who it was mirrored from", items. Commit `feat(runner): shared-mailbox mirror evidence names the mailbox + mirror source` + changelog commit, trailer.

---

## Task 7 — Runner VERSION bump

- [ ] **Step 1:** Bump `runner/VERSION` `1.74.0` → `1.75.0` (new PnP capability + hardened grants — minor, additive). Commit `chore(runner): version 1.75.0 (OneDrive/SharePoint permissioning)` + trailer. (Fold this into Task 5's commit if preferred; a lone version bump needs no changelog.)

---

## Verification (end to end)
- Runner: `~/.local/pwsh/pwsh -NoProfile -Command "Invoke-Pester runner/tests/GraphError.Tests.ps1,runner/tests/SharePointGrant.Tests.ps1,runner/tests/MailboxMirrorEvidence.Tests.ps1 -Output Detailed"` all green; existing M365/Exchange suites unbroken; `ModuleExportParity.Tests.ps1` green (new module + functions exported in both places); parse-check clean.
- Web: `npx tsx --test lib/secrets/graph-caps.test.ts lib/changelog/*.test.ts` green; `npx tsc --noEmit` only the 3 known errors; `/help/cloud-auth` shows the new Files.ReadWrite.All optional line + the SharePoint block.
- **Live (operator, Part 2):** grant the m365-admin app `Files.ReadWrite.All` (Graph) + `Sites.FullControl.All` (SharePoint) with admin consent, install PnP.PowerShell on the runner, re-run the UM0029873 offboard (or a safe test leaver): confirm the real Graph error is now logged, and that the PnP site-collection-admin grant succeeds on the leaver's OneDrive + a configured SharePoint site.

## Deploy artifacts
Runner **1.75.0**; PnP.PowerShell on runners; m365-admin app gains `Files.ReadWrite.All` (Graph) + `Sites.FullControl.All` (SharePoint) app roles + admin consent.

## Self-review notes (coverage vs spec)
Part 1 → Task 1. Part 2 → Tasks 3 (permission), 4 (connection+gate), 5 (grant). Part 3 → Tasks 2 (Files/Sites Graph cap) + 3 (SharePoint non-Graph role + help). Part 4 → Task 6. VERSION → Task 7. The spec's "diagnose-first" is honored by Task 1 shipping the real-error surfacing; Part 2's live-validation limitation is called out in Task 5's changelog + the Verification section.
