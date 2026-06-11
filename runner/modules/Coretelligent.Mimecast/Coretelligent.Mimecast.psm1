#Requires -Version 7.0

# Coretelligent.Mimecast
# Mimecast email security lifecycle. Users normally flow IN from directory sync (AD/365), so
# onboarding = verify a sync connection exists -> trigger a sync -> confirm the user's profile is
# visible (optionally CREATE a cloud user in the Internal Directory when the client doesn't sync,
# config createIfMissing). Offboarding = remove the user from configured Mimecast groups (the
# mailbox itself follows the disabled directory account on the next sync). Idempotent throughout.
#
# Auth: OAuth2 client-credentials (API 2.0). Secret `mimecast` resolves to { UserName=client_id,
# Password=client_secret }. API 2.0 serves the classic endpoint set at api.services.mimecast.com
# with Bearer auth; requests/responses use the classic envelope:
#   request : POST <path>  body { "data": [ { ... } ] }    (often an empty data array)
#   response: { "meta": { status }, "data": [ ... ], "fail": [ { errors:[{code,message}] } ] }
# A call can return HTTP 200 with a populated fail[] — the seam surfaces those as errors.
#
# Endpoints (per integrations.mimecast.com endpoint reference):
#   POST /api/directory/get-connection   — list directory sync connections
#   POST /api/directory/execute-sync     — trigger a directory sync
#   POST /api/user/get-profile           — { emailAddress } -> profile | fail(user not found)
#   POST /api/user/create-user           — { emailAddress, name, password?, forcePasswordChange }
#   POST /api/directory/find-groups      — { query } -> groups (id, description)
#   POST /api/directory/remove-group-member / get-group-members — group membership

Set-StrictMode -Version Latest

$script:MimecastBaseUrl = 'https://api.services.mimecast.com'
$script:MimecastToken   = $null
$script:MimecastCredential = $null  # kept so an expired token (~30 min life) can re-mint mid-job

function Get-CtgProp {
    # Read a property whether $Object is a hashtable, a generic IDictionary, or a PSObject.
    # Returns $null when absent (StrictMode-safe access).
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
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
    $script:MimecastToken      = $resp.access_token
    $script:MimecastBaseUrl    = $BaseUrl
    $script:MimecastCredential = $Credential
    Write-Verbose "Mimecast session established."
}

function Invoke-CtgMimecastApi {
    <#
    .SYNOPSIS
        Single HTTP seam for the Mimecast API (bearer auth, classic envelope). Mocked in tests.
        Wraps -Data in { data: [...] }, throws enriched errors (method + URL + response body —
        never the credential), and converts an HTTP-200-with-fail[] response into a throw unless
        -AllowFail. Returns the response's data array (or the raw response with -AllowFail).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        $Data,                  # one hashtable, an array of them, or $null (-> empty data array)
        [switch]$AllowFail      # caller inspects .fail itself (e.g. user-not-found probes)
    )
    if (-not $script:MimecastToken) { throw "Call Connect-CtgMimecast first." }
    $items = if ($null -eq $Data) { @() } elseif ($Data -is [array]) { $Data } else { @($Data) }
    # The if-expression above UNWRAPS an empty array to $null on assignment (PowerShell), which
    # serialized as {"data": null} — Mimecast rejects that with err_deserialise "payload contains
    # null objects". Re-array + drop nulls so an empty data is a REAL [].
    $items = @($items | Where-Object { $null -ne $_ })
    $p = @{
        Method      = 'POST'
        Uri         = "$script:MimecastBaseUrl$Path"
        Headers     = @{ Authorization = "Bearer $script:MimecastToken"; Accept = 'application/json' }
        ContentType = 'application/json'
        Body        = (@{ data = $items } | ConvertTo-Json -Depth 8)
    }
    $resp = $null
    foreach ($attempt in 1, 2) {
        try { $resp = Invoke-RestMethod @p; break }
        catch {
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
            # Bearer tokens last ~30 min — on token_expired/401, re-mint from the stored credential
            # and retry ONCE instead of failing a long-running job mid-flight.
            if ($attempt -eq 1 -and $script:MimecastCredential -and ($status -eq 401 -or $detail -match 'token_expired')) {
                Connect-CtgMimecast -Credential $script:MimecastCredential -BaseUrl $script:MimecastBaseUrl
                $p.Headers = @{ Authorization = "Bearer $script:MimecastToken"; Accept = 'application/json' }
                continue
            }
            if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
            $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
            throw "Mimecast API: POST $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
        }
    }
    if ($AllowFail) { return $resp }
    $fail = Get-CtgProp $resp 'fail'
    if ($fail -and @($fail).Count -gt 0) {
        $msgs = @($fail) | ForEach-Object { @(Get-CtgProp $_ 'errors') | ForEach-Object { "$(Get-CtgProp $_ 'code'): $(Get-CtgProp $_ 'message')" } }
        throw "Mimecast API: POST $($p.Uri) -> request failed — $($msgs -join '; ')"
    }
    @(Get-CtgProp $resp 'data')
}

