#Requires -Version 7.0

# Coretelligent.GoogleWorkspace
# Google Workspace user lifecycle via the Admin SDK Directory API. Onboard creates a user,
# places them in an OU (never Root) and adds group memberships; offboard captures evidence,
# removes groups, moves to the Inactive OU and SUSPENDS (never deletes — the `archive` module
# handles deletion later). Idempotent: checks state before changing it.
#
# Auth: domain-wide-delegated service account. Secret `google-admin` -> a bearer access token
# (Username/Password carry the OAuth client; Fields.CustomerId is the Google customer id).

Set-StrictMode -Version Latest

$script:GoogleApiUrl = 'https://admin.googleapis.com/admin/directory/v1'
$script:GoogleToken  = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# base64url (no padding) — the JWS encoding.
function ConvertTo-CtgBase64Url {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Connect-CtgGoogle {
    <#
    .SYNOPSIS
        Establish a Directory API session by minting a short-lived OAuth2 access token from a
        domain-wide-delegated SERVICE ACCOUNT key. Builds an RS256 JWT (iss = service-account
        email, sub = the admin to impersonate, scope = the Directory scopes), signs it with the
        service account's private key, and exchanges it at Google's token endpoint. Pure .NET
        crypto + REST — no external modules, cross-platform (runs on the Mac/Linux runner).
    .NOTES
        Domain-wide delegation: the service account's client ID must be authorized for these
        scopes in Admin Console → Security → API controls → Domain-wide delegation, and `sub`
        must be a real super-admin. See /help/google for the full setup.
    #>
    [CmdletBinding(DefaultParameterSetName = 'Key')]
    param(
        # The service account's client_email + private_key (PEM) from its downloaded JSON key.
        [Parameter(Mandatory, ParameterSetName = 'Key')][string]$ClientEmail,
        [Parameter(Mandatory, ParameterSetName = 'Key')][string]$PrivateKey,
        # The Workspace super-admin to act as (domain-wide delegation impersonates a real admin).
        [Parameter(Mandatory, ParameterSetName = 'Key')][string]$Impersonate,
        # Back-compat / tests: pass an already-minted access token directly.
        [Parameter(Mandatory, ParameterSetName = 'Token')][string]$AccessToken,
        [string]$CustomerId = 'my_customer',
        [string[]]$Scopes = @(
            'https://www.googleapis.com/auth/admin.directory.user',
            'https://www.googleapis.com/auth/admin.directory.group',
            'https://www.googleapis.com/auth/admin.directory.orgunit'
        )
    )
    $script:GoogleCustomer = $CustomerId
    if ($PSCmdlet.ParameterSetName -eq 'Token') {
        $script:GoogleToken = $AccessToken
        Write-Verbose "Google Workspace session established (token provided)."
        return
    }

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = @{ alg = 'RS256'; typ = 'JWT' }
    $claims = @{
        iss   = $ClientEmail
        sub   = $Impersonate                 # impersonated admin (domain-wide delegation)
        scope = ($Scopes -join ' ')
        aud   = 'https://oauth2.googleapis.com/token'
        iat   = $now
        exp   = $now + 3600
    }
    $enc = { param($o) ConvertTo-CtgBase64Url ([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress))) }
    $signingInput = "$(& $enc $header).$(& $enc $claims)"

    $rsa = [System.Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($PrivateKey)      # service-account private_key is PKCS#8 PEM
        $sigBytes = $rsa.SignData([Text.Encoding]::UTF8.GetBytes($signingInput),
            [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    }
    finally { $rsa.Dispose() }
    $jwt = "$signingInput.$(ConvertTo-CtgBase64Url $sigBytes)"

    $resp = Invoke-RestMethod -Method POST -Uri 'https://oauth2.googleapis.com/token' `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body @{ grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer'; assertion = $jwt }
    $token = Get-CtgProp $resp 'access_token'
    if (-not $token) { throw "Google token exchange returned no access_token — check the service account, domain-wide delegation scopes, and that '$Impersonate' is a super-admin." }
    $script:GoogleToken = $token
    Write-Verbose "Google Workspace session established for $Impersonate (customer $CustomerId)."
}

function Invoke-CtgGoogleApi {
    # Single HTTP seam (bearer auth). Mocked in tests. Returns $null on 404 (not found).
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:GoogleToken) { throw "Call Connect-CtgGoogle first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:GoogleApiUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:GoogleToken" }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { return Invoke-RestMethod @p }
    catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }
        throw
    }
}

function Get-CtgGoogleUser {
    param([Parameter(Mandatory)][string]$Email)
    Invoke-CtgGoogleApi -Method GET -Path "/users/$Email"
}

function Get-CtgGoogleUserGroups {
    # Group emails the user currently belongs to (empty array if none).
    param([Parameter(Mandatory)][string]$Email)
    $resp = Invoke-CtgGoogleApi -Method GET -Path "/groups?userKey=$Email"
    $groups = Get-CtgProp $resp 'groups'
    if (-not $groups) { return @() }
    @($groups | ForEach-Object { Get-CtgProp $_ 'email' })
}

function Invoke-CtgGoogleOnboarding {
    <#
    .SYNOPSIS
        Idempotently provision a Google user. Before creating: check if the username exists, confirm
        it's the SAME person (name match), and if not fall back to an alternate username (or pause for
        a decision); if it is, adopt it. Then reconcile the rest — place in the target OU (never Root)
        and add any missing group memberships. Config: ou, groups[], usernameCollisionPolicy,
        password{mode,sharedSecret}. User: UserPrincipalName (+ optional UserPrincipalNameFallbacks).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        # Generated by the runner (New-CtgCompliantPassword lives in Coretelligent.M365) and passed
        # in, mirroring Invoke-CtgM365Onboarding — the module never reaches into another module.
        [Parameter(Mandatory)][securestring]$InitialPassword
    )

    $actions = [System.Collections.Generic.List[string]]::new()
    $ou = (Get-CtgProp $Config 'ou') ?? '/Active Users'
    if ($ou -eq '/' -or $ou -eq '') { throw "refusing to place a user in the Root OU" }

    # Decide WHICH account to use before creating one: check existence, confirm it's the same person,
    # else fall back to an alternate username (or pause for an operator decision). Mirrors
    # Invoke-CtgM365Onboarding. Google's email is derived deterministically from the name, so the email
    # itself encodes identity; the only real ambiguity is two people whose names yield the same address.
    $primary = $User.UserPrincipalName
    $candidates = @(@($primary) + @(Get-CtgProp $User 'UserPrincipalNameFallbacks') | Where-Object { $_ })
    # drop malformed locals (e.g. a "{first}.{mi}" pattern with no middle initial -> "felix.@")
    $candidates = @($candidates | Where-Object { $lp = ($_ -split '@')[0]; $lp -and ($lp -notmatch '(^[._-]|[._-]$|[._-]{2,})') })
    $wantFirst = ([string]$User.FirstName).Trim()
    $wantLast  = ([string]$User.LastName).Trim()
    # 'adopt' = it's ours, 'new' = different person (use a fallback), unset/'ask' = pause and let an operator decide.
    $collisionPolicy = [string](Get-CtgProp $Config 'usernameCollisionPolicy')

    $email = $null; $existing = $null
    foreach ($cand in $candidates) {
        $found = Get-CtgGoogleUser -Email $cand
        if (-not $found) { $email = $cand; Write-Verbose "username available: $cand"; break }
        $gName  = Get-CtgProp $found 'name'
        $fGiven = ([string](Get-CtgProp $gName 'givenName')).Trim()
        $fFamily = ([string](Get-CtgProp $gName 'familyName')).Trim()
        $haveName = [bool]($fGiven -or $fFamily)
        if ($haveName -and $wantFirst -and $wantLast -and $fGiven -ieq $wantFirst -and $fFamily -ieq $wantLast) {
            # Same person — a re-run. Adopt and reconcile the rest below.
            $email = $cand; $existing = $found
            $actions.Add("Google user exists ($cand) and matches '$fGiven $fFamily' — same person (re-run), skipped create"); break
        }
        if (-not $haveName) {
            # Existing account has no readable name to compare — the email is deterministic from this
            # person's name, so treat it as ours (adopt) but say we couldn't verify by name.
            $email = $cand; $existing = $found
            $actions.Add("Google user exists ($cand) — adopted by email (no name on the account to confirm), skipped create"); break
        }
        # Name present but DIFFERENT = a different person on this username. Operator can force adoption;
        # otherwise it's NOT the same person — fall back to the next candidate username automatically.
        if ($collisionPolicy -ieq 'adopt') {
            $email = $cand; $existing = $found
            $actions.Add("Google user exists ($cand) as '$fGiven $fFamily' — operator chose ADOPT, skipped create"); break
        }
        $actions.Add("username '$cand' is taken by a different user ($fGiven $fFamily) — trying the next pattern")
        Write-Verbose "↪ $cand taken by $fGiven $fFamily — trying fallback"
    }
    if (-not $email) {
        # Every candidate is taken by someone else and no fallback is free — surface it as a decision
        # the operator can resolve on the case (add a fallback pattern, or Adopt one of the existing accounts).
        throw "DECISION_NEEDED:username_collision | Every candidate Google username is taken by a different person: $($candidates -join ', '). Add another username fallback pattern (e.g. {firstinitial}{last}), or set usernameCollisionPolicy=adopt to reuse the existing account. | upn=$primary | name=$wantFirst $wantLast"
    }
    if ($email -ne $primary) { $actions.Add("using fallback username: $email (primary $primary taken)") }

    if (-not $existing -and $PSCmdlet.ShouldProcess($email, "Create Google user in $ou")) {
        $body = @{
            primaryEmail = $email
            name         = @{ givenName = $User.FirstName; familyName = $User.LastName }
            password     = (ConvertFrom-SecureString $InitialPassword -AsPlainText)
            orgUnitPath  = $ou
            changePasswordAtNextLogin = $true
        }
        Invoke-CtgGoogleApi -Method POST -Path '/users' -Body $body | Out-Null
        $actions.Add("created Google user: $email in $ou")
    }

    # Ensure OU (a pre-existing user may sit elsewhere) — idempotent.
    if ($PSCmdlet.ShouldProcess($email, "Ensure OU $ou")) {
        Invoke-CtgGoogleApi -Method PUT -Path "/users/$email" -Body @{ orgUnitPath = $ou } | Out-Null
    }

    # Add to groups (skip groups the user is already in).
    $current = Get-CtgGoogleUserGroups -Email $email
    foreach ($g in @((Get-CtgProp $Config 'groups'))) {
        if (-not $g) { continue }
        if ($current -contains $g) { $actions.Add("already in group: $g"); continue }
        if ($PSCmdlet.ShouldProcess($email, "Add to group $g")) {
            Invoke-CtgGoogleApi -Method POST -Path "/groups/$g/members" -Body @{ email = $email; role = 'MEMBER' } | Out-Null
            $actions.Add("added to group: $g")
        }
    }

    [pscustomobject]@{ System = 'google-workspace'; Status = 'ok'; Email = $email; Ou = $ou; Actions = $actions.ToArray() }
}

function Invoke-CtgGoogleOffboarding {
    <#
    .SYNOPSIS
        Capture evidence, remove groups, move to the Inactive OU and SUSPEND the user. NEVER
        deletes (guardrail do-not-delete). Config: inactiveOu, transferTarget, guardrails[].
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    if (-not (Get-CtgGoogleUser -Email $email)) {
        return [pscustomobject]@{ System = 'google-workspace'; Status = 'ok'; Email = $email; Actions = @("Google user not found ($email)"); Evidence = @{ Groups = @() } }
    }

    # 1. Evidence FIRST — snapshot group memberships before we remove anything. @() keeps it an
    # array even for a single group (PowerShell unrolls one-element returns), so .Count is safe.
    $groupEvidence = @(Get-CtgGoogleUserGroups -Email $email)
    $actions.Add("captured $($groupEvidence.Count) group membership(s) as evidence")

    # 2. Remove group memberships.
    foreach ($g in $groupEvidence) {
        if ($PSCmdlet.ShouldProcess($email, "Remove from group $g")) {
            Invoke-CtgGoogleApi -Method DELETE -Path "/groups/$g/members/$email" | Out-Null
            $actions.Add("removed from group: $g")
        }
    }

    # 3. Move to the Inactive OU (must precede any Drive transfer).
    $inactiveOu = (Get-CtgProp $Config 'inactiveOu') ?? '/Email & Calendar/Inactive'
    if ($PSCmdlet.ShouldProcess($email, "Move to $inactiveOu")) {
        Invoke-CtgGoogleApi -Method PUT -Path "/users/$email" -Body @{ orgUnitPath = $inactiveOu } | Out-Null
        $actions.Add("moved to OU: $inactiveOu")
    }

    # 4. On request: transfer Drive ownership to the delegate (only valid once moved out of Active Users).
    $transfer = Get-CtgProp $Config 'transferTarget'
    if ($transfer -and $PSCmdlet.ShouldProcess($email, "Transfer Drive to $transfer")) {
        Invoke-CtgGoogleApi -Method POST -Path '/dataTransfer' -Body @{ oldOwnerUserId = $email; newOwnerUserId = $transfer } | Out-Null
        $actions.Add("transferred Drive ownership to: $transfer")
    }

    # 5. Suspend (deactivate) — NEVER delete.
    if ($PSCmdlet.ShouldProcess($email, "Suspend Google user")) {
        Invoke-CtgGoogleApi -Method PUT -Path "/users/$email" -Body @{ suspended = $true } | Out-Null
        $actions.Add("suspended Google user: $email")
    }

    [pscustomobject]@{
        System   = 'google-workspace'
        Status   = 'ok'
        Email    = $email
        Evidence = @{ Groups = @($groupEvidence) }
        Actions  = $actions.ToArray()
    }
}

function Confirm-CtgGoogle {
    <#
    .SYNOPSIS
        Post-action read-back. No mutations; returns { ok; checks[] }.
        onboard -> user present, not suspended, in a non-Root OU.
        offboard -> user suspended and moved out of the Active Users OU.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    $email = $User.UserPrincipalName
    $u = Get-CtgGoogleUser -Email $email
    $ou = if ($u) { Get-CtgProp $u 'orgUnitPath' } else { $null }
    $suspended = [bool](Get-CtgProp $u 'suspended')
    $checks = [System.Collections.Generic.List[hashtable]]::new()

    if ($Action -eq 'onboard') {
        $checks.Add(@{ name = 'Google user present'; expected = $true; actual = [bool]$u; pass = [bool]$u })
        $checks.Add(@{ name = 'not in Root OU'; expected = $true; actual = ($ou -and $ou -ne '/'); pass = [bool]($ou -and $ou -ne '/') })
    }
    else {
        $checks.Add(@{ name = 'Google user suspended (not deleted)'; expected = $true; actual = $suspended; pass = $suspended })
        $inactiveOu = (Get-CtgProp $Config 'inactiveOu') ?? '/Email & Calendar/Inactive'
        $moved = ($ou -eq $inactiveOu)
        $checks.Add(@{ name = "moved to $inactiveOu"; expected = $true; actual = $moved; pass = $moved })
    }
    $ok = -not ($checks | Where-Object { -not $_.pass })
    [pscustomobject]@{ ok = [bool]$ok; checks = @($checks) }
}

# ── Ad-hoc password reset (INC0855142) ───────────────────────────────────────────────────────────
# Operator-dispatched "Generate random password" from a case's Google Workspace line. The APP
# generates the value (revealed once to the operator, then wiped) and injects it as
# config.newPassword at claim; this executor only sets it — the plaintext must NEVER appear in the
# result, actions, or an error.
function Invoke-CtgGooglePasswordReset {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $newPassword = [string](Get-CtgProp $Config 'newPassword')
    if ([string]::IsNullOrWhiteSpace($newPassword)) {
        throw "no newPassword in the job config — the app injects it at claim and wipes it after its one-time reveal; dispatch a fresh reset from the account line instead of re-running this job"
    }
    $email = [string](Get-CtgProp $User 'UserPrincipalName')
    if ([string]::IsNullOrWhiteSpace($email)) { throw "no resolvable user (no UserPrincipalName on the case) — password not reset" }
    $u = Get-CtgGoogleUser -Email $email
    if (-not $u) { throw "Google user '$email' not found — password not reset" }
    $actions = [System.Collections.Generic.List[string]]::new()
    if ($PSCmdlet.ShouldProcess($email, "Reset password")) {
        try {
            $null = Invoke-CtgGoogleApi -Method PUT -Path "/users/$email" -Body @{ password = $newPassword; changePasswordAtNextLogin = $true }
        } catch { throw "resetting the password for '$email': $($_.Exception.Message)" }
        $actions.Add("reset password for $email (must change at next login; shown once to the operator, never stored)")
    }
    [pscustomobject]@{ System = 'google-password-reset'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

Export-ModuleMember -Function Connect-CtgGoogle, Invoke-CtgGoogleApi, Get-CtgGoogleUser, Get-CtgGoogleUserGroups, Invoke-CtgGoogleOnboarding, Invoke-CtgGoogleOffboarding, Confirm-CtgGoogle, Invoke-CtgGooglePasswordReset
