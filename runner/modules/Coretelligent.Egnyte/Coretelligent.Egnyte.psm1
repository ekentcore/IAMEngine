#Requires -Version 7.0

# Coretelligent.Egnyte
# Egnyte file-sharing user lifecycle. Onboarding CREATES the user (license tier from config
# userType — Power User for most MSP clients, e.g. core131/Drake Star — with standard/admin as
# options); offboarding DEACTIVATES the user (retention-safe; config delete=true removes instead).
# Idempotent: lookups by email gate every mutation.
#
# API: Egnyte User Management API v2 (developers.egnyte.com), per-tenant host.
#   Base      : https://{egnyteDomain}.egnyte.com
#   Auth      : OAuth2 bearer. Egnyte tokens are LONG-LIVED (no expiry unless revoked), so the
#               simplest setup is a once-issued token stored in Delinea. Alternatively the
#               password grant mints one from ClientID (API key) + a service account:
#               POST /puboauth/token  grant_type=password&client_id&username&password
#   List/find : GET    /pubapi/v2/users?filter=email eq "x@y.com"   -> { resources: [user] }
#   Create    : POST   /pubapi/v2/users  { userName, email, name:{givenName,familyName},
#               active, sendInvite, authType: egnyte|sso|ad, userType: admin|power|standard }
#   Update    : PATCH  /pubapi/v2/users/{id}  (partial — e.g. { active: false })
#   Delete    : DELETE /pubapi/v2/users/{id}
# ⚠ The v2 users API is SCIM-flavored; the filter syntax and field spellings above are from the
# public docs but UNVERIFIED against a live tenant — they're confined to the HTTP seam + the
# helpers, and the enriched errors (method + URL + response body) make live adjustment quick.

Set-StrictMode -Version Latest

$script:EgnyteBaseUrl = $null
$script:EgnyteToken   = $null

