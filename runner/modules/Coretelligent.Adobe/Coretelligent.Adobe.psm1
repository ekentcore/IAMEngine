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
    $email = $User.UserPrincipalName

    if ($PSCmdlet.ShouldProcess($email, "Remove from Adobe organization")) {
        $cmd = @(@{ user = $email; do = @(@{ removeFromOrg = @{} }) })
        Invoke-CtgAdobeAction -Commands $cmd | Out-Null
        $actions.Add("removed $email from the organization")
    }

    [pscustomobject]@{ System = 'adobe'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

Export-ModuleMember -Function Connect-CtgAdobe, Invoke-CtgAdobeAction, Invoke-CtgAdobeOnboarding, Invoke-CtgAdobeOffboarding
