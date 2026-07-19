# M365 data-access permissioning — design spec

**Date:** 2026-07-18
**Status:** Brainstorming — awaiting user review before writing-plans.

## Context

An offboard for UM0029873 (LogicSource) failed to hand the leaver's data to the delegate:

```
WARN could not grant amelia.vonkennel@logicsource.com access to Alyssa.Mollica@logicsource.com's
OneDrive (needs the Files.ReadWrite.All app role?): Response status code does not indicate success:
BadRequest (Bad Request).
```

Root-cause findings:
- **It's a 400, not a 403.** A missing app role returns 403 Forbidden; a 400 BadRequest means the request itself is malformed or the operation isn't supported as called. So the WARN's hardcoded "needs Files.ReadWrite.All?" guess is misleading.
- **The runner hides the real reason.** `Invoke-CtgM365Offboarding` §4 (`Coretelligent.M365.psm1` ~1504-1547) posts `/drives/{id}/items/root/invite` with `recipients=[{ email }]` and, on failure, logs only `$_.Exception.Message` (the generic HTTP status). Microsoft Graph's JSON body carries `error.code` / `error.message` / `innererror` with the actual cause — we're discarding it.
- **`Files.ReadWrite.All` (the documented application permission for `driveItem: invite`) is not modeled** anywhere in `graph-caps.ts` — not required, not optional — so the connection test, fleet audit, and the auto-generated help page never ask for it. `Sites.*` likewise.
- **SharePoint is unimplemented.** The `sharepoint` catalog entry is `executor: "planned"`. Only OneDrive is touched on offboard; there is no SharePoint site-access grant.
- **The mailbox mirror is opaque.** The shared-mailbox mirror steps through mailboxes but the Actions log summarizes rather than enumerating exactly which mailbox got which permission.

