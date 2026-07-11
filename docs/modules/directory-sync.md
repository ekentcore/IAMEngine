## Directory sync (`directory-sync`)

`Module: Coretelligent.ActiveDirectory` (shared) · `Mode: api (agent)` · `Build tier: 2` · `Appears in: ~37%` · `Lanes: both`

Pushes on-prem AD changes up to Entra so 365/downstream see the user. `ad-synced` only.

### Auth
Secret: `ad-dc`. Runs on the Entra Connect / sync server (the agent host or a reachable DC).

### Onboard / Offboard lane
`always` (when backbone is ad-synced). Run `Start-ADSyncSyncCycle -PolicyType Delta`, wait,
and verify the user appears (onboard) or reflects disabled state (offboard) in Entra.

### Config keys
`host` (sync server), `command` (default `Start-ADSyncSyncCycle -PolicyType Delta`),
`waitSeconds`, `verifyTarget`.

### Functions
`Invoke-CtgDirectorySync` (run + poll until reflected, with timeout).

### Depends on
`active-directory` (runs immediately after, both lanes).

### Variants & gotchas
Must execute on the sync server, not just any DC; timing is asynchronous — poll/verify
rather than fixed sleep; only present for ad-synced clients (ad-standalone manages 365
separately, so no sync).

### Manual fallback
A privileged engineer runs the sync command manually if remoting is unavailable.

### Troubleshooting (the "Six One Commodities" class of issues)
The runner (1.31.x) auto-recovers these; manual steps are the just-in-case.

- **"Could not load type 'System.Web…'" while onboard directory-sync** — pwsh 7 (.NET Core) lacks the
  `System.Web` assembly that WinRM/Negotiate and the Desktop-only ADSync module reach for. Windows
  PowerShell 5.1 (.NET Framework) has it.
  - Runner: detects whether ADSync is local vs remote WITHOUT loading it (a speculative
    `-UseWindowsPowerShell` probe is itself a WinRM call that trips System.Web), then runs the sync in
    **Windows PowerShell 5.1** — locally when Entra Connect is on this box (imports ADSync by its full
    path, since it isn't on the default module path), or via `Invoke-Command` to the remote sync host.
  - Manual test on the sync host (pwsh 7): run the sync through 5.1 —
    ```powershell
    $winPS = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $sync = @'
    $ErrorActionPreference='Stop'
    $adm = Get-ChildItem "$env:ProgramFiles\Microsoft Azure AD*" -Recurse -Filter ADSync.psd1 -EA SilentlyContinue | Select -First 1
    Import-Module $adm.FullName
    if ((Get-ADSyncScheduler).SyncCycleInProgress) { 'in-progress' } else { Start-ADSyncSyncCycle -PolicyType Delta | Out-Null; 'started' }
    '@
    & $winPS -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $sync
    ```
    Expect `started` / `in-progress`. If ADSync.psd1 isn't found, note where Azure AD Connect is
    installed. If it fails with a **non-System.Web** error, it's an auth/trust issue reaching the sync
    host (cross-domain) — point the `ad-dc` secret at a writable, reachable server, or accept the step
    (the scheduled AAD Connect cycle syncs the user within ~30 min regardless).

- **The whole step is blocking downstream (M365)** even though the sync will happen on schedule — mark
  it **accepted** ("ignore warning — mark complete") on the case; an accepted failure no longer blocks
  its dependents.

- **directory-sync isn't strictly required** — it just triggers an *immediate* delta sync; without it
  the user still syncs on the next scheduled cycle. Safe to accept and move on if the environment can't
  run it.
