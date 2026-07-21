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
# Needed ONLY to sign a user out everywhere (revoke sessions + refresh tokens) on offboard. Kept
# separate from the base scopes because domain-wide delegation is all-or-nothing — see Connect-CtgGoogle.
$script:GoogleSecurityScope = 'https://www.googleapis.com/auth/admin.directory.user.security'
$script:GoogleToken  = $null
$script:GoogleScopes = @()

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
        $script:GoogleScopes = @()   # unknown — the caller minted the token
        Write-Verbose "Google Workspace session established (token provided)."
        return
    }

    # Mint an access token for exactly $scopeList (signed JWT -> OAuth exchange).
    $mint = {
        param([string[]]$scopeList)
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $header = @{ alg = 'RS256'; typ = 'JWT' }
        $claims = @{
            iss   = $ClientEmail
            sub   = $Impersonate                 # impersonated admin (domain-wide delegation)
            scope = ($scopeList -join ' ')
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
        $t = Get-CtgProp $resp 'access_token'
        if (-not $t) { throw "Google token exchange returned no access_token — check the service account, domain-wide delegation scopes, and that '$Impersonate' is a super-admin." }
        $t
    }

    # Domain-wide delegation is all-or-nothing per request: the exchange FAILS OUTRIGHT if any single
    # requested scope isn't authorized for the service account's client ID. The offboard's "sign out
    # everywhere" needs admin.directory.user.security, which existing domains have NOT authorized —
    # so asking for it unconditionally would break every Google client until each one updated its
    # delegation. Instead: ASK for it, and if the exchange is rejected, fall back to the scope set
    # we've always used. A domain that adds the scope gets session revocation automatically; one that
    # hasn't keeps working exactly as before (the offboard then warns that tokens stay live).
    $withSecurity = @($Scopes)
    if ($withSecurity -notcontains $script:GoogleSecurityScope) { $withSecurity += $script:GoogleSecurityScope }
    try {
        $token = & $mint $withSecurity
        $granted = $withSecurity
    }
    catch {
        # Fall back ONLY on an authorization refusal — i.e. Google telling us this service account
        # isn't delegated that scope. A transient failure (503, DNS, TLS, socket) must NOT silently
        # downgrade the session: a domain that HAS authorized the scope would then skip the offboard's
        # signOut and be told to go add a scope it already has, while the leaver's tokens stay live.
        $err = $_
        $reason = [string]$err.Exception.Message
        $status = $null
        try { $status = [int]$err.Exception.Response.StatusCode.value__ } catch { }
        $isScopeRefusal = ($reason -match 'unauthorized_client|invalid_scope|access_denied') -or ($status -in 400, 401, 403)
        if (-not $isScopeRefusal) { throw }   # transient/real fault — surface it, don't paper over it
        Write-Verbose "Google refused the $($script:GoogleSecurityScope) scope ($reason); retrying with the legacy scopes."
        try {
            $token = & $mint $Scopes
            $granted = $Scopes
        }
        catch {
            # The legacy scopes failed too — that's a genuinely broken service account/delegation.
            # Surface BOTH: the second error alone would hide that we first tried the security scope.
            throw "Google token exchange failed for both scope sets. With $($script:GoogleSecurityScope): $reason. Without it: $($_.Exception.Message)"
        }
    }
    $script:GoogleToken = $token
    # A minted token proves every scope it was minted with — record them so the connection test can
    # report them as verified, and so the offboard knows whether signOut is available at all.
    $script:GoogleScopes = @($granted)
    Write-Verbose "Google Workspace session established for $Impersonate (customer $CustomerId)."
}

function Get-CtgGoogleSessionScopes {
    # The scopes the current session's token was minted with (empty when a raw token was passed —
    # then the delegation proof doesn't apply).
    [CmdletBinding()]
    param()
    if ($script:GoogleScopes) { @($script:GoogleScopes) } else { @() }
}

