#Requires -Version 7.0

# Coretelligent.Duo  (Duo Security MFA — remove the departed user from Duo on offboard)
# Offboarding removes the user's ability to satisfy MFA: by DEFAULT it DEACTIVATES them (status =
# disabled — reversible, audit-friendly), and only DELETES when config.delete is set. Onboarding is a
# no-op (Duo enrolment is driven by the directory sync / self-enrolment, not provisioned here).
# Supersedes the script's manual "please remove from Duo" reminder email.
#
# API (Duo Admin API):
#   Base host : api-XXXXXXXX.duosecurity.com   (the Admin API hostname from the Duo admin panel)
#   Auth      : HMAC-SHA1 request signing. Per request:
#                 canon = date \n METHOD \n host(lower) \n path \n sorted-url-encoded-params
#                 sig   = hex( HMAC-SHA1(canon, secretKey) )
#                 header Authorization: Basic base64(integrationKey : sig);  header Date: <rfc2822>
#   Find      : GET    /admin/v1/users?username={email}  -> { response: [ { user_id, username,
#               email, status: 'active'|'disabled'|'bypass'|'locked out' } ] }
#   Disable   : POST   /admin/v1/users/{user_id}   params status=disabled
#   Delete    : DELETE /admin/v1/users/{user_id}
# Disable is idempotent server-side; we read status first so the report says "already disabled".

Set-StrictMode -Version Latest

$script:DuoHost    = $null
$script:DuoIKey    = $null
$script:DuoSKey    = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgDuo {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ApiHost,          # api-XXXX.duosecurity.com (scheme stripped)
        [Parameter(Mandatory)][string]$IntegrationKey,
        [Parameter(Mandatory)][string]$SecretKey
    )
    $script:DuoHost = ($ApiHost -replace '^https?://', '').Trim('/')
    $script:DuoIKey = $IntegrationKey
    $script:DuoSKey = $SecretKey
}

function Get-CtgDuoSignature {
    # The Duo HMAC-SHA1 canonical-string signature for one request. Pure (no network) so it's unit-
    # testable on its own. Params are sorted and url-encoded; the date is part of the signature.
    param(
        [Parameter(Mandatory)][string]$Date, [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$DuoHost, [Parameter(Mandatory)][string]$Path,
        [hashtable]$Params = @{}, [Parameter(Mandatory)][string]$SecretKey
    )
    $canon = (@($Params.Keys) | Sort-Object | ForEach-Object {
            '{0}={1}' -f [uri]::EscapeDataString($_), [uri]::EscapeDataString([string]$Params[$_])
        }) -join '&'
    $sigString = @($Date, $Method.ToUpper(), $DuoHost.ToLower(), $Path, $canon) -join "`n"
    $hmac = [System.Security.Cryptography.HMACSHA1]::new([Text.Encoding]::UTF8.GetBytes($SecretKey))
    try { $hash = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($sigString)) } finally { $hmac.Dispose() }
    ([BitConverter]::ToString($hash) -replace '-', '').ToLower()
}

function Invoke-CtgDuoApi {
    # Single HTTP seam (mocked in tests). Signs the request and sends it. Params ride the query string
    # for GET/DELETE and the form body for POST — but ALWAYS sign all of them.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, [hashtable]$Params = @{})
    if (-not $script:DuoSKey) { throw "Call Connect-CtgDuo first." }
    $date = (Get-Date).ToUniversalTime().ToString('ddd, dd MMM yyyy HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + ' -0000'
    $sig  = Get-CtgDuoSignature -Date $date -Method $Method -DuoHost $script:DuoHost -Path $Path -Params $Params -SecretKey $script:DuoSKey
    $auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($script:DuoIKey):$sig"))
    $query = (@($Params.Keys) | Sort-Object | ForEach-Object { '{0}={1}' -f [uri]::EscapeDataString($_), [uri]::EscapeDataString([string]$Params[$_]) }) -join '&'
    $p = @{
        Method  = $Method
        Headers = @{ Authorization = $auth; Date = $date; Accept = 'application/json' }
    }
    if ($Method -eq 'POST') {
        $p.Uri = "https://$($script:DuoHost)$Path"
        $p.Body = $query
        $p.ContentType = 'application/x-www-form-urlencoded'
    }
    else {
        $p.Uri = "https://$($script:DuoHost)$Path$(if ($query) { "?$query" })"
    }
    try { Invoke-RestMethod @p }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
        $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        throw "Duo API: $Method https://$($script:DuoHost)$Path -> $what$(if ($detail) { " — $detail" })"
    }
}

