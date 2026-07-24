# Installing the iam-engine runner on a client DC (on-prem agent)

**Why you need this:** `active-directory` and `directory-sync` are **on-prem-only**
(`ALWAYS_ON_PREM_SYSTEMS`) — the central cloud runner will never claim them. Any
`ad-synced` or `ad-standalone` client therefore needs a **client-network agent** running
inside the client's network. It polls the app over **outbound HTTPS only** (no inbound
firewall changes) and runs `New-ADUser` / group changes / `Start-ADSyncSyncCycle` locally.

## Where to install it
A **domain-joined Windows host** that has the **ActiveDirectory** PowerShell module (RSAT)
and line of sight to a DC. The DC itself works; a dedicated management/jump host is preferred.
- **Directory sync:** the `ADSync` cmdlets live on the **Azure AD Connect** server. Either run
  an agent there too, or let the one DC agent **remote into** the AAD Connect host — set the
  `directory-sync` system's `config.host` to the Connect server name; the agent remotes in
  with the `ad-dc` credential.

## Prerequisites on the host
1. **PowerShell 7** (`pwsh`) — the runner is `#Requires -Version 7.0`. Install via
   `winget install Microsoft.PowerShell` or the MSI. (The default path the supervisor expects
   is wherever `pwsh.exe` resolves; note it.)
2. **RSAT ActiveDirectory module** — present on a DC; on a member server:
   `Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools`.
   PowerShell 7 loads it through the Windows PowerShell compatibility shim automatically.
3. **Outbound HTTPS** to the app URL. No inbound ports.
4. A pure AD agent needs nothing else. (Graph/EXO modules are only needed if this same agent
   also runs `m365`/`exchange` for a hybrid client.)

## Step 1 — Enroll the agent (get an AgentId)
- **In the app:** *Agents* → **Add agent** → scope **client-network**, pick the client. It
  returns an **agent id** (and can give you a one-line install command carrying a short-lived
  enroll token).
- **Or via API:**
  ```
  curl -X POST https://<app>/api/agents -H "x-enrollment-token: $ENROLLMENT_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"CORE-CCE-DC01","scope":"client_network","clientSlug":"<client-slug>"}'
  ```
  The response `id` is your **AgentId**. (A `client_network` agent only ever sees its own
  client's jobs.)

## Step 2 — Store the `ad-dc` secret (Delinea)
The `active-directory` + `directory-sync` systems broker a secret named **`ad-dc`**:
- **Username/Password** = a delegated domain account that can create/modify/disable users in
  the target OUs (least-privilege — not a Domain Admin if avoidable).
- **Field `Server`** = the DC to target (hostname or FQDN, e.g. `CORE-CCE-DC01`). The AD module
  connects with `-Server <that>` `-Credential <ad-dc>`.
- Reference the Delinea secret id from the client profile as secret name `ad-dc`, and make sure
  the client's `active-directory` (and `directory-sync`) systems list `"ad-dc"` in their
  `secrets`. For directory-sync on a separate Connect box, set `config.host` to that server.

## Step 3 — Pull the runner bundle + first run
```
mkdir C:\iam-runner
pwsh -File C:\iam-runner\update-dc-runner.ps1 -AppUrl https://<app> -AgentId <AgentId>
```
`update-dc-runner.ps1` pulls the current bundle from `/api/runner/manifest` and launches the
runner. If the app enforces bearer auth, set `RUNNER_API_TOKEN` first
(`$env:RUNNER_API_TOKEN = "..."`). (No `update-dc-runner.ps1` on the box yet? Grab it from the
manifest first, or copy it from `runner/` in the repo.)

## Step 4 — Supervise it (survive crashes + reboots)
There's no Windows-service installer yet (the Mac uses launchd). Use a **Scheduled Task** that
runs at startup and restarts on failure:
```powershell
$pwsh = (Get-Command pwsh).Source
$args = '-NoProfile -ExecutionPolicy Bypass -File C:\iam-runner\Start-IamRunner.ps1 ' +
        '-AppUrl https://<app> -AgentId <AgentId>'   # add -ApiToken <token> if required
$action  = New-ScheduledTaskAction  -Execute $pwsh -Argument $args
$trigger = New-ScheduledTaskTrigger -AtStartup
$set     = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
             -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
# Run as the gMSA/service account that owns the ad-dc rights, whether or not anyone is logged on:
Register-ScheduledTask -TaskName "iam-runner" -Action $action -Trigger $trigger -Settings $set `
  -User "DOMAIN\svc-iam-runner" -Password '<pw>' -RunLevel Highest
Start-ScheduledTask -TaskName "iam-runner"
```
(The runner also self-restarts on a stall via its watchdog; the Scheduled Task covers reboots
and hard crashes.)

## Step 5 — Verify
- *Agents* page shows the agent **heartbeating** (`lastSeenAt`) and its **version**.
- The runner has a built-in **connectivity test** for `active-directory` (it runs
  `Get-ADDomain` and reports the domain) — use the Agents UI test, or check the log.
- Do a real check with **"▶ run this step only"** on a test onboard for an `ad-synced` client:
  the AD step should create the user (`New-ADUser`), `Confirm-CtgAD` should pass, and
  `directory-sync` should fire `Start-ADSyncSyncCycle -PolicyType Delta`.

## Updating
Re-run `update-dc-runner.ps1` to pull the latest bundle (it stops the old process, re-downloads,
relaunches). The app's **stale-code guard** won't hand jobs to a runner whose build hash differs
from the app's current bundle, so always update the agent after deploying app/runner changes.

## Gotchas
- **AD vs AAD Connect are often different servers.** The DC has the `ActiveDirectory` module;
  only the Connect server has `ADSync`. Point `directory-sync.config.host` at the Connect box.
- **`Server` field is required** on the `ad-dc` secret — without it the AD connection has no DC
  to target.
- Central runner can't help here: it deliberately skips `active-directory`/`directory-sync`, so
  if no client-network agent is online those steps sit **pending** ("no runner") on the case.
- **Browser automation** is off by default on a DC agent (the installer sets
  `IAM_RUNNER_NO_BROWSER_INSTALL=1`, and a host without Node never self-heals the sidecar). If this
  agent should take browser jobs, use **Install browser** on its row in the Agents page (runner
  1.105+): it downloads a portable Node into the runner's own folder plus Playwright + Chromium in
  the background — no RDP, nothing installed system-wide — and starts advertising `browser` when done.