function Invoke-CtgGoogleApi {
    # Single HTTP seam (bearer auth). Mocked in tests. Returns $null on 404 (not found) — which is the
    # right answer for a GET ("no such user"), but WRONG for an action POST: a 404 there would be
    # indistinguishable from a successful empty 204 and would read as "it worked". -ThrowOn404 opts
    # such calls out of the swallow.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body, [switch]$ThrowOn404)
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
        if (-not $ThrowOn404 -and $_.Exception.Response.StatusCode.value__ -eq 404) { return $null }
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
    # Nicknamed hire: FirstName carries the nickname, LegalFirstName the intake first name. A
    # rehire's existing account has the LEGAL given name — accept either as the same person.
    $wantLegalFirst = ([string](Get-CtgProp $User 'LegalFirstName')).Trim()
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
        if ($haveName -and $wantLast -and $fFamily -ieq $wantLast -and (($wantFirst -and $fGiven -ieq $wantFirst) -or ($wantLegalFirst -and $fGiven -ieq $wantLegalFirst))) {
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
            # Per-client password policy (profile password.requireChangeAtSignIn, default true).
            changePasswordAtNextLogin = ((Get-CtgProp $Config 'requireChangeAtSignIn') -ne $false)
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
    # StrictMode-safe identity read: an offboard payload may carry no UserPrincipalName property at all
    # (a ServiceNow UM intake carries `userToOffboard`), and a dot-read of an absent property throws.
    # Only an email-shaped identifier can find the user here — a bare display name would report a false
    # "not found" success on an offboard, so no email is an error, not a silent no-op.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "google: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }

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

    # 6. Sign the user out everywhere — revokes their SESSIONS and OAuth refresh tokens.
    # Suspending blocks NEW sign-ins, but it does NOT invalidate tokens already issued: a phone with
    # a live Gmail/Drive token can keep syncing after the suspend. signOut is the Google counterpart
    # of Graph's revokeSignInSessions, so it runs AFTER the suspend (nothing can re-authenticate
    # behind it). Needs the admin.directory.user.security scope in domain-wide delegation — one more
    # scope than we used to ask for, so a domain that hasn't added it gets a 403. FAIL-SOFT: warn
    # with the exact scope and say plainly that tokens are still live; never fail the offboard.
    $missingScopeWarning = "WARN sessions NOT revoked — domain-wide delegation is missing the $($script:GoogleSecurityScope) scope (Admin Console -> Security -> API controls -> Domain-wide delegation). The user's existing sessions and refresh tokens are STILL VALID."
    if ((Get-CtgProp $Config 'signOut') -ne $false) {
        $sessionScopes = @(Get-CtgGoogleSessionScopes)
        # Connect-CtgGoogle falls back to the legacy scope set when the domain hasn't authorized the
        # security scope. Detect that here rather than firing a call we know Google will reject —
        # ($sessionScopes is empty only when a raw token was passed in, so we can't tell: just try.)
        if ($sessionScopes.Count -and ($sessionScopes -notcontains $script:GoogleSecurityScope)) {
            $actions.Add($missingScopeWarning)
        }
        elseif ($PSCmdlet.ShouldProcess($email, "Sign out everywhere (revoke sessions + tokens)")) {
            try {
                # -ThrowOn404: Invoke-CtgGoogleApi's default contract turns a 404 into $null, which for a
                # POST we'd have no way to tell from a successful 204 — and we'd then claim the sessions
                # were revoked when the endpoint was never hit. A signOut 404 is a real failure.
                Invoke-CtgGoogleApi -Method POST -Path "/users/$email/signOut" -ThrowOn404 | Out-Null
                $actions.Add("signed out everywhere (sessions + refresh tokens revoked)")
            }
            catch {
                $msg = $_.Exception.Message
                $status = $null
                try { $status = [int]$_.Exception.Response.StatusCode.value__ } catch { }
                # 403 = the token is fine but lacks the scope (the delegation gap). 401 = the token
                # itself was rejected — a different fault entirely; telling the admin to add a scope
                # would send them down the wrong path.
                if ($status -eq 403 -or $msg -match 'Forbidden|insufficient') { $actions.Add($missingScopeWarning) }
                elseif ($status -eq 401 -or $msg -match 'Unauthorized|invalid_token') {
                    $actions.Add("WARN sessions NOT revoked — Google rejected the access token (401). The user's sessions and refresh tokens are STILL VALID. Check the service account key and the impersonated super-admin.")
                }
                else { $actions.Add("WARN sessions NOT revoked (STILL VALID): $msg") }
            }
        }
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
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookup below finds nobody, which reads as "already gone" and would rubber-stamp an
    # offboard that nobody performed.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
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
    # Default ON; the operator can untick "require change at next sign-in" when they still have to
    # log in AS the user (equipment setup) before handing the account over (FR #14).
    $requireChange = (Get-CtgProp $Config 'requireChangeAtSignIn') -ne $false
    if ($PSCmdlet.ShouldProcess($email, "Reset password")) {
        try {
            $null = Invoke-CtgGoogleApi -Method PUT -Path "/users/$email" -Body @{ password = $newPassword; changePasswordAtNextLogin = $requireChange }
        } catch { throw "resetting the password for '$email': $($_.Exception.Message)" }
        $suffix = if ($requireChange) { 'must change at next login' } else { 'change at next login NOT required — operator choice' }
        $actions.Add("reset password for $email ($suffix; shown once to the operator, never stored)")
    }
    [pscustomobject]@{ System = 'google-password-reset'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgGoogleChange {
    <#
    .SYNOPSIS
        Change/mover lane for Google Workspace: add/remove group membership by name, with an optional
        full reconcile — the Google-side moves a role/department change can require without a full
        onboard/offboard.
    .NOTES
        groups (add) skips a membership the user already has (idempotent, checked against
        Get-CtgGoogleUserGroups) — a benign "already in group" skip, not a WARN. removeGroups removes
        only names the user is actually in; a name they're not in is also a benign skip (not a member
        either way). reconcileGroups+desiredGroups: remove every CURRENT group not in desiredGroups
        (case-insensitive), instead of the named removeGroups list. Every add/remove call is
        try/catch'd: a REAL failure produces a WARN action, never an unconditional success line.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = [string]((Get-CtgProp $User 'email') ?? (Get-CtgProp $User 'PrimaryEmail') ?? (Get-CtgProp $User 'UserPrincipalName'))
    if (-not $email) { throw "Invoke-CtgGoogleChange: no email on the target user" }
    $current = @(Get-CtgGoogleUserGroups -Email $email)

    # ADD by name — skip a membership the user already has (idempotent).
    foreach ($g in @(Get-CtgProp $Config 'groups' | Where-Object { $_ })) {
        if ($current -contains $g) { $actions.Add("already in group: $g"); continue }
        if (-not $PSCmdlet.ShouldProcess($g, "Add $email to group")) { continue }
        try {
            Invoke-CtgGoogleApi -Method POST -Path "/groups/$g/members" -Body @{ email = $email; role = 'MEMBER' } | Out-Null
            $actions.Add("added to group: $g")
        }
        catch { $actions.Add("WARN could not add to group $g`: $($_.Exception.Message)") }
    }

    # REMOVE — either a named list (only groups the user is actually in) or, when reconcileGroups is
    # set, every CURRENT group not in desiredGroups (case-insensitive full reconcile).
    $reconcile = (Get-CtgProp $Config 'reconcileGroups') -eq $true
    $toRemove = if ($reconcile) {
        $desired = @(Get-CtgProp $Config 'desiredGroups' | Where-Object { $_ } | ForEach-Object { "$_".ToLower() })
        @($current | Where-Object { $desired -notcontains "$_".ToLower() })
    }
    else {
        $named = @(Get-CtgProp $Config 'removeGroups' | Where-Object { $_ })
        @($named | Where-Object { $current -contains $_ })
    }
    foreach ($g in $toRemove) {
        if (-not $PSCmdlet.ShouldProcess($g, "Remove $email from group")) { continue }
        try {
            Invoke-CtgGoogleApi -Method DELETE -Path "/groups/$g/members/$email" | Out-Null
            $actions.Add("removed from group: $g")
        }
        catch { $actions.Add("WARN could not remove from group $g`: $($_.Exception.Message)") }
    }

    [pscustomobject]@{ System = 'google-workspace'; Status = 'ok'; Actions = @($actions) }
}

# -------------------------------------------------------------------------------------------------
# Interactive super-admin BROWSER flows (google-oauth-signin / google-dwd-grant)
# -------------------------------------------------------------------------------------------------
# These two executors drive Google's own web UI as the interactive Workspace SUPER-ADMIN (the
# 'google-super-admin' secret — a human email + password + One-Time Password), NOT the service-account
# API key ('google-admin') the rest of this module uses. They mirror Invoke-CtgEntraDeviceCode: resolve
# the login from the brokered secret, hand a { username; password; params } spec to the Node/Playwright
# sidecar (Invoke-CtgBrowserFlow), and map the result to the runner's contract. The OTP is minted from
# Delinea AT the prompt via an -OtpRequest spec (a 30s code can't survive browser launch + the SSO hop).
# Withheld from agents without the 'browser' capability by the app's claim gate (BROWSER_SYSTEMS).

function Get-CtgGoogleSuperAdminField {
    param($Secret, [Parameter(Mandatory)][string[]]$Names)
    if (-not $Secret) { return $null }
    $fields = Get-CtgProp $Secret 'Fields'
    foreach ($n in $Names) {
        if ($fields -and ($fields -is [System.Collections.IDictionary]) -and $fields.ContainsKey($n) -and $fields[$n]) { return $fields[$n] }
    }
    return $null
}

# The ONE place that decides what may be typed into Google's sign-in. Returns @{ Ok; Username;
# Password; Reason }. Field synonyms mirror the interactive-admin shape (Username/AdminEmail/.../Email +
# Password/AdminPassword), never a service-account key. The rejected VALUE is never echoed — everything
# here lands in an AuditLog row + a ServiceNow work note; naming the field is enough to fix it.
function Resolve-CtgGoogleSuperAdminLogin {
    param($Secret, [string]$SecretName = 'google-super-admin')
    $username = Get-CtgGoogleSuperAdminField $Secret @('Username', 'AdminEmail', 'AdminUser', 'Email', 'UPN', 'User')
    $password = Get-CtgGoogleSuperAdminField $Secret @('Password', 'AdminPassword')
    if (-not $username -and -not $password) {
        $cred = Get-CtgProp $Secret 'Credential'
        if ($cred) {
            $username = $cred.UserName
            try { $password = $cred.GetNetworkCredential().Password } catch { }
        }
    }
    if (-not $username -or -not $password) {
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "no '$SecretName' secret is wired with a super-admin email + password (fields Username/Password, or AdminEmail/AdminPassword) — wire one in Delinea, and enable One-Time Password on it so Delinea can supply the verification code." }
    }
    if ($username -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "the brokered '$SecretName' username is not an email, so it cannot be a Google sign-in. Set the secret's Username to a Workspace super-admin's email. The value is not repeated here because it may be credential material." }
    }
    [pscustomobject]@{ Ok = $true; Username = $username; Password = $password; Reason = $null }
}

# Shared: build the { username; password; params } spec every Google browser flow takes, folding in the
# preferred OtpRequest (mint-at-the-prompt) and the legacy TOTP-seed fallback. Returns the spec, or
# $null (with a WARN pushed to $Actions) when no login is wired.
function New-CtgGoogleBrowserInput {
    param($Secret, [string]$SecretName, [hashtable]$OtpRequest, [hashtable]$Params, [System.Collections.Generic.List[string]]$Actions)
    $login = Resolve-CtgGoogleSuperAdminLogin -Secret $Secret -SecretName $SecretName
    if (-not $login.Ok) { $Actions.Add("WARN $($login.Reason)"); return $null }
    if ($OtpRequest) { $Actions.Add("one-time password will be minted by Delinea at the verification prompt") }
    $totpSeed = Get-CtgGoogleSuperAdminField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'OTP Seed', 'MFASeed', 'MFA Seed', 'AuthenticatorSeed', 'Authenticator Seed', 'OneTimePasswordSeed', 'TwoFactorSeed', '2FASeed', 'otpauth')
    if ($totpSeed -and -not $OtpRequest) { $Actions.Add("WARN using a stored TOTP seed — enable One-Time Password on the Delinea secret instead, so the seed never leaves the vault") }
    $p = @{}
    if ($Params) { foreach ($k in $Params.Keys) { $p[$k] = $Params[$k] } }
    if ($OtpRequest) { $p['otp'] = $OtpRequest }
    if ($totpSeed)   { $p['totpSeed'] = $totpSeed }
    return @{ username = $login.Username; password = $login.Password; params = $p }
}

