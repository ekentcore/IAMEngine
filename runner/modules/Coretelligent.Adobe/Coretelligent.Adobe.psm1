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
    $profiles = @(Get-CtgProp $Config 'productProfiles') | Where-Object { $_ }

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

Export-ModuleMember -Function Connect-CtgAdobe, Invoke-CtgAdobeAction, Invoke-CtgAdobeOnboarding, Invoke-CtgAdobeOffboarding, Get-CtgAdobeUser, Confirm-CtgAdobe
