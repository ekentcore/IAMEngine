#Requires -Version 7.0

# Coretelligent.KnowBe4
# KnowBe4 Security Awareness Training user lifecycle via SCIM 2.0 — KnowBe4 has NO create-user REST
# API (its public v1 API is read-only reporting); all writes go through the SCIM endpoint, which we
# call directly with a SCIM bearer token (acting as the provisioning client). Onboard creates/adopts
# a user; offboard deactivates (active=$false). Idempotent.
#
# Auth: SCIM bearer token (Account Settings > User Management > SCIM). Default base
# https://training.knowbe4.com/scim/v2 (US); override for EU/other regions via the secret.
# NOTE: if the client already provisions KnowBe4 from Entra/Okta SCIM sync, that handles creation
# automatically and this module is redundant — wire it only where there is no IdP sync.

Set-StrictMode -Version Latest

$script:Kb4Token = $null
$script:Kb4Base  = 'https://training.knowbe4.com/scim/v2'

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgKnowBe4 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Token, [string]$BaseUrl)
    $script:Kb4Token = $Token
    if ($BaseUrl) { $script:Kb4Base = $BaseUrl.TrimEnd('/') }
}

function Invoke-CtgKnowBe4Scim {
    # SCIM seam (bearer). Mocked in tests. Returns $null on 404.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:Kb4Token) { throw "Call Connect-CtgKnowBe4 first." }
    $p = @{ Method = $Method; Uri = "$script:Kb4Base$Path"; Headers = @{ Authorization = "Bearer $script:Kb4Token" }; ContentType = 'application/scim+json' }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { return Invoke-RestMethod @p }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }; throw }
}

function Get-CtgKnowBe4User {
    # The SCIM user whose userName matches the email, or $null.
    param([Parameter(Mandatory)][string]$UserName)
    $esc = $UserName.Replace('"', '')
    $filter = 'userName eq "' + $esc + '"'
    $resp = Invoke-CtgKnowBe4Scim -Method GET -Path "/Users?filter=$([uri]::EscapeDataString($filter))"
    $res = @(Get-CtgProp $resp 'Resources')
    if ($res.Count) { return $res[0] }
    return $null
}

function Invoke-CtgKnowBe4Onboarding {
    <#
    .SYNOPSIS
        Idempotently create (or adopt) a KnowBe4 user via SCIM. Before create: check existence,
        confirm the same person by name, else fall back to an alternate username (or pause for a
        decision). Config: usernameCollisionPolicy (licensing/group assignment is managed in KnowBe4).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $primary = [string]$User.UserPrincipalName
    $email   = [string]((Get-CtgProp $User 'WorkEmail') ?? $User.UserPrincipalName)
    $wantFirst = ([string]$User.FirstName).Trim(); $wantLast = ([string]$User.LastName).Trim()
    $candidates = @(@($primary) + @(Get-CtgProp $User 'UserPrincipalNameFallbacks') | Where-Object { $_ })
    $collisionPolicy = [string](Get-CtgProp $Config 'usernameCollisionPolicy')

    $userName = $null; $existing = $null
    foreach ($cand in $candidates) {
        $found = Get-CtgKnowBe4User -UserName $cand
        if (-not $found) { $userName = $cand; break }
        $nm = Get-CtgProp $found 'name'
        $fGiven = ([string](Get-CtgProp $nm 'givenName')).Trim(); $fFamily = ([string](Get-CtgProp $nm 'familyName')).Trim()
        if ($wantFirst -and $wantLast -and $fGiven -ieq $wantFirst -and $fFamily -ieq $wantLast) {
            $userName = $cand; $existing = $found; $actions.Add("KnowBe4 user exists ($cand) and matches '$fGiven $fFamily' — same person (re-run), skipped create"); break
        }
        if (-not ($fGiven -or $fFamily)) { $userName = $cand; $existing = $found; $actions.Add("KnowBe4 user exists ($cand) — adopted (no name to confirm), skipped create"); break }
        if ($collisionPolicy -ieq 'adopt') { $userName = $cand; $existing = $found; $actions.Add("KnowBe4 user exists ($cand) as '$fGiven $fFamily' — operator chose ADOPT, skipped create"); break }
        $actions.Add("username '$cand' is taken by a different user ($fGiven $fFamily) — trying the next pattern")
    }
    if (-not $userName) {
        throw "DECISION_NEEDED:username_collision | Every candidate KnowBe4 username is taken by a different person: $($candidates -join ', '). Add a username fallback pattern, or set usernameCollisionPolicy=adopt. | upn=$primary | name=$wantFirst $wantLast"
    }
    if ($userName -ne $primary) { $actions.Add("using fallback username: $userName (primary $primary taken)") }

    if (-not $existing -and $PSCmdlet.ShouldProcess($userName, "Create KnowBe4 user (SCIM)")) {
        $body = @{
            schemas  = @('urn:ietf:params:scim:schemas:core:2.0:User')
            userName = $userName
            name     = @{ givenName = $User.FirstName; familyName = $User.LastName }
            emails   = @(@{ primary = $true; value = $email; type = 'work' })
            active   = $true
        }
        Invoke-CtgKnowBe4Scim -Method POST -Path '/Users' -Body $body | Out-Null
        $actions.Add("created KnowBe4 user: $userName")
    }

    [pscustomobject]@{ System = 'knowbe4'; Status = 'ok'; UserName = $userName; Actions = $actions.ToArray() }
}