function Get-CtgProp {
    # Read a property whether $Object is a hashtable, a generic IDictionary, or a PSObject.
    # Returns $null when absent (StrictMode-safe access).
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgEgnyte {
    <#
    .SYNOPSIS
        Point the module at a tenant. Either pass a long-lived -Token directly (preferred — Egnyte
        tokens don't expire), or -ClientId (the API key) + -Credential (service account) to mint
        one via the password grant.
    .PARAMETER Domain
        The tenant's Egnyte domain — "drakestar" or "drakestar.egnyte.com" both work.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Domain,
        [string]$Token,
        [string]$ClientId,
        [pscredential]$Credential
    )
    $d = $Domain.Trim().ToLower() -replace '^https?://', '' -replace '\.egnyte\.com.*$', ''
    $script:EgnyteBaseUrl = "https://$d.egnyte.com"
    if ($Token) {
        $script:EgnyteToken = $Token
        return
    }
    if (-not $ClientId -or -not $Credential) { throw "Connect-CtgEgnyte needs -Token, or -ClientId + -Credential for the password grant." }
    $body = @{
        grant_type = 'password'
        client_id  = $ClientId
        username   = $Credential.UserName
        password   = (ConvertFrom-SecureString $Credential.Password -AsPlainText)
    }
    $resp = Invoke-RestMethod -Method Post -Uri "$script:EgnyteBaseUrl/puboauth/token" -Body $body -ContentType 'application/x-www-form-urlencoded'
    $script:EgnyteToken = $resp.access_token
}

function Invoke-CtgEgnyteApi {
    # Single HTTP seam (bearer auth). Mocked in tests. Enriched errors: method + URL + response
    # body — never the token.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:EgnyteToken) { throw "Call Connect-CtgEgnyte first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:EgnyteBaseUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:EgnyteToken"; Accept = 'application/json' }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { Invoke-RestMethod @p }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
        $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        throw "Egnyte API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

function Find-CtgEgnyteUser {
    # Locate a user by email via the SCIM-style filter. Tolerates {resources}/{Resources}/bare-array
    # response shapes; matches email or userName case-insensitively.
    param([Parameter(Mandatory)][string]$Email)
    $filter = [uri]::EscapeDataString("email eq `"$Email`"")
    $resp = Invoke-CtgEgnyteApi -Method GET -Path "/pubapi/v2/users?filter=$filter"
    $list = Get-CtgProp $resp 'resources'
    if ($null -eq $list) { $list = Get-CtgProp $resp 'Resources' }
    if ($null -eq $list) { $list = $resp }
    $needle = $Email.ToLower()
    @($list) | Where-Object {
        $_ -and (([string](Get-CtgProp $_ 'email')).ToLower() -eq $needle -or ([string](Get-CtgProp $_ 'userName')).ToLower() -eq $needle)
    } | Select-Object -First 1
}

function Invoke-CtgEgnyteOnboarding {
    <#
    .SYNOPSIS
        Create the Egnyte user (idempotent — skips if the email already exists). License tier from
        config userType (power | standard | admin; default power), auth from config authType
        (egnyte | sso | ad; default egnyte — native login with an email invite).
    .PARAMETER Config
        userType, authType, sendInvite (default true).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    $existing = Find-CtgEgnyteUser -Email $email
    if ($existing) {
        $actions.Add("Egnyte user already exists: $email (userType: $((Get-CtgProp $existing 'userType') ?? 'unknown'))")
        if ((Get-CtgProp $existing 'active') -eq $false -and $PSCmdlet.ShouldProcess($email, 'Reactivate Egnyte user')) {
            Invoke-CtgEgnyteApi -Method PATCH -Path "/pubapi/v2/users/$(Get-CtgProp $existing 'id')" -Body @{ active = $true } | Out-Null
            $actions.Add("reactivated previously-deactivated Egnyte user")
        }
        return [pscustomobject]@{ System = 'egnyte'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    $userType = ([string](Get-CtgProp $Config 'userType'))
    if (-not $userType) { $userType = 'power' }
    $authType = ([string](Get-CtgProp $Config 'authType'))
    if (-not $authType) { $authType = 'egnyte' }
    $first = (Get-CtgProp $User 'GivenName') ?? (Get-CtgProp $User 'firstName')
    $last  = (Get-CtgProp $User 'Surname') ?? (Get-CtgProp $User 'lastName')
    if (-not $first -or -not $last) {
        # Fall back to splitting the display name — Egnyte requires both name parts.
        $parts = ([string](Get-CtgProp $User 'DisplayName')).Split(' ', 2)
        if (-not $first) { $first = $parts[0] }
        if (-not $last) { $last = if ($parts.Count -gt 1) { $parts[1] } else { $parts[0] } }
    }

    if ($PSCmdlet.ShouldProcess($email, "Create Egnyte user ($userType, $authType)")) {
        $body = @{
            userName   = ($email -split '@')[0]
            email      = $email
            name       = @{ givenName = [string]$first; familyName = [string]$last }
            active     = $true
            sendInvite = ((Get-CtgProp $Config 'sendInvite') -ne $false)
            authType   = $authType.ToLower()
            userType   = $userType.ToLower()
        }
        # SSO/AD-authed users are matched to the IdP by principal name.
        if ($body.authType -in @('sso', 'ad')) { $body.userPrincipalName = $email }
        Invoke-CtgEgnyteApi -Method POST -Path '/pubapi/v2/users' -Body $body | Out-Null
        $actions.Add("created Egnyte user: $email ($($body.userType) license, $($body.authType) auth$(if ($body.sendInvite) { ', invite sent' }))")
    }

    [pscustomobject]@{ System = 'egnyte'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgEgnyteOffboarding {
    <#
    .SYNOPSIS
        Deactivate the Egnyte user (retention-safe default — their files/links stay). Config
        delete=true removes the account entirely instead. Idempotent: no-op when absent.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    $found = Find-CtgEgnyteUser -Email $email
    if (-not $found) {
        $actions.Add("Egnyte user not found: $email — nothing to deactivate")
        return [pscustomobject]@{ System = 'egnyte'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $id = Get-CtgProp $found 'id'

    if ((Get-CtgProp $Config 'delete') -eq $true) {
        if ($PSCmdlet.ShouldProcess($email, 'DELETE Egnyte user')) {
            Invoke-CtgEgnyteApi -Method DELETE -Path "/pubapi/v2/users/$id" | Out-Null
            $actions.Add("deleted Egnyte user: $email (config delete=true)")
        }
    }
    elseif ((Get-CtgProp $found 'active') -eq $false) {
        $actions.Add("Egnyte user already deactivated: $email")
    }
    elseif ($PSCmdlet.ShouldProcess($email, 'Deactivate Egnyte user')) {
        Invoke-CtgEgnyteApi -Method PATCH -Path "/pubapi/v2/users/$id" -Body @{ active = $false } | Out-Null
        $actions.Add("deactivated Egnyte user: $email (account + files retained)")
    }

    [pscustomobject]@{ System = 'egnyte'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgEgnyte {
    <#
    .SYNOPSIS
        Post-action read-back. No mutations; returns { ok; checks[] }.
        onboard  -> user present + active (+ userType matches config when set).
        offboard -> user absent (deleted) or inactive.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    $found = Find-CtgEgnyteUser -Email $User.UserPrincipalName

    if ($Action -eq 'offboard') {
        $inactive = (-not $found) -or ((Get-CtgProp $found 'active') -eq $false)
        $check = @{ name = 'Egnyte user removed or deactivated'; expected = $true; actual = $inactive; pass = $inactive }
        return [pscustomobject]@{ ok = $check.pass; checks = @($check) }
    }

    $active = [bool]($found -and ((Get-CtgProp $found 'active') -ne $false))
    $checks = @(
        @{ name = 'Egnyte user present'; expected = $true; actual = [bool]$found; pass = [bool]$found },
        @{ name = 'Egnyte user active';  expected = $true; actual = $active;       pass = $active }
    )
    $want = [string](Get-CtgProp $Config 'userType')
    if ($want -and $found) {
        $got = [string](Get-CtgProp $found 'userType')
        $checks += @{ name = "Egnyte license = $want"; expected = $want.ToLower(); actual = $got.ToLower(); pass = ($got.ToLower() -eq $want.ToLower()) }
    }
    [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
}

Export-ModuleMember -Function Connect-CtgEgnyte, Invoke-CtgEgnyteApi, Find-CtgEgnyteUser, Invoke-CtgEgnyteOnboarding, Invoke-CtgEgnyteOffboarding, Confirm-CtgEgnyte
