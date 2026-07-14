#Requires -Version 7.0

# Coretelligent.LogicMonitor  (LogicMonitor monitoring — remove the departed user on offboard)
# LogicMonitor users are "admins". Offboarding removes the departed user's access: by DEFAULT it
# SUSPENDS them (status=suspended — reversible), and only DELETES when config.delete is set.
# Onboarding is a no-op. Supersedes the script's manual "please remove from LogicMonitor" email.
#
# API (LogicMonitor REST API v3, LMv1 auth):
#   Base URL : https://{account}.logicmonitor.com/santaba/rest
#   Auth     : LMv1 request signing per request —
#                 requestVars = METHOD + epoch_ms + body + resourcePath   (resourcePath has NO query)
#                 sig = base64( hex( HMAC-SHA256(requestVars, accessKey) ) )
#                 header Authorization: LMv1 {accessId}:{sig}:{epoch_ms}
#   Find     : GET   /setting/admins?filter=email:"{email}"  -> { data: { total, items: [ { id,
#              username, email, status: 'active'|'suspended' } ] } }
#   Suspend  : PATCH /setting/admins/{id}?patchFields=status   { status: 'suspended' }
#   Delete   : DELETE /setting/admins/{id}
# PATCH is idempotent; we read status first so the report says "already suspended".

Set-StrictMode -Version Latest

$script:LmBaseUrl   = $null
$script:LmAccessId  = $null
$script:LmAccessKey = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgLogicMonitor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Account,     # the portal subdomain (e.g. 'coretelligent') OR a full URL
        [Parameter(Mandatory)][string]$AccessId,
        [Parameter(Mandatory)][string]$AccessKey
    )
    $a = $Account.Trim()
    if ($a -match '^https?://') { $script:LmBaseUrl = ($a.TrimEnd('/') -replace '/santaba/rest$', '') + '/santaba/rest' }
    else { $script:LmBaseUrl = "https://$a.logicmonitor.com/santaba/rest" }
    $script:LmAccessId  = $AccessId
    $script:LmAccessKey = $AccessKey
}

function Get-CtgLmSignature {
    # LMv1 signature for one request. Pure (no network) so it's unit-testable. resourcePath excludes
    # the query string; the body is "" for GET/DELETE.
    param(
        [Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Epoch,
        [string]$Body = '', [Parameter(Mandatory)][string]$ResourcePath, [Parameter(Mandatory)][string]$AccessKey
    )
    $requestVars = "$($Method.ToUpper())$Epoch$Body$ResourcePath"
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($AccessKey))
    try { $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($requestVars)) } finally { $hmac.Dispose() }
    $hex = ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($hex))
}