function Invoke-CtgGoogleOAuthSignin {
    <#
    .SYNOPSIS
        Sign in to Google as the Workspace super-admin and capture the OAuth authorization code the
        consent flow redirects back with (the 'google-oauth-signin' browser flow).
    .DESCRIPTION
        Resolves the super-admin login from the brokered 'google-super-admin' secret, hands the browser
        flow the app-supplied authUrl + redirectUri, and returns the captured code ONLY on its result
        line (OAUTH_CODE:<code>). Never throws for a browser-side failure — a missing browser / bad
        credentials / unautomatable MFA come back as a WARN action (the app then reports no code and the
        operator can complete the consent manually). The code itself never appears in a WARN or a log.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][pscustomobject]$Config,
        $Secret,
        [string]$SecretName = 'google-super-admin',
        [hashtable]$OtpRequest
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $authUrl     = [string](Get-CtgProp $Config 'authUrl')
    $redirectUri = [string](Get-CtgProp $Config 'redirectUri')
    if ([string]::IsNullOrWhiteSpace($authUrl)) { throw "google-oauth-signin: no OAuth auth URL was supplied (config.authUrl) — set it on the job and re-run." }

    $params = @{ authUrl = $authUrl }
    if (-not [string]::IsNullOrWhiteSpace($redirectUri)) { $params['redirectUri'] = $redirectUri }
    $flowInput = New-CtgGoogleBrowserInput -Secret $Secret -SecretName $SecretName -OtpRequest $OtpRequest -Params $params -Actions $actions
    if (-not $flowInput) {
        $actions.Add("WARN could not complete the Google OAuth sign-in — complete the consent manually meanwhile.")
        return [pscustomobject]@{ System = 'google-oauth-signin'; Status = 'ok'; Actions = $actions.ToArray() }
    }

    # -TimeoutSeconds 300: browser launch + Google sign-in + MFA (can wait out a TOTP window) + consent.
    $res = Invoke-CtgBrowserFlow -Flow 'google-oauth-signin' -InputObject $flowInput -TimeoutSeconds 300
    if ($res.ok) {
        # $res.message is the OAUTH_CODE:<code> line — the app reads the code off it. It is the flow's
        # OUTPUT, carried on the result line only (the browser sidecar never logs the code).
        $msg = if ($res.message) { $res.message } else { "completed the Google OAuth sign-in" }
        $actions.Add($msg)
        return [pscustomobject]@{ System = 'google-oauth-signin'; Status = 'ok'; Actions = $actions.ToArray() }
    }
    # Not ok — surface as a WARN (non-fatal): the job still succeeds, the app finds no OAUTH_CODE and
    # reports the sign-in couldn't complete, with this warning attached.
    $err = if ($res.error) { $res.error } else { 'unknown error' }
    $ev  = if ($res.evidence) { " (screenshot: $($res.evidence))" } else { '' }
    $actions.Add("WARN Google OAuth sign-in could not complete — $err$ev")
    [pscustomobject]@{ System = 'google-oauth-signin'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Invoke-CtgGoogleDwdGrant {
    <#
    .SYNOPSIS
        Grant/reconcile domain-wide delegation for a service account in the Admin console (the
        'google-dwd-grant' browser flow).
    .DESCRIPTION
        Resolves the super-admin login, hands the browser flow the service-account client ID + requested
        scopes, and confirms the grant. UNLIKE the OAuth sign-in, the app keys DWD off the job SUCCEEDING
        (there is no result line it parses), so a grant that can't be confirmed must FAIL the job — this
        throws on a non-ok flow result, letting the app fall back to a manual grant. On success the
        DWD_GRANTED:<saClientId> line is recorded for the run report.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][pscustomobject]$Config,
        $Secret,
        [string]$SecretName = 'google-super-admin',
        [hashtable]$OtpRequest
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $saClientId = [string](Get-CtgProp $Config 'saClientId')
    $scopes = @(Get-CtgProp $Config 'scopes' | Where-Object { $_ })
    if ([string]::IsNullOrWhiteSpace($saClientId)) { throw "google-dwd-grant: no service-account client ID was supplied (config.saClientId)." }
    if ($scopes.Count -eq 0) { throw "google-dwd-grant: no scopes were supplied (config.scopes) — nothing to authorize." }

    $params = @{ saClientId = $saClientId; scopes = $scopes }
    $flowInput = New-CtgGoogleBrowserInput -Secret $Secret -SecretName $SecretName -OtpRequest $OtpRequest -Params $params -Actions $actions
    if (-not $flowInput) { throw "google-dwd-grant: $($actions -join '; ')" }

    $res = Invoke-CtgBrowserFlow -Flow 'google-dwd-grant' -InputObject $flowInput -TimeoutSeconds 300
    if ($res.ok) {
        $msg = if ($res.message) { $res.message } else { "DWD_GRANTED:$saClientId" }
        $actions.Add($msg)
        return [pscustomobject]@{ System = 'google-dwd-grant'; Status = 'ok'; Actions = $actions.ToArray() }
    }
    # A grant that can't be confirmed must fail the job so the app surfaces the manual-grant fallback.
    $err = if ($res.error) { $res.error } else { 'unknown error' }
    $ev  = if ($res.evidence) { " (screenshot: $($res.evidence))" } else { '' }
    throw "domain-wide delegation grant could not be confirmed — $err$ev"
}

Export-ModuleMember -Function Connect-CtgGoogle, Get-CtgGoogleSessionScopes, Invoke-CtgGoogleApi, Get-CtgGoogleUser, Get-CtgGoogleUserGroups, Invoke-CtgGoogleOnboarding, Invoke-CtgGoogleOffboarding, Confirm-CtgGoogle, Invoke-CtgGooglePasswordReset, Invoke-CtgGoogleChange, Invoke-CtgGoogleOAuthSignin, Invoke-CtgGoogleDwdGrant