function Find-CtgDuoUser {
    # GET /admin/v1/users?username={email}. Returns the matching user object or $null.
    param([Parameter(Mandatory)][string]$Username)
    $resp = Invoke-CtgDuoApi -Method GET -Path '/admin/v1/users' -Params @{ username = $Username }
    $list = Get-CtgProp $resp 'response'
    if ($null -eq $list) { $list = $resp }
    $needle = $Username.ToLower()
    @($list) | Where-Object {
        ([string](Get-CtgProp $_ 'username')).ToLower() -eq $needle -or
        ([string](Get-CtgProp $_ 'email')).ToLower() -eq $needle
    } | Select-Object -First 1
}

function Invoke-CtgDuoOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $actions.Add("Duo enrolment is driven by directory sync / self-enrolment — nothing to provision per user")
    [pscustomobject]@{ System = 'duo'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Invoke-CtgDuoOffboarding {
    <#
    .SYNOPSIS
        Remove the departed user from Duo. DEACTIVATE (status=disabled) by default — reversible and
        keeps the audit trail; DELETE only when config.delete is set. Idempotent — a no-op when the
        user is absent or already disabled.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    # StrictMode-safe identity read: an offboard payload may carry no UserPrincipalName property at all
    # (a ServiceNow UM intake carries `userToOffboard`), and a dot-read of an absent property throws.
    # Only an email-shaped identifier can find the user here — a bare display name would report a false
    # "not found" success on an offboard, so no email is an error, not a silent no-op.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "duo: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }

    $found = Find-CtgDuoUser -Username $email
    if (-not $found) {
        $actions.Add("Duo user not found: $email — nothing to remove")
        return [pscustomobject]@{ System = 'duo'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $id = [string](Get-CtgProp $found 'user_id')

    if (Get-CtgProp $Config 'delete') {
        if ($PSCmdlet.ShouldProcess($email, "Delete Duo user")) {
            Invoke-CtgDuoApi -Method DELETE -Path "/admin/v1/users/$id" | Out-Null
            $actions.Add("deleted Duo user: $email")
        }
    }
    elseif (([string](Get-CtgProp $found 'status')).ToLower() -eq 'disabled') {
        $actions.Add("Duo user already disabled: $email — no change")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Disable Duo user")) {
        Invoke-CtgDuoApi -Method POST -Path "/admin/v1/users/$id" -Params @{ status = 'disabled' } | Out-Null
        $actions.Add("disabled Duo user: $email")
    }

    [pscustomobject]@{ System = 'duo'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgDuo {
    <#
    .SYNOPSIS
        Read-back. onboard -> always passes. offboard -> user absent (deleted) or disabled = pass.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    if ($Action -eq 'onboard') {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'Duo enrolment is out of band — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
    }
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookup below finds nobody, which reads as "already removed" and would rubber-stamp an
    # offboard that nobody performed.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
    $found = Find-CtgDuoUser -Username $email
    if (-not $found) {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'Duo user absent — removed'; expected = $true; actual = $true; pass = $true }) }
    }
    $disabled = ([string](Get-CtgProp $found 'status')).ToLower() -eq 'disabled'
    [pscustomobject]@{ ok = $disabled; checks = @(@{ name = 'Duo user disabled'; expected = $true; actual = $disabled; pass = $disabled }) }
}

Export-ModuleMember -Function Connect-CtgDuo, Get-CtgDuoSignature, Invoke-CtgDuoApi, Find-CtgDuoUser, Invoke-CtgDuoOnboarding, Invoke-CtgDuoOffboarding, Confirm-CtgDuo
