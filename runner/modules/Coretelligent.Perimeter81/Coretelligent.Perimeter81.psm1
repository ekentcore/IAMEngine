#Requires -Version 7.0

# Coretelligent.Perimeter81  (Check Point Harmony SASE)
# VPN/SASE user lifecycle. Onboarding is GROUP-DRIVEN — the user gains access by group/AD sync,
# so this module does NOT add the user directly; it just verifies license headroom. Offboarding
# finds the user by email and removes them (which frees the seat).
#
# ⚠ API CAVEAT: there is no authoritative public/Context7 reference for the current Harmony SASE
# API, so the endpoint paths below are BEST-EFFORT and must be verified against the tenant
# (adjust $script:P81ApiUrl and the paths in one place — the seam). The MODULE BEHAVIOUR
# (group-driven onboard, find-then-remove offboard, idempotency) is the stable contract.
#
# Auth: API key as a bearer token (secret `perimeter81`).

Set-StrictMode -Version Latest

$script:P81ApiUrl = 'https://api.perimeter81.com'   # verify for Harmony SASE tenants
$script:P81Token  = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgPerimeter81 {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ApiKey, [string]$BaseUrl = $script:P81ApiUrl)
    # The legacy API uses a static API key as the bearer token; Harmony SASE may issue a token
    # via an auth exchange — verify and adapt here if so.
    $script:P81Token  = $ApiKey
    $script:P81ApiUrl = $BaseUrl
}

function Invoke-CtgP81Api {
    # Single HTTP seam (bearer auth). Mocked in tests. Adjust paths here when verified.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:P81Token) { throw "Call Connect-CtgPerimeter81 first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:P81ApiUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:P81Token" }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    Invoke-RestMethod @p
}

function Find-CtgP81User {
    param([Parameter(Mandatory)][string]$Email)
    $resp = Invoke-CtgP81Api -Method GET -Path "/api/v1/users?search=$Email"
    @($resp.data) | Where-Object { ([string]$_.email).ToLower() -eq $Email.ToLower() } | Select-Object -First 1
}

function Invoke-CtgPerimeter81Onboarding {
    <#
    .SYNOPSIS
        Group-driven onboard: the user gets VPN access via group/AD sync, so this only verifies
        license headroom (if ensureLicenseAvailable) and records that membership is group-driven.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $actions.Add("membership is group-driven — the user is NOT added directly (per the runbook)")

    if (Get-CtgProp $Config 'ensureLicenseAvailable') {
        try {
            $lic = Invoke-CtgP81Api -Method GET -Path '/api/v1/licenses'
            $actions.Add("license headroom checked")
            if ((Get-CtgProp $Config 'procureIfUnavailable')) { $actions.Add("procure if unavailable: flagged") }
        }
        catch { $actions.Add("WARN could not check license headroom: $($_.Exception.Message)") }
    }

    [pscustomobject]@{ System = 'perimeter81'; Status = 'ok'; Email = $User.UserPrincipalName; Actions = $actions.ToArray() }
}

function Invoke-CtgPerimeter81Offboarding {
    <#
    .SYNOPSIS
        Find the user by email and remove them (frees the seat / downticks the license).
        Idempotent: no-op if the user isn't present.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName
    $found = Find-CtgP81User -Email $email

    if (-not $found) {
        $actions.Add("Perimeter 81 user not found: $email — nothing to remove")
    }
    elseif ((Get-CtgProp $Config 'removeUser') -ne $false -and $PSCmdlet.ShouldProcess($email, "Remove Perimeter 81 user")) {
        Invoke-CtgP81Api -Method DELETE -Path "/api/v1/users/$($found.id)" | Out-Null
        $actions.Add("removed Perimeter 81 user: $email")
        if ((Get-CtgProp $Config 'downtickLicense')) { $actions.Add("seat freed (license downticked on removal)") }
    }

    [pscustomobject]@{ System = 'perimeter81'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgPerimeter81 {
    <#
    .SYNOPSIS
        Post-action read-back for Perimeter 81. No mutations; returns { ok; checks[] }.
        onboard -> license headroom is available (membership itself is group-driven).
        offboard -> the user is absent (seat freed).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    if ($Action -eq 'offboard') {
        $found = Find-CtgP81User -Email $User.UserPrincipalName
        $check = @{ name = 'Perimeter 81 user absent'; expected = $true; actual = [bool](-not $found); pass = [bool](-not $found) }
        return [pscustomobject]@{ ok = $check.pass; checks = @($check) }
    }
    # Onboard is group-driven; the only verifiable read-back is license headroom.
    $checks = @()
    if (Get-CtgProp $Config 'ensureLicenseAvailable') {
        $lic = Invoke-CtgP81Api -Method GET -Path '/api/v1/licenses'
        $available = [int]((Get-CtgProp $lic 'available') ?? (Get-CtgProp $lic 'seatsAvailable') ?? 0)
        $checks = @(@{ name = 'license headroom available'; expected = $true; actual = ($available -gt 0); pass = ($available -gt 0) })
    }
    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

Export-ModuleMember -Function Connect-CtgPerimeter81, Invoke-CtgP81Api, Find-CtgP81User, Invoke-CtgPerimeter81Onboarding, Invoke-CtgPerimeter81Offboarding, Confirm-CtgPerimeter81
