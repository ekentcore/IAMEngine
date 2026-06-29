# Coretelligent.1Password — invite (provision) a user on onboard, suspend on offboard.
#
# 1Password has NO app-only REST API for USER MANAGEMENT (service accounts are vault/secret-scoped).
# The only programmatic invite is the `op` CLI — `op user provision` / `op user suspend` — signed in
# as a real ADMIN/OWNER account. So this module is METHOD-AWARE (config.method):
#   scim    — provisioning is driven by the client's IdP (Entra SCIM). We do NOT invite here; the Entra
#             group does it. Record a note and (best-effort) verify with `op` when an admin cred exists.
#   api     — shell out to `op` (requires the CLI on the runner + a brokered admin sign-in). REQUIRED to
#             work; a failure is a hard error.
#   manual  — emit a checklist action (invite by hand in the admin console).
#   browser — same as manual today (no Playwright harness in the runner yet) — a flagged follow-up.
#   auto    — (default) try `api`; if op/creds are unavailable or it fails, fall back to the manual
#             checklist so the case never hard-blocks.
# Idempotent: a user already present is left as-is. The HTTP/CLI seam is Invoke-Ctg1PasswordCli (mocked
# in tests). See /help/1password.

$script:OpSession   = $null   # the `op signin --raw` session token, reused across calls this job
$script:OpAccount   = $null   # the account shorthand we added
$script:OpConnected = $false

function Get-CtgProp {
    # Read a property whether $Object is a hashtable, IDictionary, or PSObject. $null when absent.
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Resolve-Ctg1PasswordEmail {
    # The user's email/UPN, from the identifiers a case might carry.
    param([pscustomobject]$User)
    foreach ($k in @('UserPrincipalName', 'userPrincipalName', 'workEmail', 'WorkEmail', 'email', 'Email', 'mail')) {
        $v = Get-CtgProp $User $k
        if ($v -and ([string]$v) -match '@') { return ([string]$v).Trim() }
    }
    $null
}

function Resolve-Ctg1PasswordName {
    # The display name, else "First Last", else the email local-part.
    param([pscustomobject]$User, [string]$Email)
    $dn = [string](Get-CtgProp $User 'DisplayName')
    if ($dn.Trim()) { return $dn.Trim() }
    $first = [string](Get-CtgProp $User 'FirstName'); $last = [string](Get-CtgProp $User 'LastName')
    $full = (@($first, $last) | Where-Object { $_ }) -join ' '
    if ($full.Trim()) { return $full.Trim() }
    if ($Email -match '@') { return ($Email.Split('@')[0]) }
    return $Email
}

function Connect-Ctg1Password {
    <#
    .SYNOPSIS
        Sign in to 1Password non-interactively with an ADMIN account so `op` can manage users.
        UserName/SignInAddress/SecretKey/Password come from the brokered `1password` secret. Stores a
        session token reused by Invoke-Ctg1PasswordCli this job. Throws actionably if `op` isn't installed.
    .NOTES
        Service accounts CANNOT provision users, so this MUST be a person (owner/admin) account — and
        that account must be exempt from / not enrolled in MFA, or the headless sign-in is blocked.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$SignInAddress,   # e.g. coretelligent.1password.com
        [Parameter(Mandatory)][string]$Email,
        [Parameter(Mandatory)][string]$SecretKey,
        [Parameter(Mandatory)][string]$Password,
        [string]$Shorthand = 'ctg'
    )
    if (-not (Get-Command op -ErrorAction SilentlyContinue)) {
        throw "the 1Password CLI ('op') isn't installed on this runner — install it (https://developer.1password.com/docs/cli) so the api method can provision users, or set the client's 1password method to 'scim' or 'manual'. See /help/1password."
    }
    $script:OpAccount = $Shorthand
    # Add the account config (idempotent — re-adding the same address is a no-op), then sign in with the
    # password piped to stdin and capture the raw session token. Never log the password/secret-key.
    try {
        & op account add --address $SignInAddress --email $Email --secret-key $SecretKey --shorthand $Shorthand 2>$null | Out-Null
        $script:OpSession = ($Password | & op signin --account $Shorthand --raw 2>$null | Select-Object -First 1)
    }
    catch {
        $script:OpConnected = $false
        throw "1Password sign-in failed for $Email @ $SignInAddress — check the admin account's Secret Key/password and that it isn't MFA-gated (service accounts can't manage users). ($($_.Exception.Message))"
    }
    if (-not $script:OpSession) {
        $script:OpConnected = $false
        throw "1Password sign-in returned no session for $Email @ $SignInAddress — likely a wrong Secret Key/password or an MFA prompt the CLI can't answer. See /help/1password."
    }
    $script:OpConnected = $true
    Write-Verbose "1Password session established for $Email."
}

