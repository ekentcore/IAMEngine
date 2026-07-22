#Requires -Version 7.0

# Coretelligent.Adobe
# Adobe entitlement lifecycle via the User Management API (UMAPI) v2. Onboard adds the user to
# the configured product profile(s) (which grants the product); offboard removes the user from
# the organization. Federated/Enterprise IDs come from the directory, so we manage entitlements
# rather than create the identity. Idempotent: re-adding/removing is safe.
#
# Auth: OAuth Server-to-Server. Secret `adobe` -> { UserName=client_id, Password=client_secret }
# plus the org id. Token from Adobe IMS; every action call also sends X-Api-Key = client_id.

Set-StrictMode -Version Latest

$script:AdobeApiUrl = 'https://usermanagement.adobe.io'
$script:AdobeImsUrl = 'https://ims-na1.adobelogin.com/ims/token/v3'
$script:AdobeToken  = $null
$script:AdobeOrgId  = $null
$script:AdobeApiKey = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgAdobe {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscredential]$Credential,
        [Parameter(Mandatory)][string]$OrgId
    )
    $body = @{
        grant_type    = 'client_credentials'
        client_id     = $Credential.UserName
        client_secret = (ConvertFrom-SecureString $Credential.Password -AsPlainText)
        scope         = 'openid,AdobeID,user_management_sdk'
    }
    $resp = Invoke-RestMethod -Method Post -Uri $script:AdobeImsUrl -Body $body -ContentType 'application/x-www-form-urlencoded'
    $script:AdobeToken  = $resp.access_token
    $script:AdobeOrgId  = $OrgId
    $script:AdobeApiKey = $Credential.UserName
    Write-Verbose "Adobe UMAPI session established."
}

