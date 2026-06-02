#Requires -Version 7.0

# Coretelligent.Zoom
# Zoom user lifecycle via the Zoom REST API v2 (server-to-server OAuth). Onboard creates a
# licensed user; offboard deactivates (which removes licenses and blocks login — reversible).
# Idempotent: checks for the user before creating.
#
# Auth: server-to-server OAuth. Secret `zoom` -> { UserName=client_id, Password=client_secret }
# plus an account id. POST https://zoom.us/oauth/token?grant_type=account_credentials&account_id=...
# with a Basic client_id:client_secret header.

Set-StrictMode -Version Latest

$script:ZoomApiUrl = 'https://api.zoom.us/v2'
$script:ZoomToken  = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgZoom {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscredential]$Credential,
        [Parameter(Mandatory)][string]$AccountId
    )
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
        "$($Credential.UserName):$(ConvertFrom-SecureString $Credential.Password -AsPlainText)"))
    $uri = "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$AccountId"
    $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = "Basic $basic" }
    $script:ZoomToken = $resp.access_token
    Write-Verbose "Zoom session established."
}

function Invoke-CtgZoomApi {
    # Single HTTP seam (bearer auth). Mocked in tests. Returns $null on 404 (not found).
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:ZoomToken) { throw "Call Connect-CtgZoom first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:ZoomApiUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:ZoomToken" }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { return Invoke-RestMethod @p }
    catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }
        throw
    }
}

function Get-CtgZoomUser {
    param([Parameter(Mandatory)][string]$Email)
    Invoke-CtgZoomApi -Method GET -Path "/users/$Email"
}

function Invoke-CtgZoomOnboarding {
    <#
    .SYNOPSIS
        Idempotently create a Zoom user. Config: type (1=Basic,2=Licensed; default 2), action
        (create|ssoCreate|autoCreate|custCreate; default 'create').
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    if (Get-CtgZoomUser -Email $email) {
        $actions.Add("Zoom user already exists: $email")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Create Zoom user")) {
        $body = @{
            action    = ((Get-CtgProp $Config 'action') ?? 'create')
            user_info = @{
                email      = $email
                type       = [int]((Get-CtgProp $Config 'type') ?? 2)
                first_name = $User.FirstName
                last_name  = $User.LastName
            }
        }
        Invoke-CtgZoomApi -Method POST -Path '/users' -Body $body | Out-Null
        $actions.Add("created Zoom user: $email (type $($body.user_info.type))")
    }

    [pscustomobject]@{ System = 'zoom'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgZoomOffboarding {
    <#
    .SYNOPSIS
        Deactivate the Zoom user (removes licenses, blocks login) — or delete if config.delete.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    if (-not (Get-CtgZoomUser -Email $email)) {
        $actions.Add("Zoom user not found: $email")
        return [pscustomobject]@{ System = 'zoom'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    if (Get-CtgProp $Config 'delete') {
        if ($PSCmdlet.ShouldProcess($email, "Delete Zoom user")) {
            Invoke-CtgZoomApi -Method DELETE -Path "/users/$email" | Out-Null
            $actions.Add("deleted Zoom user: $email")
        }
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Deactivate Zoom user")) {
        Invoke-CtgZoomApi -Method PUT -Path "/users/$email/status" -Body @{ action = 'deactivate' } | Out-Null
        $actions.Add("deactivated Zoom user: $email")
    }

    [pscustomobject]@{ System = 'zoom'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgZoom {
    <#
    .SYNOPSIS
        Post-action read-back for Zoom. No mutations; returns { ok; checks[] }.
        onboard -> the user is present. offboard -> the user is absent (deleted) or deactivated.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    $email = $User.UserPrincipalName
    $u = Get-CtgZoomUser -Email $email
    if ($Action -eq 'onboard') {
        $check = @{ name = 'Zoom user present'; expected = $true; actual = [bool]$u; pass = [bool]$u }
    }
    else {
        # Deleted users return $null; deactivated users have status != 'active'.
        $gone = (-not $u) -or ((Get-CtgProp $u 'status') -and (Get-CtgProp $u 'status') -ne 'active')
        $check = @{ name = 'Zoom user removed/deactivated'; expected = $true; actual = [bool]$gone; pass = [bool]$gone }
    }
    [pscustomobject]@{ ok = $check.pass; checks = @($check) }
}

Export-ModuleMember -Function Connect-CtgZoom, Invoke-CtgZoomApi, Get-CtgZoomUser, Invoke-CtgZoomOnboarding, Invoke-CtgZoomOffboarding, Confirm-CtgZoom
