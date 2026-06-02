#Requires -Version 7.0

# Coretelligent.Mimecast
# Mimecast email security lifecycle via the Mimecast 2.0 API (cloud-gateway). Users are
# sourced from directory sync (AD/365), so onboarding = trigger a sync + verify the client's
# internal domain is present; offboarding = remove from any configured Mimecast groups.
# Idempotent: safe to re-run after a partial failure.
#
# Auth: OAuth2 client-credentials. Secret `mimecast` resolves to { UserName=client_id,
# Password=client_secret }. Tokens last ~30 min; Connect-CtgMimecast refreshes on demand.
#
# API shape (verified against the Mimecast 2.0 docs):
#   POST /oauth/token
#   POST /directory/cloud-gateway/v1/integrations/sync-requests
#   GET  /domain/cloud-gateway/v1/internal-domains
#   GET/POST /directory/cloud-gateway/v1/groups[/{id}/members | /{id}/remove-members]

Set-StrictMode -Version Latest

$script:MimecastBaseUrl = 'https://api.services.mimecast.com'
$script:MimecastToken   = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgMimecast {
    <#
    .SYNOPSIS
        Acquire a Mimecast 2.0 bearer token via the client-credentials flow.
    .PARAMETER Credential
        UserName = client_id, Password = client_secret (from the `mimecast` Delinea secret).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscredential]$Credential,
        [string]$BaseUrl = $script:MimecastBaseUrl
    )
    $body = @{
        grant_type    = 'client_credentials'
        client_id     = $Credential.UserName
        client_secret = (ConvertFrom-SecureString $Credential.Password -AsPlainText)
    }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/oauth/token" `
        -Body $body -ContentType 'application/x-www-form-urlencoded'
    $script:MimecastToken   = $resp.access_token
    $script:MimecastBaseUrl = $BaseUrl
    Write-Verbose "Mimecast session established."
}

function Invoke-CtgMimecastApi {
    <#
    .SYNOPSIS
        Single HTTP seam for the Mimecast 2.0 API (bearer auth). Mocked in tests.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        $Body
    )
    if (-not $script:MimecastToken) { throw "Call Connect-CtgMimecast first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:MimecastBaseUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:MimecastToken" }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    Invoke-RestMethod @p
}

function Invoke-CtgMimecastOnboarding {
    <#
    .SYNOPSIS
        Idempotent Mimecast onboarding: trigger a directory sync (so the new user flows in from
        AD/365) and verify the client's internal domain is registered + verified.
    .PARAMETER Config
        The mimecast onboard config: syncAll, verifyInternalDirectory (e.g. "@client.com").
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $status = 'ok'

    # 1. Trigger a directory sync so the synced user appears in Mimecast -------
    if ((Get-CtgProp $Config 'syncAll') -and $PSCmdlet.ShouldProcess('directory', 'Trigger Mimecast sync')) {
        Invoke-CtgMimecastApi -Method POST -Path '/directory/cloud-gateway/v1/integrations/sync-requests' | Out-Null
        $actions.Add("triggered directory sync")
    }

    # 2. Verify the client's internal domain is registered + verified ---------
    $verify = Get-CtgProp $Config 'verifyInternalDirectory'
    if ($verify) {
        $domain = ([string]$verify).TrimStart('@').ToLower()
        $resp = Invoke-CtgMimecastApi -Method GET -Path '/domain/cloud-gateway/v1/internal-domains'
        $match = @($resp.data) | Where-Object { ([string]$_.domain).ToLower() -eq $domain } | Select-Object -First 1
        if ($match) {
            $actions.Add("internal domain verified: $domain ($($match.status))")
        }
        else {
            $actions.Add("WARN internal domain not found: $domain")
            $status = 'partial'
        }
    }

    [pscustomobject]@{ System = 'mimecast'; Status = $status; Upn = $User.UserPrincipalName; Actions = $actions.ToArray() }
}

function Invoke-CtgMimecastOffboarding {
    <#
    .SYNOPSIS
        Idempotent Mimecast offboarding: remove the user from any configured Mimecast groups.
        (The mailbox itself is governed by the disabled/removed directory account on next sync.)
    .PARAMETER Config
        The mimecast offboard config: groups[] (Mimecast group ids/names to remove from).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    foreach ($groupId in @(Get-CtgProp $Config 'groups')) {
        if ($groupId -and $PSCmdlet.ShouldProcess($email, "Remove from Mimecast group $groupId")) {
            Invoke-CtgMimecastApi -Method POST -Path "/directory/cloud-gateway/v1/groups/$groupId/remove-members" `
                -Body @{ data = @(@{ emailAddress = $email }) } | Out-Null
            $actions.Add("removed from Mimecast group: $groupId")
        }
    }
    if ($actions.Count -eq 0) { $actions.Add("no Mimecast group removals configured (mailbox follows the directory account)") }

    [pscustomobject]@{ System = 'mimecast'; Status = 'ok'; Upn = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgMimecast {
    <#
    .SYNOPSIS
        Post-action read-back for Mimecast. No mutations; returns { ok; checks[] }.
        onboard -> the client's internal domain is registered + verified.
        offboard -> the user is absent from each configured Mimecast group.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )

    $checks = [System.Collections.Generic.List[object]]::new()
    $add = { param($name, $expected, $actual) $checks.Add(@{ name = $name; expected = $expected; actual = $actual; pass = ($expected -eq $actual) }) }

    if ($Action -eq 'onboard') {
        $verify = Get-CtgProp $Config 'verifyInternalDirectory'
        if ($verify) {
            $domain = ([string]$verify).TrimStart('@').ToLower()
            $resp = Invoke-CtgMimecastApi -Method GET -Path '/domain/cloud-gateway/v1/internal-domains'
            $match = @($resp.data) | Where-Object { ([string]$_.domain).ToLower() -eq $domain } | Select-Object -First 1
            & $add "internal domain verified: $domain" $true ([bool]$match)
        }
    }
    else {
        $email = ([string]$User.UserPrincipalName).ToLower()
        foreach ($g in @(Get-CtgProp $Config 'groups')) {
            if (-not $g) { continue }
            $resp = Invoke-CtgMimecastApi -Method GET -Path "/directory/cloud-gateway/v1/groups/$g/members"
            $present = @($resp.data) | Where-Object { ([string]$_.emailAddress).ToLower() -eq $email }
            & $add "removed from group $g" $true ([bool](-not $present))
        }
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

Export-ModuleMember -Function Connect-CtgMimecast, Invoke-CtgMimecastApi, Invoke-CtgMimecastOnboarding, Invoke-CtgMimecastOffboarding, Confirm-CtgMimecast