function Invoke-CtgKnowBe4Offboarding {
    <#  .SYNOPSIS  Deactivate the KnowBe4 user via SCIM (active=$false). Archival/removal stays in KnowBe4.  #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    # StrictMode-safe identity read: an offboard payload may carry no UserPrincipalName property at all
    # (a ServiceNow UM intake carries `userToOffboard`), and a dot-read of an absent property throws.
    # Only an email-shaped identifier can find the user here — a bare display name would report a false
    # "not found" success on an offboard, so no email is an error, not a silent no-op.
    $userName = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $userName) { throw "knowbe4: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }
    $found = Get-CtgKnowBe4User -UserName $userName
    if (-not $found) { return [pscustomobject]@{ System = 'knowbe4'; Status = 'ok'; Actions = @("KnowBe4 user not found ($userName)") } }
    if ((Get-CtgProp $found 'active') -eq $false) { $actions.Add("already deactivated: $userName") }
    elseif ($PSCmdlet.ShouldProcess($userName, "Deactivate KnowBe4 user")) {
        $patch = @{ schemas = @('urn:ietf:params:scim:api:messages:2.0:PatchOp'); Operations = @(@{ op = 'replace'; path = 'active'; value = $false }) }
        Invoke-CtgKnowBe4Scim -Method PATCH -Path "/Users/$($found.id)" -Body $patch | Out-Null
        $actions.Add("deactivated KnowBe4 user: $userName")
    }
    [pscustomobject]@{ System = 'knowbe4'; Status = 'ok'; UserName = $userName; Actions = $actions.ToArray() }
}

function Confirm-CtgKnowBe4 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action)
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookup below finds nobody, which reads as "already gone" and would rubber-stamp an
    # offboard that nobody performed.
    $userName = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $userName) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
    $u = Get-CtgKnowBe4User -UserName $userName
    $active = [bool]($u -and (Get-CtgProp $u 'active'))
    $checks = [System.Collections.Generic.List[hashtable]]::new()
    if ($Action -eq 'onboard') {
        $checks.Add(@{ name = 'KnowBe4 user present'; expected = $true; actual = [bool]$u; pass = [bool]$u })
        $checks.Add(@{ name = 'KnowBe4 user active'; expected = $true; actual = $active; pass = $active })
    }
    else {
        $checks.Add(@{ name = 'KnowBe4 user deactivated'; expected = $true; actual = (-not $active); pass = (-not $active) })
    }
    $ok = -not ($checks | Where-Object { -not $_.pass })
    [pscustomobject]@{ ok = [bool]$ok; checks = @($checks) }
}

# ---------------------------------------------------------------------------------------------------
# Browser console setup (ad-hoc): sign into the KnowBe4 console and enable/harvest the SCIM token — the
# 'knowbe4' API credential. DISTINCT from the SCIM token itself: this rides a 'knowbe4-console' admin
# login (email + password + optional TOTP). Drives the browser sidecar (LIVE-VALIDATION PENDING).
# ---------------------------------------------------------------------------------------------------
function Get-CtgKnowBe4ConsoleField {
    param($Secret, [string[]]$Names)
    $bag = if ($Secret -and (Get-CtgProp $Secret 'Fields')) { Get-CtgProp $Secret 'Fields' } else { $Secret }
    foreach ($n in $Names) {
        $v = Get-CtgProp $bag $n
        if ($null -ne $v -and "$v".Trim() -ne '') { return [string]$v }
    }
    return $null
}