function Invoke-CtgLogicMonitorApi {
    # Single HTTP seam (mocked in tests). LMv1-signs the request. -Path is the resourcePath (no query);
    # -Query (a string like 'filter=email:"x"') rides the URL only, never the signature.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body, [string]$Query)
    if (-not $script:LmAccessKey) { throw "Call Connect-CtgLogicMonitor first." }
    $epoch = [string][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $bodyJson = if ($Body) { $Body | ConvertTo-Json -Depth 8 -Compress } else { '' }
    $sig = Get-CtgLmSignature -Method $Method -Epoch $epoch -Body $bodyJson -ResourcePath $Path -AccessKey $script:LmAccessKey
    $p = @{
        Method      = $Method
        Uri         = "$script:LmBaseUrl$Path$(if ($Query) { "?$Query" })"
        Headers     = @{ Authorization = "LMv1 $($script:LmAccessId):$sig`:$epoch"; Accept = 'application/json'; 'X-Version' = '3' }
        ContentType = 'application/json'
    }
    if ($bodyJson) { $p.Body = $bodyJson }
    try { Invoke-RestMethod @p }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
        $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        throw "LogicMonitor API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

function Find-CtgLmAdmin {
    # GET /setting/admins?filter=email:"{email}". Returns the matching admin object or $null.
    param([Parameter(Mandatory)][string]$Email)
    $resp = Invoke-CtgLogicMonitorApi -Method GET -Path '/setting/admins' -Query "filter=email:`"$Email`""
    $data = Get-CtgProp $resp 'data'
    $items = @(Get-CtgProp $data 'items')
    if (-not $items.Count) { $items = @(Get-CtgProp $resp 'items') }   # tolerate a flattened shape
    $needle = $Email.ToLower()
    $hit = $items | Where-Object {
        ([string](Get-CtgProp $_ 'email')).ToLower() -eq $needle -or
        ([string](Get-CtgProp $_ 'username')).ToLower() -eq $needle
    } | Select-Object -First 1
    # Exact email/username match only. The server-side filter can fuzzy/substring-match, so NEVER
    # fall back to an arbitrary first item — suspending/deleting the wrong admin on offboard.
    if ($hit) { return $hit } else { return $null }
}

function Test-CtgLmSuspended {
    param($Admin)
    ([string](Get-CtgProp $Admin 'status')).ToLower() -eq 'suspended'
}

function Invoke-CtgLogicMonitorOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $actions.Add("LogicMonitor user provisioning is handled separately — nothing to provision per user")
    [pscustomobject]@{ System = 'logicmonitor'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Invoke-CtgLogicMonitorOffboarding {
    <#
    .SYNOPSIS
        Remove the departed user from LogicMonitor. SUSPEND (status=suspended) by default; DELETE only
        when config.delete is set. Idempotent — a no-op when the admin is absent or already suspended.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    # StrictMode-safe identity read: an offboard payload may carry no UserPrincipalName property at all
    # (a ServiceNow UM intake carries `userToOffboard`), and a dot-read of an absent property throws.
    # Only an email-shaped identifier can find the user here — a bare display name would report a false
    # "not found" success on an offboard, so no email is an error, not a silent no-op.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "logicmonitor: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }

    $found = Find-CtgLmAdmin -Email $email
    if (-not $found) {
        $actions.Add("LogicMonitor user not found: $email — nothing to remove")
        return [pscustomobject]@{ System = 'logicmonitor'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $id = [string](Get-CtgProp $found 'id')

    if (Get-CtgProp $Config 'delete') {
        if ($PSCmdlet.ShouldProcess($email, "Delete LogicMonitor user")) {
            Invoke-CtgLogicMonitorApi -Method DELETE -Path "/setting/admins/$id" | Out-Null
            $actions.Add("deleted LogicMonitor user: $email")
        }
    }
    elseif (Test-CtgLmSuspended $found) {
        $actions.Add("LogicMonitor user already suspended: $email — no change")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Suspend LogicMonitor user")) {
        Invoke-CtgLogicMonitorApi -Method PATCH -Path "/setting/admins/$id" -Query 'patchFields=status' -Body @{ status = 'suspended' } | Out-Null
        $actions.Add("suspended LogicMonitor user: $email")
    }

    [pscustomobject]@{ System = 'logicmonitor'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgLogicMonitor {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    if ($Action -eq 'onboard') {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'LogicMonitor provisioning is out of band — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
    }
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookup below finds nobody, which reads as "already removed" and would rubber-stamp an
    # offboard that nobody performed.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
    $found = Find-CtgLmAdmin -Email $email
    if (-not $found) {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'LogicMonitor user absent — removed'; expected = $true; actual = $true; pass = $true }) }
    }
    $suspended = Test-CtgLmSuspended $found
    [pscustomobject]@{ ok = $suspended; checks = @(@{ name = 'LogicMonitor user suspended'; expected = $true; actual = $suspended; pass = $suspended }) }
}

Export-ModuleMember -Function Connect-CtgLogicMonitor, Get-CtgLmSignature, Invoke-CtgLogicMonitorApi, Find-CtgLmAdmin, Test-CtgLmSuspended, Invoke-CtgLogicMonitorOnboarding, Invoke-CtgLogicMonitorOffboarding, Confirm-CtgLogicMonitor
