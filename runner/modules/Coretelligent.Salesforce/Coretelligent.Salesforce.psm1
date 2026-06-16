#Requires -Version 7.0

# Coretelligent.Salesforce
# Salesforce user lifecycle via the REST API. Onboard creates a user (config-driven Profile/role),
# offboard DEACTIVATES (Salesforce never deletes users — IsActive=$false). Idempotent: checks
# state before changing it, and before creating confirms an existing username is the same person
# (else falls back to an alternate username, or pauses for a decision).
#
# Auth: a Connected App with the OAuth 2.0 JWT bearer flow (server-to-server, like Google) — the
# runner signs a JWT with the app's certificate private key and exchanges it for an access token +
# instance URL. No password, no external module, cross-platform.

Set-StrictMode -Version Latest

$script:SfToken    = $null
$script:SfInstance = $null
$script:SfApiVer   = 'v59.0'

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function ConvertTo-CtgSfBase64Url {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Connect-CtgSalesforce {
    <#
    .SYNOPSIS
        Mint a Salesforce access token via the Connected App JWT bearer flow. Signs an RS256 JWT
        (iss=consumer key, sub=the integration user, aud=the login host) with the app's cert private
        key and exchanges it at /services/oauth2/token for an access token + instance URL.
    #>
    [CmdletBinding(DefaultParameterSetName = 'Key')]
    param(
        [Parameter(Mandatory, ParameterSetName = 'Key')][string]$ConsumerKey,   # Connected App client_id
        [Parameter(Mandatory, ParameterSetName = 'Key')][string]$Username,       # the integration user to act as (sub)
        [Parameter(Mandatory, ParameterSetName = 'Key')][string]$PrivateKey,     # the cert private key (PEM)
        [Parameter(Mandatory, ParameterSetName = 'Token')][string]$AccessToken,  # tests / pre-minted
        [Parameter(Mandatory, ParameterSetName = 'Token')][string]$InstanceUrl,
        [string]$LoginUrl = 'https://login.salesforce.com',                      # use https://test.salesforce.com for a sandbox
        [string]$ApiVersion
    )
    if ($ApiVersion) { $script:SfApiVer = $ApiVersion }
    if ($PSCmdlet.ParameterSetName -eq 'Token') {
        $script:SfToken = $AccessToken; $script:SfInstance = $InstanceUrl.TrimEnd('/'); return
    }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = @{ alg = 'RS256'; typ = 'JWT' }
    $claims = @{ iss = $ConsumerKey; sub = $Username; aud = $LoginUrl; exp = $now + 300 }
    $enc = { param($o) ConvertTo-CtgSfBase64Url ([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress))) }
    $signingInput = "$(& $enc $header).$(& $enc $claims)"
    $rsa = [System.Security.Cryptography.RSA]::Create()
    try {
        $rsa.ImportFromPem($PrivateKey)
        $sig = $rsa.SignData([Text.Encoding]::UTF8.GetBytes($signingInput), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    }
    finally { $rsa.Dispose() }
    $jwt = "$signingInput.$(ConvertTo-CtgSfBase64Url $sig)"
    $resp = Invoke-RestMethod -Method POST -Uri "$($LoginUrl.TrimEnd('/'))/services/oauth2/token" `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body @{ grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer'; assertion = $jwt }
    $script:SfToken    = Get-CtgProp $resp 'access_token'
    $script:SfInstance = ([string](Get-CtgProp $resp 'instance_url')).TrimEnd('/')
    if (-not $script:SfToken) { throw "Salesforce token exchange returned no access_token — check the Connected App, the digital certificate, and that '$Username' is pre-authorized for the app." }
}

function Invoke-CtgSalesforceApi {
    # REST seam (bearer). Mocked in tests. $Path is relative to /services/data/<ver>. Returns $null on 404.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body, [switch]$Absolute)
    if (-not $script:SfToken) { throw "Call Connect-CtgSalesforce first." }
    $uri = if ($Absolute) { "$script:SfInstance$Path" } else { "$script:SfInstance/services/data/$script:SfApiVer$Path" }
    $p = @{ Method = $Method; Uri = $uri; Headers = @{ Authorization = "Bearer $script:SfToken" }; ContentType = 'application/json' }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { return Invoke-RestMethod @p }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }; throw }
}

function Get-CtgSalesforceUser {
    # The active/inactive User matching a username (SOQL). Returns the record or $null.
    param([Parameter(Mandatory)][string]$Username)
    $esc = $Username.Replace("'", "\'")
    $resp = Invoke-CtgSalesforceApi -Method GET -Path "/query?q=$([uri]::EscapeDataString("SELECT Id,Username,FirstName,LastName,IsActive FROM User WHERE Username='$esc'"))"
    $records = @(Get-CtgProp $resp 'records')
    if ($records.Count) { return $records[0] }
    return $null
}

function Invoke-CtgSalesforceOnboarding {
    <#
    .SYNOPSIS
        Idempotently create (or adopt) a Salesforce user. Before create: check existence, confirm
        the same person by name, else fall back to an alternate username (or pause for a decision).
        Config: profileId (required to create), userLicense fields (alias, timeZone, locale, language,
        emailEncoding), usernameCollisionPolicy.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $primary = [string]$User.UserPrincipalName
    $email   = [string]((Get-CtgProp $User 'WorkEmail') ?? $User.UserPrincipalName)
    $wantFirst = ([string]$User.FirstName).Trim(); $wantLast = ([string]$User.LastName).Trim()
    $candidates = @(@($primary) + @(Get-CtgProp $User 'UserPrincipalNameFallbacks') | Where-Object { $_ })
    $collisionPolicy = [string](Get-CtgProp $Config 'usernameCollisionPolicy')

    $username = $null; $existing = $null
    foreach ($cand in $candidates) {
        $found = Get-CtgSalesforceUser -Username $cand
        if (-not $found) { $username = $cand; break }
        $fFirst = ([string](Get-CtgProp $found 'FirstName')).Trim(); $fLast = ([string](Get-CtgProp $found 'LastName')).Trim()
        if ($wantFirst -and $wantLast -and $fFirst -ieq $wantFirst -and $fLast -ieq $wantLast) {
            $username = $cand; $existing = $found; $actions.Add("Salesforce user exists ($cand) and matches '$fFirst $fLast' — same person (re-run), skipped create"); break
        }
        if (-not ($fFirst -or $fLast)) { $username = $cand; $existing = $found; $actions.Add("Salesforce user exists ($cand) — adopted (no name to confirm), skipped create"); break }
        if ($collisionPolicy -ieq 'adopt') { $username = $cand; $existing = $found; $actions.Add("Salesforce user exists ($cand) as '$fFirst $fLast' — operator chose ADOPT, skipped create"); break }
        $actions.Add("username '$cand' is taken by a different user ($fFirst $fLast) — trying the next pattern")
    }
    if (-not $username) {
        throw "DECISION_NEEDED:username_collision | Every candidate Salesforce username is taken by a different person: $($candidates -join ', '). Add a username fallback pattern, or set usernameCollisionPolicy=adopt. | upn=$primary | name=$wantFirst $wantLast"
    }
    if ($username -ne $primary) { $actions.Add("using fallback username: $username (primary $primary taken)") }

    if (-not $existing) {
        $profileId = [string](Get-CtgProp $Config 'profileId')
        if (-not $profileId) { throw "Salesforce onboard needs a 'profileId' in config (the user's Profile / license). Set it on the client's salesforce system." }
        if ($PSCmdlet.ShouldProcess($username, "Create Salesforce user")) {
            $alias = [string]((Get-CtgProp $Config 'alias') ?? (($wantFirst.Substring(0, [Math]::Min(1, $wantFirst.Length)) + $wantLast).ToLower()))
            if ($alias.Length -gt 8) { $alias = $alias.Substring(0, 8) }       # Salesforce Alias max 8
            $body = @{
                Username = $username; Email = $email; FirstName = $User.FirstName; LastName = $User.LastName
                Alias = $alias; ProfileId = $profileId
                TimeZoneSidKey = [string]((Get-CtgProp $Config 'timeZone') ?? 'America/New_York')
                LocaleSidKey   = [string]((Get-CtgProp $Config 'locale') ?? 'en_US')
                LanguageLocaleKey = [string]((Get-CtgProp $Config 'language') ?? 'en_US')
                EmailEncodingKey  = [string]((Get-CtgProp $Config 'emailEncoding') ?? 'UTF-8')
            }
            Invoke-CtgSalesforceApi -Method POST -Path '/sobjects/User' -Body $body | Out-Null
            $actions.Add("created Salesforce user: $username (profile $profileId)")
        }
    }

    [pscustomobject]@{ System = 'salesforce'; Status = 'ok'; Username = $username; Actions = $actions.ToArray() }
}

function Invoke-CtgSalesforceOffboarding {
    <#  .SYNOPSIS  Deactivate the user (IsActive=$false). Salesforce never deletes users.  #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $username = [string]$User.UserPrincipalName
    $found = Get-CtgSalesforceUser -Username $username
    if (-not $found) { return [pscustomobject]@{ System = 'salesforce'; Status = 'ok'; Actions = @("Salesforce user not found ($username)") } }
    if ((Get-CtgProp $found 'IsActive') -eq $false) { $actions.Add("already deactivated: $username") }
    elseif ($PSCmdlet.ShouldProcess($username, "Deactivate Salesforce user")) {
        Invoke-CtgSalesforceApi -Method PATCH -Path "/sobjects/User/$($found.Id)" -Body @{ IsActive = $false } | Out-Null
        $actions.Add("deactivated Salesforce user: $username")
    }
    [pscustomobject]@{ System = 'salesforce'; Status = 'ok'; Username = $username; Actions = $actions.ToArray() }
}

function Confirm-CtgSalesforce {
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action)
    $username = [string]$User.UserPrincipalName
    $u = Get-CtgSalesforceUser -Username $username
    $active = [bool]($u -and (Get-CtgProp $u 'IsActive'))
    $checks = [System.Collections.Generic.List[hashtable]]::new()
    if ($Action -eq 'onboard') {
        $checks.Add(@{ name = 'Salesforce user present'; expected = $true; actual = [bool]$u; pass = [bool]$u })
        $checks.Add(@{ name = 'Salesforce user active'; expected = $true; actual = $active; pass = $active })
    }
    else {
        $checks.Add(@{ name = 'Salesforce user deactivated'; expected = $true; actual = (-not $active); pass = (-not $active) })
    }
    $ok = -not ($checks | Where-Object { -not $_.pass })
    [pscustomobject]@{ ok = [bool]$ok; checks = @($checks) }
}

Export-ModuleMember -Function Connect-CtgSalesforce, Invoke-CtgSalesforceApi, Get-CtgSalesforceUser, Invoke-CtgSalesforceOnboarding, Invoke-CtgSalesforceOffboarding, Confirm-CtgSalesforce
