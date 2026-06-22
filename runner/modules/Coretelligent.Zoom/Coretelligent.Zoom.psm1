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
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Zoom user license tiers (the `type` field): 1 = Basic (free, no license), 2 = Licensed (Pro),
# 3 = On-Prem. Onboarding ensures the user is Licensed (2) by default; offboarding deactivates,
# which drops the license back to the account pool.
$script:ZoomTypeName = @{ 1 = 'Basic'; 2 = 'Licensed'; 3 = 'On-Prem' }

function Connect-CtgZoom {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscredential]$Credential,
        [Parameter(Mandatory)][string]$AccountId
    )
    # Guard up front so a blank field fails with a clear message, not an opaque 400 from Zoom.
    $clientId = [string]$Credential.UserName
    $clientSecret = ConvertFrom-SecureString $Credential.Password -AsPlainText
    if ([string]::IsNullOrWhiteSpace($AccountId))    { throw "Zoom: the 'zoom' secret has no Account ID — set AccountId to the Server-to-Server OAuth app's Account ID (see /help/zoom)." }
    if ([string]::IsNullOrWhiteSpace($clientId))     { throw "Zoom: the 'zoom' secret has no Client ID — set Username = Client ID (see /help/zoom)." }
    if ([string]::IsNullOrWhiteSpace($clientSecret)) { throw "Zoom: the 'zoom' secret has no Client Secret — set Password = Client Secret (see /help/zoom)." }

    # Zoom credentials are plain ASCII. A non-ASCII character (most often a 'smart quote' ' ' or a
    # stray symbol introduced by copy-paste through an app that auto-corrects) is the #1 cause of an
    # invalid_client where the value "looks right" — catch it here and name the exact field, since
    # Zoom's error can't tell you which one.
    foreach ($pair in @(@('Account ID', $AccountId), @('Client ID', $clientId), @('Client Secret', $clientSecret))) {
        if ($pair[1] -match '[^\x20-\x7E]') {
            throw "Zoom: the $($pair[0]) on the 'zoom' secret contains a non-ASCII character (likely a 'smart quote' or stray symbol from copy-paste) — re-paste it as PLAIN TEXT straight from the Zoom app's App Credentials page (see /help/zoom)."
        }
    }

    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${clientId}:${clientSecret}"))
    $uri = "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$([uri]::EscapeDataString($AccountId))"
    try {
        $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers @{ Authorization = "Basic $basic" } -ErrorAction Stop
    }
    catch {
        # Surface Zoom's actual error body (e.g. {"reason":"Invalid client_id or client_secret",
        # "error":"invalid_client"}) instead of the opaque "400 ()". The body is the real diagnosis:
        # invalid_client -> wrong Client ID/Secret; invalid_request / "account does not exist" -> wrong
        # Account ID; "scope" -> the S2S app is missing a scope or isn't activated.
        # Probe each source SAFELY — StrictMode throws on a missing property, and the error shape
        # varies (HttpResponseException vs a plain RuntimeException). Prefer Zoom's JSON body
        # (ErrorDetails.Message), then the raw response stream, then the exception message.
        $detail = ''
        try { $detail = [string]$_.ErrorDetails.Message } catch { }
        $resp = $null; try { $resp = $_.Exception.Response } catch { }
        if (-not $detail -and $resp) {
            try { $detail = [IO.StreamReader]::new($resp.GetResponseStream()).ReadToEnd() } catch { }
        }
        if (-not $detail) { try { $detail = [string]$_.Exception.Message } catch { } }
        $status = ''
        if ($resp) { try { $status = [int]$resp.StatusCode } catch { } }
        throw "Zoom token request failed ($status): $($detail.Trim()) — verify the 'zoom' secret's Account ID + Client ID/Secret and that the Server-to-Server OAuth app is ACTIVATED with the required scopes (see /help/zoom)."
    }
    if (-not $resp.access_token) { throw "Zoom token request returned no access_token (response: $($resp | ConvertTo-Json -Depth 4 -Compress))." }
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
        Idempotently create a Zoom user and (if configured) assign a Zoom Phone calling plan + number.
        Config: type (1=Basic,2=Licensed; default 2), action (create|ssoCreate|autoCreate|custCreate;
        default 'create'), phone{ callingPlanType, number | numberId } (omit phone to skip).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName
    $desiredType = [int]((Get-CtgProp $Config 'type') ?? 2)   # 2 = Licensed (Pro) by default
    $typeName = { param($t) ($script:ZoomTypeName[[int]$t]) ?? "type $t" }

    $existing = Get-CtgZoomUser -Email $email
    if ($existing) {
        $actions.Add("Zoom user already exists: $email")
        # Ensure they hold the desired LICENSE — a pre-existing Basic user is upgraded to Licensed
        # (the create call below only runs for a brand-new user, so without this an existing Basic
        # account would never get its license). PATCH /users/{id} { type } is the assignment.
        $curType = [int]((Get-CtgProp $existing 'type') ?? 0)
        if ($curType -ne $desiredType -and $PSCmdlet.ShouldProcess($email, "Set Zoom license to $(& $typeName $desiredType)")) {
            Invoke-CtgZoomApi -Method PATCH -Path "/users/$email" -Body @{ type = $desiredType } | Out-Null
            $actions.Add("set Zoom license: $(& $typeName $curType) -> $(& $typeName $desiredType)")
        }
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Create Zoom user")) {
        $body = @{
            action    = ((Get-CtgProp $Config 'action') ?? 'create')
            user_info = @{
                email      = $email
                type       = $desiredType
                first_name = $User.FirstName
                last_name  = $User.LastName
            }
        }
        Invoke-CtgZoomApi -Method POST -Path '/users' -Body $body | Out-Null
        $actions.Add("created Zoom user: $email ($(& $typeName $desiredType))")
    }

    # Zoom Phone: assign a calling plan + number when configured. Idempotent — skips whichever is
    # already present. Requires Zoom Phone to be licensed on the account; the number must already
    # exist in the account's number pool (config 'number' or 'numberId').
    $phone = Get-CtgProp $Config 'phone'
    if ($phone) {
        $current  = Invoke-CtgZoomApi -Method GET -Path "/phone/users/$email"   # $null if not yet a phone user
        $planType = Get-CtgProp $phone 'callingPlanType'
        $hasPlan  = [bool]($current -and @(Get-CtgProp $current 'calling_plans').Count)
        if ($planType -and -not $hasPlan -and $PSCmdlet.ShouldProcess($email, "Assign Zoom calling plan $planType")) {
            Invoke-CtgZoomApi -Method POST -Path "/phone/users/$email/calling_plans" -Body @{ calling_plans = @(@{ type = [int]$planType }) } | Out-Null
            $actions.Add("assigned Zoom calling plan: $planType")
        }
        $numId = [string](Get-CtgProp $phone 'numberId'); $num = [string](Get-CtgProp $phone 'number')
        $hasNumber = [bool]($current -and @(Get-CtgProp $current 'phone_numbers').Count)
        if (($numId -or $num) -and -not $hasNumber -and $PSCmdlet.ShouldProcess($email, "Assign Zoom phone number")) {
            $entry = if ($numId) { @{ id = $numId } } else { @{ number = $num } }
            Invoke-CtgZoomApi -Method POST -Path "/phone/users/$email/phone_numbers" -Body @{ phone_numbers = @($entry) } | Out-Null
            $actions.Add("assigned Zoom phone number: $(if ($numId) { $numId } else { $num })")
        }
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
        # A deleted user has no session to revoke — the DELETE already ends access.
        return [pscustomobject]@{ System = 'zoom'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    if ($PSCmdlet.ShouldProcess($email, "Deactivate Zoom user")) {
        Invoke-CtgZoomApi -Method PUT -Path "/users/$email/status" -Body @{ action = 'deactivate' } | Out-Null
        $actions.Add("deactivated Zoom user: $email")
    }

    # Revoke the SSO token / sign the user out of all sessions — deactivation blocks new logins
    # but doesn't end live sessions. DELETE /users/{id}/token revokes the user's SSO token.
    if ((Get-CtgProp $Config 'revokeSso') -ne $false) {
        if ($PSCmdlet.ShouldProcess($email, "Revoke Zoom SSO token")) {
            try {
                Invoke-CtgZoomApi -Method DELETE -Path "/users/$email/token" | Out-Null
                $actions.Add("revoked Zoom SSO token (signed out of all sessions)")
            }
            catch { $actions.Add("WARN could not revoke Zoom SSO token: $($_.Exception.Message)") }
        }
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
        $present = [bool]$u
        $checks = @(@{ name = 'Zoom user present'; expected = $true; actual = $present; pass = $present })
        # Verify the LICENSE landed: the user's type matches the desired tier (default 2 = Licensed).
        $desiredType = [int]((Get-CtgProp $Config 'type') ?? 2)
        if ($present) {
            $curType = [int]((Get-CtgProp $u 'type') ?? 0)
            $checks += @{ name = "Zoom license = $(($script:ZoomTypeName[$desiredType]) ?? $desiredType)"; expected = $desiredType; actual = $curType; pass = ($curType -eq $desiredType) }
        }
        return [pscustomobject]@{ ok = ($checks.pass -notcontains $false); checks = $checks }
    }
    # Deleted users return $null; deactivated users have status != 'active'.
    $gone = (-not $u) -or ((Get-CtgProp $u 'status') -and (Get-CtgProp $u 'status') -ne 'active')
    $check = @{ name = 'Zoom user removed/deactivated'; expected = $true; actual = [bool]$gone; pass = [bool]$gone }
    [pscustomobject]@{ ok = $check.pass; checks = @($check) }
}

Export-ModuleMember -Function Connect-CtgZoom, Invoke-CtgZoomApi, Get-CtgZoomUser, Invoke-CtgZoomOnboarding, Invoke-CtgZoomOffboarding, Confirm-CtgZoom
