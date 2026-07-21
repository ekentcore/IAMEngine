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
    $maxAttempts = 4
    $reminted = $false
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        try { $resp = Invoke-RestMethod @p; break }
        catch {
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
            # Bearer tokens last ~30 min — on token_expired/401, re-mint from the stored credential
            # and retry ONCE instead of failing a long-running job mid-flight.
            if (-not $reminted -and $script:MimecastCredential -and ($status -eq 401 -or $detail -match 'token_expired')) {
                $reminted = $true
                Connect-CtgMimecast -Credential $script:MimecastCredential -BaseUrl $script:MimecastBaseUrl
                $p.Headers = @{ Authorization = "Bearer $script:MimecastToken"; Accept = 'application/json' }
                continue
            }
            # Mimecast's gateway sheds load with 502/503/504 (e.g. "GatewayTimeout: Connection to service
            # has timed out") and throttles with 429. These say nothing about the request itself — only
            # 401 was retried before, so a single gateway blip failed the whole onboard step. Back off and
            # retry; the executors are idempotent (they check state before changing it), so a repeat is
            # safe. 500 is NOT retried: it can mean the request was processed and then blew up.
            $transient = ($status -in 429, 502, 503, 504) -or ($detail -match 'GatewayTimeout|BadGateway|ServiceUnavailable|timed out|throttl')
            if ($transient -and $attempt -lt $maxAttempts) {
                $delay = [int][Math]::Min(8, [Math]::Pow(2, $attempt))  # 2, 4, 8s
                if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) {
                    Send-CtgProgress "Mimecast is busy (HTTP $status) — retrying in ${delay}s ($($attempt + 1)/$maxAttempts)"
                }
                Start-Sleep -Seconds $delay
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
        $domain = if ($Email -match '@') { $Email.Split('@')[1] } else { $Email }
        # err_xdk_operation_forbidden_for_address: Mimecast returns "Forbidden To Perform Operation For
        # Address" for an address it doesn't MANAGE yet — a brand-new hire not synced from the directory
        # — which is semantically "not present", NOT a permission gap (existing users on the same account
        # read fine). Confirm by reading a KNOWN address (postmaster@domain): if THAT reads, the app's
        # permissions are fine and this user simply isn't in Mimecast yet -> treat as a miss, so onboarding
        # triggers a sync and auto-retries until she appears (instead of hard-failing as "no permission").
        if ($joined -match 'operation_forbidden_for_address|forbidden.{0,16}address') {
            try {
                $probe = Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{ emailAddress = "postmaster@$domain" } -AllowFail
                if (@(Get-CtgProp $probe 'fail').Count -eq 0 -and @(Get-CtgProp $probe 'data').Count -gt 0) { return $null }
            }
            catch { }  # probe failed too — fall through to the permission diagnosis below
        }
        # A genuine permissions fail (the app can't read users at all) is a Mimecast setup problem, not a
        # transient miss — say what to fix instead of surfacing the raw code.
        if ($joined -match 'forbidden|operation_forbidden|not .{0,6}permitted|unauthoriz|permission|denied') {
            # Discriminate the two causes: best-effort list the account's internal domains. If we CAN
            # read them and $domain is missing -> it's a DOMAIN-not-internal problem; if $domain IS
            # listed -> it's a pure permission gap; if we can't read them at all -> permission gap.
            $internal = $null
            try {
                $dr = @(Invoke-CtgMimecastApi -Path '/api/domain/get-internal-domain')
                $internal = @($dr | ForEach-Object { $d = Get-CtgProp $_ 'domain'; if (-not $d) { $d = Get-CtgProp $_ 'domainName' }; $d } | Where-Object { $_ })
            } catch { }
            $hint = if ($internal -and $internal.Count -gt 0) {
                if ($internal -contains $domain) { " DIAGNOSIS: '$domain' IS an internal domain, so this is a PERMISSIONS gap — grant the API 2.0 application Directory + User READ in its permissions." }
                else { " DIAGNOSIS: this account's internal domains are [$($internal -join ', ')] — '$domain' is NOT among them. Add/verify '$domain' under Internal Directories (or confirm you're onboarding the right email domain)." }
            } else { " DIAGNOSIS: couldn't even read the account's domains — the API 2.0 application is missing read permission (grant it Directory + User read), or it's bound to a different Mimecast account than the one managing '$domain'." }
            throw "Mimecast: not permitted to read $Email — the API 2.0 application lacks user/directory read permission (or '$domain' isn't an internal/managed domain on this Mimecast account).$hint (raw: $joined) See /help/mimecast."
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
            # The sync TRIGGER is best-effort and the sync runs async server-side, so don't fail the
            # onboard if the request times out (504) or errors — the user still flows in on this or
            # Mimecast's next scheduled sync, and a re-run verifies.
            try { Invoke-CtgMimecastApi -Path '/api/directory/execute-sync' | Out-Null; $actions.Add("triggered directory sync") }
            catch {
                $m = $_.Exception.Message
                if ($m -match '\b504\b|GatewayTimeout|timed out|timeout') { $actions.Add("directory sync request timed out at the gateway (504) — Mimecast likely still started the sync; the user flows in shortly (non-fatal, re-run to verify)") }
                else { $actions.Add("WARN couldn't trigger directory sync: $m — the user will still flow in on Mimecast's next scheduled sync") }
            }
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
    # StrictMode-safe identity read: an offboard payload may carry no UserPrincipalName property at all
    # (a ServiceNow UM intake carries `userToOffboard`), and a dot-read of an absent property throws.
    # Only an email-shaped identifier can find the user here — a bare display name would report a false
    # "not found" success on an offboard, so no email is an error, not a silent no-op.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "mimecast: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }

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
    # Same StrictMode-safe chain as the executor — the validator MUST resolve the SAME user, and an
    # offboard payload may carry no UserPrincipalName property at all. Unresolvable is NOT a pass: with
    # no email the lookups below find nobody, which reads as "already gone" and would rubber-stamp an
    # offboard that nobody performed.
    $email = [string](@('UserPrincipalName', 'email', 'WorkEmail', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }

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

# ------------------------------------------------------------------------------------------------
# Console browser auto-setup (Phase 1: sign-in test). Drives the Mimecast Administration Console via
# the Node/Playwright sidecar to prove the console login works, ahead of Phase 2 (create the API 2.0
# app + harvest the credential). Rides the 'mimecast-console' secret (an admin email + password +
# One-Time Password), DISTINCT from the 'mimecast' API 2.0 clientId/secret. Withheld from agents
# without the 'browser' capability (BROWSER_SYSTEMS app-side).
# ------------------------------------------------------------------------------------------------

function Get-CtgMimecastConsoleField {
    param($Secret, [Parameter(Mandatory)][string[]]$Names)
    if (-not $Secret) { return $null }
    $fields = Get-CtgProp $Secret 'Fields'
    foreach ($n in $Names) {
        if ($fields -and ($fields -is [System.Collections.IDictionary]) -and $fields.ContainsKey($n) -and $fields[$n]) { return $fields[$n] }
    }
    return $null
}

# The ONE place that decides what may be typed into Mimecast's console login. Returns @{ Ok; Username;
# Password; Reason }. Field synonyms mirror field-requirements.ts 'mimecast-console'. The rejected
# VALUE is never echoed — naming the field is enough to fix it (this lands in an AuditLog + work note).
function Resolve-CtgMimecastConsoleLogin {
    param($Secret, [string]$SecretName = 'mimecast-console')
    $username = Get-CtgMimecastConsoleField $Secret @('Username', 'AdminEmail', 'AdminUser', 'Email', 'User')
    $password = Get-CtgMimecastConsoleField $Secret @('Password', 'AdminPassword')
    if (-not $username -and -not $password) {
        $cred = Get-CtgProp $Secret 'Credential'
        if ($cred) {
            $username = $cred.UserName
            try { $password = $cred.GetNetworkCredential().Password } catch { }
        }
    }
    if (-not $username -or -not $password) {
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "no '$SecretName' secret is wired with a Mimecast admin email + password (fields Username/Password, or AdminEmail/AdminPassword) — wire one in Delinea, and enable One-Time Password on it so Delinea can supply the verification code." }
    }
    if ($username -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
        return [pscustomobject]@{ Ok = $false; Username = $null; Password = $null; Reason = "the brokered '$SecretName' username is not an email, so it cannot be a Mimecast console sign-in. Set the secret's Username to a Mimecast admin's email. The value is not repeated here because it may be credential material." }
    }
    [pscustomobject]@{ Ok = $true; Username = $username; Password = $password; Reason = $null }
}

# Build the { username; password; params } spec the mimecast-console-signin flow takes, folding in the
# preferred OtpRequest (mint-at-the-prompt) and a legacy TOTP-seed fallback. Returns the spec, or $null
# (with a WARN pushed to $Actions) when no login is wired. Mirrors New-CtgGoogleBrowserInput.
function New-CtgMimecastConsoleInput {
    param($Secret, [string]$SecretName, [hashtable]$OtpRequest, [hashtable]$Params, [System.Collections.Generic.List[string]]$Actions)
    $login = Resolve-CtgMimecastConsoleLogin -Secret $Secret -SecretName $SecretName
    if (-not $login.Ok) { $Actions.Add("WARN $($login.Reason)"); return $null }
    if ($OtpRequest) { $Actions.Add("one-time password will be minted by Delinea at the verification prompt") }
    $totpSeed = Get-CtgMimecastConsoleField $Secret @('TOTPSeed', 'TOTP Seed', 'TOTP', 'OTPSeed', 'OTP Seed', 'MFASeed', 'MFA Seed', 'AuthenticatorSeed', 'Authenticator Seed', 'OneTimePasswordSeed', 'TwoFactorSeed', '2FASeed', 'otpauth')
    if ($totpSeed -and -not $OtpRequest) { $Actions.Add("WARN using a stored TOTP seed — enable One-Time Password on the Delinea secret instead, so the seed never leaves the vault") }
    $p = @{}
    if ($Params) { foreach ($k in $Params.Keys) { $p[$k] = $Params[$k] } }
    if ($OtpRequest) { $p['otp'] = $OtpRequest }
    if ($totpSeed)   { $p['totpSeed'] = $totpSeed }
    return @{ username = $login.Username; password = $login.Password; params = $p }
}

function Invoke-CtgMimecastConsoleSetup {
    <#
    .SYNOPSIS
        Drive the Mimecast Administration Console via the browser sidecar. Phase 1: SIGN-IN TEST
        (Config.signInOnly) — prove the console login + MFA work; changes nothing.
    .DESCRIPTION
        Resolves the console login from the brokered 'mimecast-console' secret and runs the
        'mimecast-console-signin' flow. UNLIKE the Google OAuth sign-in (whose browser failure is a
        non-fatal WARN), a sign-in TEST must FAIL the job on a failed sign-in so the app's "Test
        sign-in" reports red — so this THROWS on a non-ok flow result (missing browser, bad
        credentials, unautomatable MFA), carrying the error + screenshot path. A missing login is a
        throw too (nothing to test). No credential value is ever logged.
    #>
    [CmdletBinding()]
    param(
        [AllowNull()][pscustomobject]$Config,
        $Secret,
        [string]$SecretName = 'mimecast-console',
        [hashtable]$OtpRequest
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $consoleUrl = [string](Get-CtgProp $Config 'consoleUrl')
    # signInOnly defaults TRUE (Phase 1) — only an explicit $false runs the (not-yet-built) full setup.
    $signInOnlyProp = Get-CtgProp $Config 'signInOnly'
    $signInOnly = ($null -eq $signInOnlyProp) -or [bool]$signInOnlyProp

    $params = @{ signInOnly = $signInOnly }
    if (-not [string]::IsNullOrWhiteSpace($consoleUrl)) { $params['consoleUrl'] = $consoleUrl }
    $flowInput = New-CtgMimecastConsoleInput -Secret $Secret -SecretName $SecretName -OtpRequest $OtpRequest -Params $params -Actions $actions
    if (-not $flowInput) {
        throw "Mimecast console sign-in could not start — $([string]::Join(' ', $actions))"
    }

    # -TimeoutSeconds 240: browser launch + Mimecast sign-in + MFA (can wait out a TOTP window).
    $res = Invoke-CtgBrowserFlow -Flow 'mimecast-console-signin' -InputObject $flowInput -TimeoutSeconds 240
    if ($res.ok) {
        $msg = if ($res.message) { $res.message } else { 'signed in to the Mimecast Administration Console' }
        $actions.Add($msg)
        return [pscustomobject]@{ System = 'mimecast-console-setup'; Status = 'ok'; Actions = $actions.ToArray() }
    }
    $err = if ($res.error) { $res.error } else { 'unknown error' }
    $ev  = if ($res.evidence) { " (screenshot: $($res.evidence))" } else { '' }
    # THROW (fail the job) so the app's sign-in test reads as failed, with the error + screenshot path.
    throw "Mimecast console sign-in failed — $err$ev"
}

Export-ModuleMember -Function Connect-CtgMimecast, Invoke-CtgMimecastApi, Get-CtgMimecastProfile, Find-CtgMimecastGroup, Invoke-CtgMimecastOnboarding, Invoke-CtgMimecastOffboarding, Confirm-CtgMimecast, Resolve-CtgMimecastConsoleLogin, Invoke-CtgMimecastConsoleSetup