function Resolve-CtgKnowBe4ConsoleLogin {
    param($Secret)
    $email = Get-CtgKnowBe4ConsoleField $Secret @('Username', 'Email', 'User', 'Login', 'AdminEmail', 'Admin Email')
    $password = Get-CtgKnowBe4ConsoleField $Secret @('Password', 'Pass', 'Secret')
    if ([string]::IsNullOrWhiteSpace($email) -or $email -notmatch '@') {
        return [pscustomobject]@{ Ok = $false; Reason = "no 'knowbe4-console' admin login wired (an email + password) — the Username must be an admin email, not a SCIM token." }
    }
    if ([string]::IsNullOrWhiteSpace($password)) {
        return [pscustomobject]@{ Ok = $false; Reason = "the 'knowbe4-console' secret has no Password." }
    }
    [pscustomobject]@{ Ok = $true; Username = $email; Password = $password }
}

function Invoke-CtgKnowBe4ConsoleSetup {
    <#
    .SYNOPSIS
        Drive KnowBe4 via the browser sidecar. Config.signInOnly=$true: SIGN-IN TEST (prove the console
        login works; change nothing). signInOnly=$false: additionally enable + harvest the SCIM
        provisioning token, and return it as a `Credentials` note-property (never logged) so the APP
        vaults it to Delinea. Selectors are LIVE-VALIDATION PENDING. THROWS on a non-ok flow result.
    #>
    [CmdletBinding()]
    param([AllowNull()][pscustomobject]$Config, $Secret, [string]$SecretName = 'knowbe4-console')
    $actions = [System.Collections.Generic.List[string]]::new()
    $login = Resolve-CtgKnowBe4ConsoleLogin -Secret $Secret
    if (-not $login.Ok) { throw "KnowBe4 console sign-in could not start — $($login.Reason)" }

    $signInOnlyProp = Get-CtgProp $Config 'signInOnly'
    $signInOnly = ($null -eq $signInOnlyProp) -or [bool]$signInOnlyProp
    $params = @{ signInOnly = $signInOnly }
    $consoleUrl = [string](Get-CtgProp $Config 'consoleUrl'); if (-not [string]::IsNullOrWhiteSpace($consoleUrl)) { $params['consoleUrl'] = $consoleUrl }
    $totpSeed = Get-CtgKnowBe4ConsoleField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'MFASeed', 'AuthenticatorSeed', 'otpauth')
    if ($totpSeed) { $params['otp'] = @{ totpSeed = $totpSeed }; $actions.Add("WARN using a stored TOTP seed — prefer enabling One-Time Password on the Delinea secret") }

    $flowInput = @{ username = $login.Username; password = $login.Password; params = $params }
    $res = Invoke-CtgBrowserFlow -Flow 'knowbe4-console-setup' -InputObject $flowInput -TimeoutSeconds 300
    if ($res.ok) {
        $actions.Add($(if ($res.message) { $res.message } else { 'signed in to KnowBe4' }))
        $out = [pscustomobject]@{ System = 'knowbe4-console-setup'; Status = 'ok'; Actions = $actions.ToArray() }
        if ($res.harvested -and $res.harvested.scimToken) {
            Add-Member -InputObject $out -NotePropertyName Credentials -NotePropertyValue ([pscustomobject]@{
                scimToken = [string]$res.harvested.scimToken
                baseUrl   = [string]$res.harvested.baseUrl
            })
        }
        return $out
    }
    $err = if ($res.error) { $res.error } else { 'unknown error' }
    $ex = [System.Exception]::new("KnowBe4 console setup failed: $err")
    if ($res.evidence) { $ex.Data['Evidence'] = [string]$res.evidence }
    throw $ex
}

Export-ModuleMember -Function Connect-CtgKnowBe4, Invoke-CtgKnowBe4Scim, Get-CtgKnowBe4User, Invoke-CtgKnowBe4Onboarding, Invoke-CtgKnowBe4Offboarding, Confirm-CtgKnowBe4, Resolve-CtgKnowBe4ConsoleLogin, Invoke-CtgKnowBe4ConsoleSetup