function Get-CtgMimecastProfile {
    # The user's Mimecast profile, or $null when Mimecast doesn't know them (yet). ONLY a
    # recognizably user-not-found fail counts as a lookup miss — any other fail (deserialise,
    # permissions, throttling) THROWS, so a broken request can't masquerade as "user not synced".
    param([Parameter(Mandatory)][string]$Email)
    $resp = Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{ emailAddress = $Email } -AllowFail
    $fail = @(Get-CtgProp $resp 'fail')
    if ($fail.Count -gt 0) {
        $msgs = @($fail | ForEach-Object { @(Get-CtgProp $_ 'errors') | ForEach-Object { "$(Get-CtgProp $_ 'code'): $(Get-CtgProp $_ 'message')" } })
        $joined = $msgs -join '; '
        if ($joined -match 'unknown|not.?found|no such|invalid.*(user|email|address)|user.*invalid') { return $null }
        # A "forbidden for address" / permissions fail is a Mimecast setup problem, not a transient
        # miss — say what to fix instead of surfacing the raw code.
        if ($joined -match 'forbidden|operation_forbidden|not .{0,6}permitted|unauthoriz|permission|denied') {
            $domain = if ($Email -match '@') { $Email.Split('@')[1] } else { $Email }
            throw "Mimecast: not permitted to read $Email — the API 2.0 application lacks user/directory read permission (or '$domain' isn't an internal/managed domain on this Mimecast account). In the Mimecast Admin Console, grant the application Directory and User read access, and confirm the domain is added under Internal Directories. (raw: $joined) See /help/mimecast."
        }
        throw "Mimecast API: POST $script:MimecastBaseUrl/api/user/get-profile -> request failed — $joined"
    }
    @(Get-CtgProp $resp 'data') | Select-Object -First 1
}

function Invoke-CtgMimecastOnboarding {
    <#
    .SYNOPSIS
        Idempotent Mimecast onboarding: verify a directory-sync connection exists, trigger a sync
        (so the new user flows in from AD/365), and confirm the user's profile is visible. When the
        config sets createIfMissing (clients with no directory sync), create the cloud user in the
        Internal Directory instead of waiting for a sync.
    .PARAMETER Config
        syncAll (trigger a sync, default ON), createIfMissing, verifyInternalDirectory ("@client.com").
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [string]$InitialPassword   # used only for createIfMissing cloud users
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    # 1. Directory sync: confirm a connection exists, then trigger a sync run -------------------
    $connections = @()
    try { $connections = @(Invoke-CtgMimecastApi -Path '/api/directory/get-connection') }
    catch { $actions.Add("WARN could not list directory-sync connections: $($_.Exception.Message)") }
    if ($connections.Count -gt 0) {
        $actions.Add("directory-sync connections: $($connections.Count)")
        if ((Get-CtgProp $Config 'syncAll') -ne $false -and $PSCmdlet.ShouldProcess('directory', 'Trigger Mimecast sync')) {
            Invoke-CtgMimecastApi -Path '/api/directory/execute-sync' | Out-Null
            $actions.Add("triggered directory sync")
        }
    }
    elseif (-not (Get-CtgProp $Config 'createIfMissing')) {
        $actions.Add("WARN no directory-sync connection found — users won't flow in automatically (set createIfMissing to create cloud users instead)")
    }

    # 2. Is the user visible yet? ----------------------------------------------------------------
    $profile = Get-CtgMimecastProfile -Email $email
    if ($profile) {
        $actions.Add("Mimecast user present: $email")
    }
    elseif ((Get-CtgProp $Config 'createIfMissing')) {
        if ($PSCmdlet.ShouldProcess($email, 'Create Mimecast cloud user (Internal Directory)')) {
            $new = @{ emailAddress = $email; forcePasswordChange = $true }
            $display = Get-CtgProp $User 'DisplayName'
            if ($display) { $new.name = [string]$display }
            if ($InitialPassword) { $new.password = $InitialPassword }
            Invoke-CtgMimecastApi -Path '/api/user/create-user' -Data $new | Out-Null
            $actions.Add("created Mimecast cloud user: $email (Internal Directory, force password change)")
        }
    }
    else {
        $actions.Add("Mimecast user not visible yet: $email — directory sync runs on Mimecast's schedule; auto-retrying every 15 minutes until the user appears")
        $retryAfter = 15
    }

    # 3. Optional: the client's internal domain is registered ------------------------------------
    $verify = Get-CtgProp $Config 'verifyInternalDirectory'
    if ($verify) {
        $domain = ([string]$verify).TrimStart('@').ToLower()
        try {
            $domains = Invoke-CtgMimecastApi -Path '/api/domain/get-internal-domain'
            $match = $domains | Where-Object { ([string](Get-CtgProp $_ 'domain')).ToLower() -eq $domain } | Select-Object -First 1
            if ($match) { $actions.Add("internal domain verified: $domain") }
            else { $actions.Add("WARN internal domain not found: $domain") }
        }
        catch { $actions.Add("WARN could not check internal domains: $($_.Exception.Message)") }
    }

    $out = @{ System = 'mimecast'; Status = 'ok'; Upn = $email; Actions = $actions.ToArray() }
    if (Get-Variable -Name retryAfter -Scope Local -ErrorAction SilentlyContinue) { $out.RetryAfterMinutes = $retryAfter }
    [pscustomobject]$out
}