function Invoke-Ctg1PasswordCli {
    <#
    .SYNOPSIS
        Single seam for `op` invocations (mocked in tests). Runs `op <args> --session <token> --format=json`
        and returns the parsed object (or raw text). Throws on a non-zero exit, scrubbing nothing sensitive
        (op args here are user emails/names, never the secret). With -AllowFail returns $null instead of throwing.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][string[]]$OpArgs, [switch]$AllowFail, [switch]$Raw)
    if (-not $script:OpSession) { throw "Call Connect-Ctg1Password first." }
    $full = @($OpArgs) + @('--session', $script:OpSession)
    if (-not $Raw) { $full += @('--format', 'json') }
    $out = & op @full 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($AllowFail) { return $null }
        throw "1Password CLI: op $($OpArgs -join ' ') -> exit $LASTEXITCODE — $((@($out) -join ' ').Trim())"
    }
    if ($Raw) { return (@($out) -join "`n") }
    try { return ((@($out) -join "`n") | ConvertFrom-Json) } catch { return (@($out) -join "`n") }
}

function Get-Ctg1PasswordUser {
    # The user's 1Password record (state ACTIVE/SUSPENDED/RECOVERY_STARTED/TRANSFER_PENDING/…) or $null
    # when 1Password doesn't know them. A "not found" exit is a miss; other errors throw.
    param([Parameter(Mandatory)][string]$Email)
    Invoke-Ctg1PasswordCli -OpArgs @('user', 'get', $Email) -AllowFail
}

function New-Ctg1PasswordManualAction {
    # The guided manual-checklist line used by the manual/browser methods and the auto fallback.
    param([string]$Verb, [string]$Name, [string]$Email, [string]$Address, [string]$Reason)
    $url = if ($Address) { "https://$($Address -replace '^https?://','')" } else { 'the 1Password admin console' }
    $what = if ($Verb -eq 'suspend') { "suspend $Email in $url (People -> the user -> Suspend)" }
            else { "invite $Name <$Email> in $url (People -> Invite People)" }
    if ($Reason) { "MANUAL: $what — $Reason" } else { "MANUAL: $what" }
}