Sources verified live: [`driveItem: invite`](https://learn.microsoft.com/en-us/graph/api/driveitem-invite) (application permission = `Files.ReadWrite.All`/`Sites.ReadWrite.All`; root-item limits on personal drives), [PnP `Add-PnPSiteCollectionAdmin`](https://pnp.github.io/powershell/cmdlets/Add-PnPSiteCollectionAdmin.html) (site-collection-admin grant needs the SharePoint-scoped `Sites.FullControl.All`).

## Decisions (locked with the user)

- **Approach: diagnose + harden, then nail it** — surface Graph's real error, model the permission, fix the messaging, and correct the request to the best-documented form; the next real offboard reveals the true 400 cause with the improved logging.
- **Permission modeling: optional** (warn + continue, like the other offboard-only caps).
- **Scope: build SharePoint site grants in this spec** (site-collection-admin path), plus fold in the **mailbox-mirror evidence listing**.
- **Every feature commits + updates the changelog separately** ([[changelog-after-every-commit]]); the four parts below are four commits (four changelog entries).

## Architecture — four parts

### Part 1 — Harden the OneDrive delegate grant (diagnostic + messaging)

**File:** `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (offboard §4), plus a small shared helper.

- Add `Get-CtgGraphError` — given a caught `Invoke-MgGraphRequest` error, parse `$_.ErrorDetails.Message` (Graph returns the error JSON there) into `@{ Status; Code; Message }`; fall back to `$_.Exception.Message` when no body.
- Rewrite the OneDrive grant `catch` so the WARN carries **Graph's real `code` + `message`**, e.g. `WARN could not grant <d> access to <u>'s OneDrive: <code> — <message>`. Only when the error is a genuine **403 / `Authorization_RequestDenied`** append the actionable hint `the m365-admin app registration needs the Files.ReadWrite.All application role (grant + admin-consent)`. Remove the unconditional "needs Files.ReadWrite.All?" text.
- Keep the documented `/invite` body (email recipient, `requireSignIn:true`, `sendInvitation:false`, `roles:["write"]`) as the primary attempt for shared-item access; the site-collection-admin path (Part 2) is the robust route for **full** OneDrive access.
- Interface: `Get-CtgGraphError` reused by Parts 2 & 4 so every M365 mutation surfaces the real Graph reason, not a bare status.

### Part 2 — SharePoint site grants + robust OneDrive full-access (site-collection-admin)

A user's OneDrive is a SharePoint personal site, so one mechanism serves both.

**New runner capability:** a PnP app-only connection.
- `Connect-CtgSharePointPnP` — `Connect-PnPOnline -Url <admin-or-site-url> -ClientId <m365-admin appId> -Tenant <tenant> -CertificateBase64Encoded/-Thumbprint …` reusing the m365-admin **cert** the EXO lane already uses. Requires the **PnP.PowerShell** module on the runner (new dependency — gate + self-heal like `@playwright/test` / EXO 3.9.2; if absent, WARN and skip, never crash).
- **The permission is a SharePoint-resource app role, not a Graph one:** the m365-admin app registration must hold `Sites.FullControl.All` on **Office 365 SharePoint Online** (resource `00000003-0000-0ff1-ce00-000000000000`), separately consented from the Graph roles. This is called out in the help page (Part 3) as its own line.

**Grants (offboard, when a delegate is named):**
- **OneDrive full access:** derive the leaver's OneDrive site URL from `Get-CtgUserDrive`'s `webUrl`, then `Add-PnPSiteCollectionAdmin -Owners <delegate> -Url <oneDriveSiteUrl>` → the delegate gets full control of the whole OneDrive. This is the reliable "full access" the `/invite` root call cannot guarantee.
- **SharePoint sites:** a new offboard config `sharePointDelegateSites: string[]` (site URLs) on the m365/entra (or `sharepoint`) offboard config. For each, `Add-PnPSiteCollectionAdmin -Owners <delegate> -Url <site>` (admin) — or `Set-PnPTenantSite -Owners` when only the SP-admin role is available. v1 grants **explicitly-configured** sites only; enumerating every site the leaver could touch is out of scope.
- **Gating:** attempted only when a delegate is named AND (the client models `sharepoint` OR `sharePointDelegateSites`/OneDrive-full-access is configured); per-client opt-out mirrors `oneDriveDelegateAccess:false`. Fail-soft: any missing module/permission/site → WARN (with the real reason via `Get-CtgGraphError`/PnP error), never a hard fail.
- Idempotent: `Get-PnPSiteCollectionAdmin` (or the returned "already an admin") → "already has access — no change".

### Part 3 — Model the permissions (caps → tests → instructions)

**Files:** `web/lib/secrets/graph-caps.ts`, `runner/Start-IamRunner.ps1` (`$script:GRAPH_OPTIONAL_CAPS`), `web/lib/secrets/graph-caps.test.ts`, `web/app/help/cloud-auth/page.tsx` (auto-generated — no manual edit).

- **Graph cap (optional):** `{ need: "grant a delegate access to a leaver's OneDrive on offboard", anyOf: ["Files.ReadWrite.All", "Sites.ReadWrite.All"], why: "without it the offboard OneDrive delegate hand-off fails; the step warns and continues" }`. Add to `GRAPH_OPTIONAL_CAPS` in **both** TS and PS, update the `graph-caps.test.ts` deepEqual fixtures, and (optionally) `GRAPH_APP_ROLE_IDS` for portal-consent-by-id. Fix the pre-existing PS↔TS drift found during discovery (PS `$script:GRAPH_OPTIONAL_CAPS` is missing the `MailboxSettings.Read` cap).
- **SharePoint permission (separate resource):** `Sites.FullControl.All` on Office 365 SharePoint Online is **not** a Graph app role, so the existing rights probe (which reads the Graph SP's `appRoleAssignments`) can't see it. Two sub-options for surfacing it, to confirm with the plan:
  - **(3a, minimal)** document-only: add a hard-coded instruction block on `/help/cloud-auth` (like the existing `Exchange.ManageAsApp` block) telling operators to grant SharePoint `Sites.FullControl.All`; the rights test does not verify it (the offboard WARN is the feedback loop).
  - **(3b, complete)** extend the granted-roles reader + a rights row to also read the **SharePoint SP's** `appRoleAssignments` so the connection test verifies `Sites.FullControl.All` like a Graph cap. Larger (a second resource in `readGrantedAppRoles`/`Get-CtgGrantedGraphAppRoles`).
  - **Recommendation:** ship **3a** in this spec (unblocks operators, matches the Exchange-Online precedent), and note 3b as a fast-follow.

### Part 4 — Mailbox-mirror evidence listing

**File:** `runner/modules/Coretelligent.Exchange/Coretelligent.M365` mirror path (`Invoke-CtgExchangeSharedMailboxMirror` / `Invoke-CtgExchangeDefaultMailboxAccess`).

- Where the mirror steps through mailboxes, emit **one Actions line per grant** with the mailbox and the exact right conferred: `granted FullAccess on shared mailbox finance@… (mirrored from J. Smith)`; same for SendAs / SendOnBehalf when granted. Replace/augment any "mirrored N mailboxes" summary so the audit trail lists precisely what access the user received. Same "say what actually happened" discipline as the audit-integrity work — and failures per mailbox WARN with the real reason (`Get-CtgGraphError`), not a swallowed success.

## Non-goals (v1)
- Enumerating every SharePoint site a leaver could access (only explicitly-configured sites + their OneDrive).
- 3b (probe-verifying the SharePoint `Sites.FullControl.All`) unless chosen during planning.
- The Entra/Exchange/M365/TAP step **merge/group** question (separate brainstorm; recommendation: UI grouping, not execution merge).

## Testing
- **Runner Pester:** `Get-CtgGraphError` parses a Graph error body → code/message; the OneDrive catch produces a real-reason WARN and only appends the Files.ReadWrite.All hint on a 403; the PnP grant path adds site-collection admin idempotently and fail-soft when the module/permission is absent (mock PnP cmdlets); the mailbox mirror emits one line per mailbox+permission.
- **Web:** `graph-caps.test.ts` fixture updates pin the new optional cap in both copies; a test that `/help/cloud-auth` renders the new permission (generated from the caps table).
- **Manual/live:** re-run the UM0029873 offboard (or a safe test leaver) after Part 1 to read the real Graph error; validate the PnP site-collection-admin grant against a test site + a test OneDrive.

## Deploy artifacts
Runner minor version bump (new PnP capability + hardened grants); PnP.PowerShell module provisioning on runners; the m365-admin app registration gains `Files.ReadWrite.All` (Graph) and `Sites.FullControl.All` (SharePoint) app roles with admin consent.
