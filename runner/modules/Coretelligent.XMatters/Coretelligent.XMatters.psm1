#Requires -Version 7.0

# Coretelligent.XMatters  (xMatters on-call/alerting — remove the departed user on offboard)
# Offboarding removes the user from the alerting roster: by DEFAULT it DEACTIVATES them (status =
# INACTIVE — reversible), and only DELETES when config.delete is set. Onboarding is a no-op (people
# are provisioned by the directory sync). Supersedes the script's manual "please remove from
# xMatters" reminder email.
#
# API (xMatters REST API v1):
#   Base URL : https://{company}.xmatters.com/api/xm/1
#   Auth     : HTTP Basic — a REST web-service user (username:password).
#   Find     : GET  /people?emails={email}  (or ?webLogin={login}) -> { count, data: [ { id,
#              targetName, firstName, lastName, status: 'ACTIVE'|'INACTIVE' } ] }
#   Disable  : POST /people  { id, status: 'INACTIVE' }   (xMatters updates a person by POSTing its id)
#   Delete   : DELETE /people/{id}
# Update is idempotent; we read status first so the report says "already inactive".

Set-StrictMode -Version Latest

$script:XmBaseUrl = $null
$script:XmAuth    = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgXMatters {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,           # https://{company}.xmatters.com (with or without /api/xm/1)
        [Parameter(Mandatory)][pscredential]$Credential
    )
    $u = $BaseUrl.Trim().TrimEnd('/')
    if ($u -notmatch '^https?://') { $u = "https://$u" }
    if ($u -notmatch '/api/xm/v?\d+$') { $u = "$u/api/xm/1" }
    $script:XmBaseUrl = $u
    $pair = "$($Credential.UserName):$(ConvertFrom-SecureString $Credential.Password -AsPlainText)"
    $script:XmAuth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
}

function Invoke-CtgXMattersApi {
    # Single HTTP seam (mocked in tests). HTTP Basic. Never logs the credential.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:XmAuth) { throw "Call Connect-CtgXMatters first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:XmBaseUrl$Path"
        Headers     = @{ Authorization = $script:XmAuth; Accept = 'application/json' }
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
        throw "xMatters API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

function Find-CtgXMattersPerson {
    # GET /people?emails={email}; 404/empty -> $null. Matches the first person whose email/login matches.
    param([Parameter(Mandatory)][string]$Email)
    $resp = try { Invoke-CtgXMattersApi -Method GET -Path "/people?emails=$([uri]::EscapeDataString($Email))" }
            catch { if ($_.Exception.Message -match '\b404\b|not found') { return $null }; throw }
    # @() so an empty data array doesn't unroll to $null (which would wrongly fall through to $resp).
    $list = @(Get-CtgProp $resp 'data')
    $needle = $Email.ToLower()
    # Prefer an exact login/targetName match. The ?emails= query is an exact email filter, so a
    # SINGLE returned person is the match even when targetName/webLogin is a username (not the email).
    # But NEVER guess on an ambiguous (>1, no exact match) set — deactivating the wrong person.
    $hit = $list | Where-Object {
        ([string](Get-CtgProp $_ 'targetName')).ToLower() -eq $needle -or
        ([string](Get-CtgProp $_ 'webLogin')).ToLower() -eq $needle
    } | Select-Object -First 1
    if ($hit) { return $hit }
    if ($list.Count -eq 1) { return $list[0] }
    return $null
}

function Invoke-CtgXMattersOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $actions.Add("xMatters people are provisioned by directory sync — nothing to provision per user")
    [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Invoke-CtgXMattersOffboarding {
    <#
    .SYNOPSIS
        Remove the departed user from xMatters. DEACTIVATE (status=INACTIVE) by default; DELETE only
        when config.delete is set. Idempotent — a no-op when the user is absent or already inactive.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    $found = Find-CtgXMattersPerson -Email $email
    if (-not $found) {
        $actions.Add("xMatters person not found: $email — nothing to remove")
        return [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $id = [string](Get-CtgProp $found 'id')

    if (Get-CtgProp $Config 'delete') {
        if ($PSCmdlet.ShouldProcess($email, "Delete xMatters person")) {
            Invoke-CtgXMattersApi -Method DELETE -Path "/people/$id" | Out-Null
            $actions.Add("deleted xMatters person: $email")
        }
    }
    elseif (([string](Get-CtgProp $found 'status')).ToUpper() -eq 'INACTIVE') {
        $actions.Add("xMatters person already inactive: $email — no change")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Deactivate xMatters person")) {
        Invoke-CtgXMattersApi -Method POST -Path '/people' -Body @{ id = $id; status = 'INACTIVE' } | Out-Null
        $actions.Add("deactivated xMatters person: $email")
    }

    [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgXMatters {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    if ($Action -eq 'onboard') {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'xMatters provisioning is out of band — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
    }
    $found = Find-CtgXMattersPerson -Email $User.UserPrincipalName
    if (-not $found) {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'xMatters person absent — removed'; expected = $true; actual = $true; pass = $true }) }
    }
    $inactive = ([string](Get-CtgProp $found 'status')).ToUpper() -eq 'INACTIVE'
    [pscustomobject]@{ ok = $inactive; checks = @(@{ name = 'xMatters person inactive'; expected = $true; actual = $inactive; pass = $inactive }) }
}

Export-ModuleMember -Function Connect-CtgXMatters, Invoke-CtgXMattersApi, Find-CtgXMattersPerson, Invoke-CtgXMattersOnboarding, Invoke-CtgXMattersOffboarding, Confirm-CtgXMatters