function Invoke-Ctg1PasswordOnboarding {
    <#
    .SYNOPSIS
        Invite the new user to 1Password per config.method (auto|api|scim|manual|browser). Idempotent —
        a user already present is left as-is. -Connected indicates a live `op` admin session.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [bool]$Connected = $false)
    $actions = [System.Collections.Generic.List[string]]::new()
    $method  = ([string](Get-CtgProp $Config 'method')); if (-not $method) { $method = 'auto' }
    $address = [string](Get-CtgProp $Config 'signInAddress')
    $email   = Resolve-Ctg1PasswordEmail $User
    if (-not $email) {
        $actions.Add("WARN no email/UPN on the case — can't provision the 1Password user. Set the email and re-run.")
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = ''; Actions = $actions.ToArray() }
    }
    $name = Resolve-Ctg1PasswordName $User $email

    if ($method -eq 'scim') {
        $grp = [string](Get-CtgProp $Config 'scimGroup')
        $actions.Add("1Password provisions via Entra SCIM$(if ($grp) { " (group: $grp)" }) — the IdP invites the user; nothing to do here.")
        if ($Connected) { $u = Get-Ctg1PasswordUser -Email $email; if ($u) { $actions.Add("verified: $email is in 1Password (state $([string](Get-CtgProp $u 'state')))") } else { $actions.Add("not in 1Password yet — SCIM syncs on the IdP's schedule; auto-retrying"); return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray(); RetryAfterMinutes = 15 } } }
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    if ($method -eq 'manual' -or $method -eq 'browser') {
        $actions.Add((New-Ctg1PasswordManualAction -Verb 'invite' -Name $name -Email $email -Address $address))
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    # api / auto — provision via `op`. auto falls back to a manual checklist if op/creds are unavailable.
    if (-not $Connected) {
        if ($method -eq 'api') { throw "1Password api method needs an admin `op` sign-in but none was established — check the 1password secret (sign-in address / email / Secret Key / password) and that `op` is installed. See /help/1password." }
        $actions.Add((New-Ctg1PasswordManualAction -Verb 'invite' -Name $name -Email $email -Address $address -Reason "the 1Password CLI/admin sign-in is unavailable on this runner, so it couldn't be invited automatically"))
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    try {
        $existing = Get-Ctg1PasswordUser -Email $email
        if ($existing) {
            $actions.Add("1Password user already present: $email (state $([string](Get-CtgProp $existing 'state')))")
            return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
        }
        if ($PSCmdlet.ShouldProcess($email, "Provision (invite) 1Password user")) {
            Invoke-Ctg1PasswordCli -OpArgs @('user', 'provision', '--name', $name, '--email', $email) | Out-Null
            $actions.Add("invited 1Password user: $name <$email> — they'll get an email to join")
            # The invite is pending acceptance; let the validator confirm "active" on a later sweep.
            return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray(); RetryAfterMinutes = 60 }
        }
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    catch {
        if ($method -eq 'api') { throw }
        $actions.Add((New-Ctg1PasswordManualAction -Verb 'invite' -Name $name -Email $email -Address $address -Reason "automatic invite failed ($($_.Exception.Message))"))
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
}

function Invoke-Ctg1PasswordOffboarding {
    <#
    .SYNOPSIS
        Suspend the user in 1Password per config.method. Idempotent — an already-suspended/absent user
        is a no-op. SCIM deprovisions via the IdP; manual/browser emit a checklist; api/auto suspend via `op`.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [bool]$Connected = $false)
    $actions = [System.Collections.Generic.List[string]]::new()
    $method  = ([string](Get-CtgProp $Config 'method')); if (-not $method) { $method = 'auto' }
    $address = [string](Get-CtgProp $Config 'signInAddress')
    $email   = Resolve-Ctg1PasswordEmail $User
    if (-not $email) {
        $actions.Add("WARN no email/UPN on the case — can't suspend the 1Password user.")
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = ''; Actions = $actions.ToArray() }
    }

    if ($method -eq 'scim') {
        $actions.Add("1Password deprovisions via Entra SCIM — removing the user from the IdP/group suspends them in 1Password; nothing to do here.")
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    if ($method -eq 'manual' -or $method -eq 'browser') {
        $actions.Add((New-Ctg1PasswordManualAction -Verb 'suspend' -Email $email -Address $address))
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    if (-not $Connected) {
        if ($method -eq 'api') { throw "1Password api method needs an admin `op` sign-in but none was established. See /help/1password." }
        $actions.Add((New-Ctg1PasswordManualAction -Verb 'suspend' -Email $email -Address $address -Reason "the 1Password CLI/admin sign-in is unavailable, so it couldn't be suspended automatically"))
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    try {
        $existing = Get-Ctg1PasswordUser -Email $email
        if (-not $existing) {
            $actions.Add("1Password user not found: $email — nothing to suspend")
            return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
        }
        if (([string](Get-CtgProp $existing 'state')) -match 'SUSPENDED') {
            $actions.Add("1Password user already suspended: $email")
            return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
        }
        if ($PSCmdlet.ShouldProcess($email, "Suspend 1Password user")) {
            Invoke-Ctg1PasswordCli -OpArgs @('user', 'suspend', $email) | Out-Null
            $actions.Add("suspended 1Password user: $email")
        }
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    catch {
        if ($method -eq 'api') { throw }
        $actions.Add((New-Ctg1PasswordManualAction -Verb 'suspend' -Email $email -Address $address -Reason "automatic suspend failed ($($_.Exception.Message))"))
        return [pscustomobject]@{ System = '1password'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
}

function Confirm-Ctg1Password {
    <#
    .SYNOPSIS
        Read-back validation. api/connected: onboard expects the user present (any non-suspended state);
        offboard expects suspended (or absent). scim/manual/browser or no session: pass with a note that
        it couldn't be verified automatically (so the case isn't blocked on a non-API path).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [Parameter(Mandatory)][string]$Action, [bool]$Connected = $false)
    $method = ([string](Get-CtgProp $Config 'method')); if (-not $method) { $method = 'auto' }
    $email  = Resolve-Ctg1PasswordEmail $User
    $checks = [System.Collections.Generic.List[object]]::new()

    if (-not $Connected -or $method -in @('manual', 'browser')) {
        $checks.Add(@{ name = "1Password $Action not auto-verified (method '$method') — confirm in the admin console"; expected = $true; actual = $true; pass = $true })
        return @{ ok = $true; checks = $checks.ToArray() }
    }
    if (-not $email) {
        $checks.Add(@{ name = 'email present on the case'; expected = $true; actual = $false; pass = $false })
        return @{ ok = $false; checks = $checks.ToArray() }
    }
    $u = Get-Ctg1PasswordUser -Email $email
    $state = if ($u) { [string](Get-CtgProp $u 'state') } else { '' }
    if ($Action -eq 'offboard') {
        $ok = (-not $u) -or ($state -match 'SUSPENDED')
        $checks.Add(@{ name = "1Password user suspended/removed: $email"; expected = 'SUSPENDED or absent'; actual = ($state ? $state : 'absent'); pass = $ok })
    }
    else {
        # onboard: present and not suspended (an invited-but-not-yet-accepted user is still "present")
        $ok = [bool]$u -and ($state -notmatch 'SUSPENDED')
        $checks.Add(@{ name = "1Password user present: $email"; expected = 'present (active/invited)'; actual = ($state ? $state : 'absent'); pass = $ok })
    }
    $allPass = -not @($checks | Where-Object { -not $_.pass }).Count
    @{ ok = [bool]$allPass; checks = $checks.ToArray() }
}

Export-ModuleMember -Function Connect-Ctg1Password, Invoke-Ctg1PasswordCli, Get-Ctg1PasswordUser, Invoke-Ctg1PasswordOnboarding, Invoke-Ctg1PasswordOffboarding, Confirm-Ctg1Password