function Find-CtgMimecastGroup {
    # Resolve a configured group (name or id) to its id. A long token-looking value is used as-is;
    # otherwise find-groups is queried and the exact description (or id) match wins.
    param([Parameter(Mandatory)][string]$Group)
    if ($Group -match '^[A-Za-z0-9+/=_-]{20,}$') { return $Group }   # already an id
    $found = Invoke-CtgMimecastApi -Path '/api/directory/find-groups' -Data @{ query = $Group }
    $hit = $found | ForEach-Object { @(Get-CtgProp $_ 'folders') + @($_) } | Where-Object {
        $_ -and (([string](Get-CtgProp $_ 'description')) -eq $Group -or ([string](Get-CtgProp $_ 'id')) -eq $Group)
    } | Select-Object -First 1
    if ($hit) { return [string](Get-CtgProp $hit 'id') }
    $null
}

function Invoke-CtgMimecastOffboarding {
    <#
    .SYNOPSIS
        Idempotent Mimecast offboarding: remove the user from any configured Mimecast groups.
        (The mailbox itself is governed by the disabled/removed directory account on next sync.)
    .PARAMETER Config
        groups[] — Mimecast group ids or names to remove the user from.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = $User.UserPrincipalName

    foreach ($g in @(Get-CtgProp $Config 'groups')) {
        if (-not $g) { continue }
        $id = Find-CtgMimecastGroup -Group ([string]$g)
        if (-not $id) { $actions.Add("WARN Mimecast group not found: $g — nothing removed"); continue }
        if ($PSCmdlet.ShouldProcess($email, "Remove from Mimecast group $g")) {
            Invoke-CtgMimecastApi -Path '/api/directory/remove-group-member' -Data @{ id = $id; emailAddress = $email } | Out-Null
            $actions.Add("removed from Mimecast group: $g")
        }
    }
    if ($actions.Count -eq 0) { $actions.Add("no Mimecast group removals configured (mailbox follows the directory account)") }

    [pscustomobject]@{ System = 'mimecast'; Status = 'ok'; Upn = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgMimecast {
    <#
    .SYNOPSIS
        Post-action read-back for Mimecast. No mutations; returns { ok; checks[] }.
        onboard -> the user's profile is visible (and the internal domain, if configured).
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
    $email = [string]$User.UserPrincipalName

    if ($Action -eq 'onboard') {
        $profile = Get-CtgMimecastProfile -Email $email
        & $add "Mimecast user present: $email" $true ([bool]$profile)
        $verify = Get-CtgProp $Config 'verifyInternalDirectory'
        if ($verify) {
            $domain = ([string]$verify).TrimStart('@').ToLower()
            $domains = Invoke-CtgMimecastApi -Path '/api/domain/get-internal-domain'
            $match = $domains | Where-Object { ([string](Get-CtgProp $_ 'domain')).ToLower() -eq $domain } | Select-Object -First 1
            & $add "internal domain verified: $domain" $true ([bool]$match)
        }
    }
    else {
        foreach ($g in @(Get-CtgProp $Config 'groups')) {
            if (-not $g) { continue }
            $id = Find-CtgMimecastGroup -Group ([string]$g)
            if (-not $id) { & $add "removed from group $g (group not found)" $true $true; continue }
            $members = Invoke-CtgMimecastApi -Path '/api/directory/get-group-members' -Data @{ id = $id }
            $present = $members | Where-Object { ([string](Get-CtgProp $_ 'emailAddress')).ToLower() -eq $email.ToLower() }
            & $add "removed from group $g" $true ([bool](-not $present))
        }
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

Export-ModuleMember -Function Connect-CtgMimecast, Invoke-CtgMimecastApi, Get-CtgMimecastProfile, Find-CtgMimecastGroup, Invoke-CtgMimecastOnboarding, Invoke-CtgMimecastOffboarding, Confirm-CtgMimecast