function Invoke-CtgAdobeAction {
    # POST a UMAPI action request: a list of { user, do: [ <command> ] } objects. Mocked in tests.
    [CmdletBinding()]
    param([Parameter(Mandatory)][array]$Commands)
    if (-not $script:AdobeToken) { throw "Call Connect-CtgAdobe first." }
    $headers = @{
        Authorization  = "Bearer $script:AdobeToken"
        'X-Api-Key'    = $script:AdobeApiKey
        'Content-Type' = 'application/json'
    }
    Invoke-RestMethod -Method Post -Uri "$script:AdobeApiUrl/v2/usermanagement/action/$script:AdobeOrgId" `
        -Headers $headers -Body ($Commands | ConvertTo-Json -Depth 10 -AsArray)
}

function Invoke-CtgAdobeOnboarding {
    <#
    .SYNOPSIS
        Add the user to the configured Adobe product profiles. Config: productProfiles[].
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName
    # Wrap the WHOLE pipeline in @(): `@(x) | Where-Object` returns the pipeline's result, which is
    # $null (not an empty array) when nothing survives the filter — and `$null.Count` THROWS under
    # Set-StrictMode -Version Latest ("The property 'Count' cannot be found on this object"). A client
    # with no productProfiles configured (Adobe onboard is often just "ensure in org") hit exactly that,
    # failing the whole step before it could report "nothing to grant".
    $profiles = @(@(Get-CtgProp $Config 'productProfiles') | Where-Object { $_ })

    if ($profiles.Count -and $PSCmdlet.ShouldProcess($email, "Add to Adobe profiles: $($profiles -join ', ')")) {
        $cmd = @(@{ user = $email; do = @(@{ add = @{ product = @($profiles) } }) })
        Invoke-CtgAdobeAction -Commands $cmd | Out-Null
        $actions.Add("added $email to product profiles: $($profiles -join ', ')")
    }
    else {
        $actions.Add("no Adobe product profiles configured — nothing to grant")
    }

    [pscustomobject]@{ System = 'adobe'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgAdobeOffboarding {
    <#
    .SYNOPSIS
        Remove the user from the Adobe organization (revokes all product access).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    # An offboard payload is NOT identity-derived: a ServiceNow UM intake carries the leaver as
    # `userToOffboard` and may have no UserPrincipalName property AT ALL — and under StrictMode a
    # dot-read of an absent property throws. Go through Get-CtgProp and take the first EMAIL-shaped
    # identifier: Adobe is keyed by email, so a bare display name would "not find" the user and report
    # a false success on an offboard. No email at all is an error worth surfacing, not a silent no-op.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "adobe: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }

    if ($PSCmdlet.ShouldProcess($email, "Remove from Adobe organization")) {
        $cmd = @(@{ user = $email; do = @(@{ removeFromOrg = @{} }) })
        Invoke-CtgAdobeAction -Commands $cmd | Out-Null
        $actions.Add("removed $email from the organization")
    }

    [pscustomobject]@{ System = 'adobe'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Get-CtgAdobeUser {
    # Read seam (UMAPI GET user). Returns $null when the user isn't in the organization. Mocked
    # in tests. The UMAPI user record carries the granted product profiles under `groups`.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Email)
    if (-not $script:AdobeToken) { throw "Call Connect-CtgAdobe first." }
    $headers = @{ Authorization = "Bearer $script:AdobeToken"; 'X-Api-Key' = $script:AdobeApiKey }
    try {
        $resp = Invoke-RestMethod -Method Get -Uri "$script:AdobeApiUrl/v2/usermanagement/organizations/$script:AdobeOrgId/users/$Email" -Headers $headers
        return (Get-CtgProp $resp 'user') ?? $resp
    }
    catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }
        throw
    }
}

function Confirm-CtgAdobe {
    <#
    .SYNOPSIS
        Post-action read-back for Adobe. No mutations; returns { ok; checks[] }.
        onboard -> the user is present in the configured product profile(s).
        offboard -> the user is absent from the organization.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    $checks = [System.Collections.Generic.List[object]]::new()
    $add = { param($name, $expected, $actual) $checks.Add(@{ name = $name; expected = $expected; actual = $actual; pass = ($expected -eq $actual) }) }
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookup below finds nobody, which reads as "already gone" and would rubber-stamp an
    # offboard that nobody performed.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
    $u = Get-CtgAdobeUser -Email $email

    if ($Action -eq 'onboard') {
        & $add 'Adobe user present' $true ([bool]$u)
        $granted = @(Get-CtgProp $u 'groups')
        foreach ($p in @(Get-CtgProp $Config 'productProfiles')) {
            if ($p) { & $add "profile: $p" $true ([bool]($granted -contains $p)) }
        }
    }
    else {
        & $add 'Adobe user absent' $true ([bool](-not $u))
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

# ---- Adobe Developer Console browser auto-setup (create the UMAPI OAuth Server-to-Server credential) ----
# DISTINCT from the API path above: this signs into the Developer Console with an 'adobe-console' admin
# login and drives the browser (adobe-console-setup.mjs) to CREATE the `adobe` API credential, then
# returns it as a Credentials note-property (never logged) for the APP to vault. LIVE-VALIDATION PENDING.

function Get-CtgAdobeConsoleField {
    param($Secret, [Parameter(Mandatory)][string[]]$Names)
    if (-not $Secret) { return $null }
    $fields = Get-CtgProp $Secret 'Fields'
    foreach ($n in $Names) {
        if ($fields -and ($fields -is [System.Collections.IDictionary]) -and $fields.ContainsKey($n) -and $fields[$n]) { return $fields[$n] }
    }
    return $null
}

# Decide what may be typed into Adobe's console login. Returns @{ Ok; Username; Password; Reason }.
# Synonyms mirror field-requirements.ts 'adobe-console'. The rejected VALUE is never echoed.
function Resolve-CtgAdobeConsoleLogin {
    param($Secret, [string]$SecretName = 'adobe-console')
    $username = Get-CtgAdobeConsoleField $Secret @('Username', 'AdminEmail', 'AdminUser', 'Email', 'User')
    $password = Get-CtgAdobeConsoleField $Secret @('Password', 'AdminPassword')
    if (-not $username -and -not $password) {
        $cred = Get-CtgProp $Secret 'Credential'
        if ($cred) { $username = $cred.UserName; try { $password = $cred.GetNetworkCredential().Password } catch { } }
    }
    if (-not $username -or -not $password) {
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "no '$SecretName' secret is wired with an Adobe admin email + password (fields Username/Password, or AdminEmail/AdminPassword) — wire one in Delinea, and enable One-Time Password on it so Delinea can supply the verification code." }
    }
    if ($username -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "the brokered '$SecretName' username is not an email, so it cannot be an Adobe console sign-in. Set the secret's Username to an Adobe admin's email. The value is not repeated here because it may be credential material." }
    }
    return [pscustomobject]@{ Ok = $true; Username = [string]$username; Password = [string]$password; Reason = $null }
}

function New-CtgAdobeConsoleInput {
    param($Secret, [string]$SecretName, [hashtable]$OtpRequest, [hashtable]$Params, [System.Collections.Generic.List[string]]$Actions)
    $login = Resolve-CtgAdobeConsoleLogin -Secret $Secret -SecretName $SecretName
    if (-not $login.Ok) { $Actions.Add("WARN $($login.Reason)"); return $null }
    if ($OtpRequest) { $Actions.Add("one-time password will be minted by Delinea at the verification prompt") }
    $totpSeed = Get-CtgAdobeConsoleField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'OTP Seed', 'MFASeed', 'AuthenticatorSeed', 'OneTimePasswordSeed', 'otpauth')
    if ($totpSeed -and -not $OtpRequest) { $Actions.Add("WARN using a stored TOTP seed — enable One-Time Password on the Delinea secret instead, so the seed never leaves the vault") }
    $p = @{}
    if ($Params) { foreach ($k in $Params.Keys) { $p[$k] = $Params[$k] } }
    if ($OtpRequest) { $p['otp'] = $OtpRequest }
    if ($totpSeed)   { $p['totpSeed'] = $totpSeed }
    return @{ username = $login.Username; password = $login.Password; params = $p }
}

function Invoke-CtgAdobeConsoleSetup {
    <#
    .SYNOPSIS
        Drive the Adobe Developer Console via the browser sidecar to create the User Management API
        OAuth Server-to-Server credential and HARVEST its Client ID / Client Secret / Organization ID.
        Config.signInOnly=$true is a sign-in test (changes nothing). Selectors are LIVE-VALIDATION PENDING.
    .DESCRIPTION
        Resolves the console login from the brokered 'adobe-console' secret and runs the
        'adobe-console-setup' flow. THROWS on a non-ok flow result (missing browser, bad credentials,
        unautomatable MFA), carrying the error + screenshot path, so the app's setup reads as failed. No
        credential value is ever logged; harvested values ride back only as a Credentials note-property.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][pscustomobject]$Config,
        $Secret,
        [string]$SecretName = 'adobe-console',
        [hashtable]$OtpRequest
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $consoleUrl = [string](Get-CtgProp $Config 'consoleUrl')
    $signInOnlyProp = Get-CtgProp $Config 'signInOnly'
    $signInOnly = ($null -ne $signInOnlyProp) -and [bool]$signInOnlyProp  # default FALSE (full setup)

    $params = @{ signInOnly = $signInOnly }
    if (-not [string]::IsNullOrWhiteSpace($consoleUrl)) { $params['consoleUrl'] = $consoleUrl }
    $appName = [string](Get-CtgProp $Config 'appName')
    if (-not [string]::IsNullOrWhiteSpace($appName)) { $params['appName'] = $appName }
    $flowInput = New-CtgAdobeConsoleInput -Secret $Secret -SecretName $SecretName -OtpRequest $OtpRequest -Params $params -Actions $actions
    if (-not $flowInput) { throw "Adobe console setup could not start — $([string]::Join(' ', $actions))" }

    $res = Invoke-CtgBrowserFlow -Flow 'adobe-console-setup' -InputObject $flowInput -TimeoutSeconds 300
    if ($res.ok) {
        $msg = if ($res.message) { $res.message } else { 'created the Adobe User Management API credential' }
        $actions.Add($msg)
        $out = [pscustomobject]@{ System = 'adobe-console-setup'; Status = 'ok'; Actions = $actions.ToArray() }
        if ($res.harvested -and $res.harvested.clientId -and $res.harvested.clientSecret) {
            $cred = [pscustomobject]@{ clientId = [string]$res.harvested.clientId; clientSecret = [string]$res.harvested.clientSecret }
            if ($res.harvested.orgId) { Add-Member -InputObject $cred -NotePropertyName orgId -NotePropertyValue ([string]$res.harvested.orgId) }
            Add-Member -InputObject $out -NotePropertyName Credentials -NotePropertyValue $cred
        }
        return $out
    }
    $err = if ($res.error) { $res.error } else { 'unknown error' }
    $ev  = if ($res.evidence) { " (screenshot: $($res.evidence))" } else { '' }
    throw "Adobe console setup failed — $err$ev"
}

Export-ModuleMember -Function Connect-CtgAdobe, Invoke-CtgAdobeAction, Invoke-CtgAdobeOnboarding, Invoke-CtgAdobeOffboarding, Get-CtgAdobeUser, Confirm-CtgAdobe, Resolve-CtgAdobeConsoleLogin, Invoke-CtgAdobeConsoleSetup
