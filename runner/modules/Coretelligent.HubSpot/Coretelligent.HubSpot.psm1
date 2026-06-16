#Requires -Version 7.0

# Coretelligent.HubSpot
# HubSpot user lifecycle via the User Provisioning API (settings/v3/users). Onboard creates/invites a
# user with the configured role + team; offboard removes the user. Idempotent: a user is keyed by
# email (derived from the person), so an existing email IS the same person — adopt rather than re-create.
#
# Auth: a private-app access token (Bearer). The private app needs the settings.users.* scopes; create
# requires a Super Admin who created the app.

Set-StrictMode -Version Latest

$script:HsToken = $null
$script:HsBase  = 'https://api.hubapi.com'

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgHubSpot {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Token, [string]$BaseUrl)
    $script:HsToken = $Token
    if ($BaseUrl) { $script:HsBase = $BaseUrl.TrimEnd('/') }
}

function Invoke-CtgHubSpotApi {
    # REST seam (bearer). Mocked in tests. Returns $null on 404.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:HsToken) { throw "Call Connect-CtgHubSpot first." }
    $p = @{ Method = $Method; Uri = "$script:HsBase$Path"; Headers = @{ Authorization = "Bearer $script:HsToken" }; ContentType = 'application/json' }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { return Invoke-RestMethod @p }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }; throw }
}

function Get-CtgHubSpotUser {
    # The HubSpot user with this email (idProperty=EMAIL), or $null on 404.
    param([Parameter(Mandatory)][string]$Email)
    Invoke-CtgHubSpotApi -Method GET -Path "/settings/v3/users/$([uri]::EscapeDataString($Email))?idProperty=EMAIL"
}

function Invoke-CtgHubSpotOnboarding {
    <#
    .SYNOPSIS
        Idempotently create/invite a HubSpot user. An existing email is the same person — adopt it.
        Config: roleId (the permission set), primaryTeamId, secondaryTeamIds[], sendWelcomeEmail.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = [string]((Get-CtgProp $User 'WorkEmail') ?? $User.UserPrincipalName)

    $existing = Get-CtgHubSpotUser -Email $email
    if ($existing) {
        $actions.Add("HubSpot user already exists for $email — same person (email is the identity), skipped create")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Create HubSpot user")) {
        $body = @{ email = $email; sendWelcomeEmail = [bool]((Get-CtgProp $Config 'sendWelcomeEmail') ?? $true) }
        $roleId = [string](Get-CtgProp $Config 'roleId')
        if ($roleId) { $body.roleId = $roleId }
        $primaryTeam = [string](Get-CtgProp $Config 'primaryTeamId')
        if ($primaryTeam) { $body.primaryTeamId = $primaryTeam }
        $secondary = @(Get-CtgProp $Config 'secondaryTeamIds')
        if ($secondary.Count) { $body.secondaryTeamIds = $secondary }
        Invoke-CtgHubSpotApi -Method POST -Path '/settings/v3/users' -Body $body | Out-Null
        $actions.Add("created HubSpot user: $email$(if ($roleId) { " (role $roleId)" })")
    }

    [pscustomobject]@{ System = 'hubspot'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgHubSpotOffboarding {
    <#  .SYNOPSIS  Remove the HubSpot user (revokes access).  #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = [string]((Get-CtgProp $User 'WorkEmail') ?? $User.UserPrincipalName)
    $found = Get-CtgHubSpotUser -Email $email
    if (-not $found) { return [pscustomobject]@{ System = 'hubspot'; Status = 'ok'; Actions = @("HubSpot user not found ($email)") } }
    if ($PSCmdlet.ShouldProcess($email, "Remove HubSpot user")) {
        Invoke-CtgHubSpotApi -Method DELETE -Path "/settings/v3/users/$([uri]::EscapeDataString($email))?idProperty=EMAIL" | Out-Null
        $actions.Add("removed HubSpot user: $email")
    }
    [pscustomobject]@{ System = 'hubspot'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgHubSpot {
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action)
    $email = [string]((Get-CtgProp $User 'WorkEmail') ?? $User.UserPrincipalName)
    $u = Get-CtgHubSpotUser -Email $email
    $checks = [System.Collections.Generic.List[hashtable]]::new()
    if ($Action -eq 'onboard') {
        $checks.Add(@{ name = 'HubSpot user present'; expected = $true; actual = [bool]$u; pass = [bool]$u })
    }
    else {
        $checks.Add(@{ name = 'HubSpot user removed'; expected = $true; actual = (-not $u); pass = (-not $u) })
    }
    $ok = -not ($checks | Where-Object { -not $_.pass })
    [pscustomobject]@{ ok = [bool]$ok; checks = @($checks) }
}

Export-ModuleMember -Function Connect-CtgHubSpot, Invoke-CtgHubSpotApi, Get-CtgHubSpotUser, Invoke-CtgHubSpotOnboarding, Invoke-CtgHubSpotOffboarding, Confirm-CtgHubSpot
