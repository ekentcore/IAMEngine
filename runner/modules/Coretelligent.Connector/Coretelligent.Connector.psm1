#Requires -Version 7.0

# Coretelligent.Connector  (low-code connectors — docs/CONNECTOR_BUILDER.md)
# Generic executor for DECLARATIVE http connectors. The app injects the published definition into the
# job as config.connector = { kind, definition }; this module interprets it: resolves {{templates}},
# runs each lane step's HTTP operation, checks expectations, extracts vars, and returns the same
# result shape as a hand-written module. The definition is DATA authored in the app's builder UI —
# nothing here ever evaluates definition content as code.
#
# Security invariants (mirrors web/lib/connectors/definition.ts — keep the two easy to diff):
#   - HOST ALLOWLIST: every RESOLVED request URL must target a host in definition.hosts. A template
#     cannot redirect a brokered secret elsewhere; violations throw before any bytes leave.
#   - REDACTION: every brokered secret field value is scrubbed from every error/action line.
#   - FAIL CLOSED: unknown auth types, unknown template roots, unresolvable placeholders, and
#     non-https URLs all throw rather than degrade.

Set-StrictMode -Version Latest

# OAuth2 client-credentials tokens, cached per tokenUrl|clientId for this process (re-minted on expiry).
$script:ConnectorTokens = @{}
# Secret values to scrub from anything a human might see (set by Initialize-CtgConnectorContext).
$script:ConnectorRedactions = @()
# Harvested browser-session auth headers, cached per secretName for the CURRENT job so a hybrid
# connector signs in ONCE, not once per operation. Reset per job in Initialize-CtgConnectorContext —
# a session must never leak from one client's job into another on the fleet-wide runner.
$script:ConnectorSessions = @{}

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

function Hide-CtgConnectorSecrets {
    # Scrub every registered secret value from $Text. Values ≥4 chars only — redacting "1" would
    # shred innocent text; a 1–3 char "secret" is not a secret.
    param([string]$Text)
    if (-not $Text) { return $Text }
    foreach ($v in $script:ConnectorRedactions) {
        if ($v -and $v.Length -ge 4) { $Text = $Text.Replace($v, '***') }
    }
    return $Text
}

function Get-CtgConnectorPath {
    # Resolve a dotted path ("results.0.id") against an object; numeric segments index arrays.
    # Returns $null when any hop is absent — path resolution is how CONDITIONS test absence, so
    # this function never throws.
    param($Object, [Parameter(Mandatory)][string]$Path)
    $cur = $Object
    foreach ($seg in $Path.Split('.')) {
        if ($null -eq $cur) { return $null }
        if ($seg -match '^\d+$') {
            $ix = [int]$seg
            $arr = @($cur)
            if ($ix -ge $arr.Count) { return $null }
            $cur = $arr[$ix]
        }
        else { $cur = Get-CtgProp $cur $seg }
    }
    return $cur
}

function Resolve-CtgConnectorTemplate {
    # Replace every {{ root.path }} in $Text from $Context. Unresolvable placeholders THROW —
    # a silently-empty substitution could turn "/users/{{vars.userId}}/deactivate" into a call
    # that hits the wrong resource. $AllowMissing returns $null instead (used by conditions).
    param([string]$Text, [Parameter(Mandatory)][hashtable]$Context)
    if ($null -eq $Text) { return $null }
    $pattern = [regex]'\{\{\s*([^}]+?)\s*\}\}'
    return $pattern.Replace($Text, {
        param($m)
        $path = $m.Groups[1].Value
        $val = Get-CtgConnectorPath $Context $path
        if ($null -eq $val) { throw "template {{$path}} did not resolve — the case payload/config/secret has no value there" }
        [string]$val
    })
}

function Resolve-CtgConnectorValue {
    # Deep-resolve templates in a structured body: strings are template-resolved IN PLACE (a value
    # can't break out of its JSON string), objects/arrays recurse, everything else passes through.
    param($Value, [Parameter(Mandatory)][hashtable]$Context)
    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) { return Resolve-CtgConnectorTemplate $Value $Context }
    if ($Value -is [System.Collections.IDictionary]) {
        $out = [ordered]@{}
        foreach ($k in $Value.Keys) { $out[$k] = Resolve-CtgConnectorValue $Value[$k] $Context }
        return $out
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { Resolve-CtgConnectorValue $_ $Context })
    }
    if ($Value -is [pscustomobject]) {
        $out = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $out[$p.Name] = Resolve-CtgConnectorValue $p.Value $Context }
        return $out
    }
    return $Value
}

function Test-CtgConnectorCondition {
    # Dotted-path truthiness with optional leading "!". Absent → false; empty string/0/$false → false.
    param([string]$Condition, [Parameter(Mandatory)][hashtable]$Context)
    if (-not $Condition) { return $true }
    $negate = $Condition.StartsWith('!')
    $path = if ($negate) { $Condition.Substring(1) } else { $Condition }
    $val = Get-CtgConnectorPath $Context $path
    $truthy = $null -ne $val -and $val -ne '' -and $val -ne $false -and $val -ne 0
    if ($negate) { return -not $truthy }
    return $truthy
}

function Invoke-CtgConnectorApi {
    # Single HTTP seam (mocked in tests). -SkipHttpErrorCheck so vendor 4xx/5xx come back as data —
    # `expect` decides what's an error, with the status + a redacted body snippet in the message.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [hashtable]$Headers,
        $Body,
        [int]$TimeoutSec = 60
    )
    # -MaximumRedirection 0: the host allowlist is checked on the REQUEST url only, so following a 3xx
    # would let an allowlisted host bounce the request — and a 'header'-type auth secret travels with
    # it (.NET only strips Authorization cross-origin) — to a host the admin never declared. With
    # SkipHttpErrorCheck a 3xx comes back as data; `expect` then treats an unexpected redirect as a
    # failure rather than silently chasing it off the allowlist.
    $p = @{ Method = $Method; Uri = $Uri; SkipHttpErrorCheck = $true; MaximumRedirection = 0; TimeoutSec = $TimeoutSec }
    if ($Headers -and $Headers.Count -gt 0) { $p.Headers = $Headers }
    if ($null -ne $Body -and $Method -notin @('GET', 'HEAD')) {
        $p.Body = ($Body | ConvertTo-Json -Depth 16)
        $p.ContentType = 'application/json'
    }
    $resp = Invoke-WebRequest @p
    $parsed = $null
    $raw = [string]$resp.Content
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null } }
    return @{ Status = [int]$resp.StatusCode; Body = $parsed; Raw = $raw }
}

function Get-CtgConnectorOAuthToken {
    # client-credentials grant: client_id/client_secret from the brokered secret's username/password.
    param($Auth, $Secret, [hashtable]$Context, $Definition)
    $tokenUrl = [string](Get-CtgProp $Auth 'tokenUrl')
    # The tokenUrl receives the brokered client secret — so it MUST clear the same host allowlist as
    # every operation, or a hand-edited/typo'd tokenUrl would exfiltrate the credential to a host the
    # admin never declared. This is the invariant the module header promises.
    Assert-CtgConnectorHost -Uri $tokenUrl -Definition $Definition
    # Get-CtgProp (not $Secret.Username): StrictMode throws on a missing hashtable key via dot-access,
    # which would mask the crafted "no username field" diagnostic below.
    $clientId = [string](Get-CtgProp $Secret 'username')
    if (-not $clientId) { throw "the connector secret has no username field to use as the OAuth client_id" }
    $key = "$tokenUrl|$clientId"
    $cached = $script:ConnectorTokens[$key]
    if ($cached -and $cached.expiresAt -gt (Get-Date).AddSeconds(60)) {
        # Re-register for redaction: Initialize-CtgConnectorContext wipes ConnectorRedactions per job,
        # so a token minted on a PRIOR job would otherwise return here unredacted and could leak in a
        # later job's error snippet.
        $script:ConnectorRedactions += [string]$cached.token
        return $cached.token
    }
    $clientSecret = [string](Get-CtgProp $Secret 'password')
    if (-not $clientSecret) { throw "the connector secret has no password field to use as the OAuth client_secret" }
    $form = @{ grant_type = 'client_credentials'; client_id = $clientId; client_secret = $clientSecret }
    $scope = Get-CtgProp $Auth 'scope'
    if ($scope) { $form.scope = [string]$scope }
    # MaximumRedirection 0 for the same reason as the API seam — never chase a 3xx off the allowlist.
    $resp = Invoke-WebRequest -Method POST -Uri $tokenUrl -Body $form -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 60
    $tok = $null
    try { $tok = $resp.Content | ConvertFrom-Json } catch { }
    $access = if ($tok) { Get-CtgProp $tok 'access_token' } else { $null }
    if ([int]$resp.StatusCode -ge 300 -or -not $access) {
        throw "OAuth token request to $tokenUrl failed (HTTP $([int]$resp.StatusCode)) — check the wired client id/secret"
    }
    $ttl = [int]((Get-CtgProp $tok 'expires_in') ?? 300)
    $script:ConnectorTokens[$key] = @{ token = [string]$access; expiresAt = (Get-Date).AddSeconds($ttl) }
    $script:ConnectorRedactions += [string]$access
    return [string]$access
}

function Get-CtgConnectorBrowserSession {
    # browser-session (hybrid) auth: sign in to the portal in a headless browser (connector-login
    # flow), harvest the session (cookie set or storage token), and turn it into the header(s) that
    # authenticate the http operations. Signs in ONCE per job — the result is cached per secretName in
    # $script:ConnectorSessions and reused for every operation. Returns a headers hashtable.
    param($Definition, $Auth, [hashtable]$Context)
    $secretName = [string](Get-CtgProp $Auth 'secretName')
    if (-not $secretName) { throw "browser-session auth needs a secretName (the portal login secret)" }
    if ($script:ConnectorSessions.ContainsKey($secretName)) { return $script:ConnectorSessions[$secretName] }

    $entry = Get-CtgProp $Context.secret $secretName
    if (-not $entry) { throw "the job did not broker the '$secretName' secret this connector's browser login needs — wire it on the client system" }
    $username = [string](Get-CtgProp $entry 'username')
    $password = [string](Get-CtgProp $entry 'password')
    # A TOTP seed field on the secret (any of the usual names) lets a `totp` login step clear MFA.
    $seed = $null
    foreach ($k in @('TOTP', 'TotpSeed', 'AuthenticatorSeed', 'MFASeed', 'OTPSeed', 'Seed')) {
        $v = Get-CtgProp $entry $k
        if ($v) { $seed = [string]$v; break }
    }

    # The login flow needs the hosts allowlist + the login steps + the harvest spec. Pass the case
    # context through so {{user.*}} etc. resolve in login steps, mirroring the browser lane.
    $loginDef = @{
        hosts   = @(Get-CtgProp $Definition 'hosts')
        login   = Get-CtgProp $Auth 'login'
        harvest = Get-CtgProp $Auth 'harvest'
    }
    $params = @{ definition = $loginDef; user = $Context.payload; config = $Context.config; client = $Context.client }
    if ($seed) { $params.totpSeed = $seed }
    if ($env:CTG_CONNECTOR_ALLOW_ANY_ORIGIN -eq '1') { $params.allowAnyOrigin = $true }

    $r = Invoke-CtgBrowserFlow -Flow 'connector-login' -InputObject @{ username = $username; password = $password; params = $params }
    if (-not $r.ok) { throw (Hide-CtgConnectorSecrets ("browser-session login failed: " + [string]$r.error)) }
    $session = $r.session
    if (-not $session) { throw "browser-session login returned no session material" }

    # Build the auth header(s) from the harvested session per auth.apply, and register every harvested
    # value for redaction BEFORE it can appear anywhere.
    $apply = Get-CtgProp $Auth 'apply'
    $as = [string](Get-CtgProp $apply 'as')
    $cookies = Get-CtgProp $session 'cookies'
    $token = [string](Get-CtgProp $session 'token')
    $headers = @{}
    $reg = [System.Collections.Generic.List[string]]::new()

    if ($as -eq 'cookie') {
        if (-not $cookies) { throw "apply.as='cookie' but the login harvested no cookies" }
        $names = if ($cookies -is [System.Collections.IDictionary]) { @($cookies.Keys) } else { @($cookies.PSObject.Properties.Name) }
        $pairs = foreach ($n in $names) { $val = [string](Get-CtgProp $cookies $n); $reg.Add($val); "$n=$val" }
        $headers['Cookie'] = ($pairs -join '; ')
    }
    else {
        # bearer / header send ONE token: the storage token, or the single harvested cookie's value.
        $one = $token
        if (-not $one -and $cookies) {
            $names = if ($cookies -is [System.Collections.IDictionary]) { @($cookies.Keys) } else { @($cookies.PSObject.Properties.Name) }
            if (@($names).Count -eq 1) { $one = [string](Get-CtgProp $cookies $names[0]) }
        }
        if (-not $one) { throw "apply.as='$as' needs a single token — harvest a storageKey or exactly one cookie" }
        $reg.Add($one)
        if ($as -eq 'bearer') { $headers['Authorization'] = "Bearer $one" }
        elseif ($as -eq 'header') {
            $hn = [string](Get-CtgProp $apply 'header')
            if (-not $hn) { throw "apply.as='header' needs apply.header" }
            $headers[$hn] = $one
        }
        else { throw "unknown apply.as '$as'" }
    }
    $script:ConnectorRedactions = @($script:ConnectorRedactions + $reg.ToArray() | Where-Object { $_ } | Select-Object -Unique)
    $script:ConnectorSessions[$secretName] = $headers
    return $headers
}

function Get-CtgConnectorAuthHeaders {
    # Headers that authenticate every operation, from definition.auth + the brokered secret.
    param($Definition, [hashtable]$Context)
    $auth = Get-CtgProp $Definition 'auth'
    $type = [string](Get-CtgProp $auth 'type')
    if (-not $type -or $type -eq 'none') { return @{} }
    # browser-session resolves through a headless login rather than a static field — handle it before
    # the field-based branches (it has login/harvest/apply, not a token in the secret).
    if ($type -eq 'browser-session') { return Get-CtgConnectorBrowserSession -Definition $Definition -Auth $auth -Context $Context }
    $secretName = [string](Get-CtgProp $auth 'secretName')
    $secretMap = $Context.secret
    $secret = if ($secretName) { Get-CtgProp $secretMap $secretName } else { $null }
    if (-not $secret) { throw "the job did not broker the '$secretName' secret this connector's auth needs — wire it on the client system" }
    # Get-CtgProp everywhere below (never $secret.Password): the secret entry is a hashtable, and
    # StrictMode throws on a missing key via dot-access — which would mask the actionable diagnostics.
    switch ($type) {
        'bearer' {
            $token = [string](Get-CtgProp $secret 'password')
            if (-not $token) { throw "the '$secretName' secret has no password field to use as the bearer token" }
            return @{ Authorization = "Bearer $token" }
        }
        'basic' {
            $user = [string](Get-CtgProp $secret 'username')
            $pass = [string](Get-CtgProp $secret 'password')
            if (-not $user -or -not $pass) { throw "the '$secretName' secret needs username + password fields for basic auth" }
            $b64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("${user}:${pass}"))
            return @{ Authorization = "Basic $b64" }
        }
        'header' {
            $header = [string](Get-CtgProp $auth 'header')
            $tpl = [string](Get-CtgProp $auth 'valueTemplate')
            if (-not $header -or -not $tpl) { throw "auth type 'header' needs auth.header and auth.valueTemplate" }
            return @{ $header = (Resolve-CtgConnectorTemplate $tpl $Context) }
        }
        'oauth2-client-credentials' {
            $token = Get-CtgConnectorOAuthToken -Auth $auth -Secret $secret -Context $Context -Definition $Definition
            return @{ Authorization = "Bearer $token" }
        }
        default { throw "unknown auth type '$type' — the definition predates this runner or was hand-edited; re-publish it" }
    }
}

function Assert-CtgConnectorHost {
    # The allowlist that makes template injection useless: whatever the resolved URL says, its host
    # must be one the ADMIN declared at publish time.
    param([Parameter(Mandatory)][string]$Uri, $Definition)
    $u = [uri]$Uri
    if ($u.Scheme -ne 'https') { throw "connector requests must be https (got $($u.Scheme)://$($u.Host))" }
    $hosts = @(Get-CtgProp $Definition 'hosts') | ForEach-Object { ([string]$_).ToLower() }
    if ($hosts -notcontains $u.Host.ToLower()) {
        throw "request host '$($u.Host)' is not in the connector's host allowlist ($($hosts -join ', ')) — refusing to send anything there"
    }
}

function Invoke-CtgConnectorOperation {
    # Run one named operation: resolve the request, enforce the allowlist, call the seam, check
    # `expect`, apply `extract` into $Context.vars. Returns a human action line.
    param($Definition, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][hashtable]$Context)
    $op = Get-CtgProp (Get-CtgProp $Definition 'operations') $Name
    if (-not $op) { throw "the definition has no operation '$Name'" }
    $reqSpec = Get-CtgProp $op 'request'
    $method = [string](Get-CtgProp $reqSpec 'method')
    $path = Resolve-CtgConnectorTemplate ([string](Get-CtgProp $reqSpec 'path')) $Context
    $uri = if ($path -match '^https://') { $path } else { ([string](Get-CtgProp $Definition 'baseUrl')).TrimEnd('/') + '/' + $path.TrimStart('/') }
    Assert-CtgConnectorHost -Uri $uri -Definition $Definition

    $headers = @{ Accept = 'application/json' }
    foreach ($h in @((Get-CtgProp (Get-CtgProp $Definition 'defaults') 'headers'), (Get-CtgProp $reqSpec 'headers'))) {
        if ($null -eq $h) { continue }
        $names = if ($h -is [System.Collections.IDictionary]) { @($h.Keys) } else { @($h.PSObject.Properties.Name) }
        foreach ($n in $names) { $headers[$n] = Resolve-CtgConnectorTemplate ([string](Get-CtgProp $h $n)) $Context }
    }
    $authHeaders = Get-CtgConnectorAuthHeaders -Definition $Definition -Context $Context
    foreach ($k in $authHeaders.Keys) { $headers[$k] = $authHeaders[$k] }

    $body = Resolve-CtgConnectorValue (Get-CtgProp $reqSpec 'body') $Context
    $resp = Invoke-CtgConnectorApi -Method $method -Uri $uri -Headers $headers -Body $body

    # `expect`: allowed statuses (default: any 2xx), then optional body checks.
    $expect = Get-CtgProp $op 'expect'
    # Filter out $null: @(Get-CtgProp $expect 'status') on an ABSENT status is @($null) whose Count is
    # 1 — that made the "default: any 2xx" branch unreachable, so every op with no explicit
    # expect.status threw on a perfectly good 200. Keep only real status codes.
    $allowed = @(Get-CtgProp $expect 'status') | Where-Object { $null -ne $_ }
    $statusOk = if (@($allowed).Count -gt 0) { @($allowed) -contains $resp.Status } else { $resp.Status -ge 200 -and $resp.Status -lt 300 }
    # The action/error line shows the URL with query REDACTED — queries routinely carry emails, and
    # a template could put a secret there.
    $shownUri = ($uri -split '\?')[0]
    if (-not $statusOk) {
        $snippet = if ($resp.Raw) { $s = ([string]$resp.Raw).Trim(); if ($s.Length -gt 300) { $s.Substring(0, 300) + '…' } else { $s } } else { '' }
        throw (Hide-CtgConnectorSecrets "operation '$Name': $method $shownUri -> HTTP $($resp.Status)$(if ($snippet) { " — $snippet" })")
    }
    if ($expect) {
        $checkPath = Get-CtgProp $expect 'path'
        if ($checkPath) {
            $val = Get-CtgConnectorPath $resp.Body ([string]$checkPath)
            $wantExists = Get-CtgProp $expect 'exists'
            $wantEquals = Get-CtgProp $expect 'equals'
            if ($null -ne $wantExists -and [bool]$wantExists -ne ($null -ne $val)) {
                throw (Hide-CtgConnectorSecrets "operation '$Name': expected response.$checkPath to $(if ([bool]$wantExists) { 'exist' } else { 'be absent' }) and it $(if ($null -ne $val) { 'exists' } else { 'does not' })")
            }
            if ($null -ne $wantEquals -and [string]$val -ne [string]$wantEquals) {
                throw (Hide-CtgConnectorSecrets "operation '$Name': expected response.$checkPath = '$wantEquals', got '$val'")
            }
        }
    }
    $extract = Get-CtgProp $op 'extract'
    if ($extract) {
        $names = if ($extract -is [System.Collections.IDictionary]) { @($extract.Keys) } else { @($extract.PSObject.Properties.Name) }
        foreach ($n in $names) {
            $Context.vars[$n] = Get-CtgConnectorPath $resp.Body ([string](Get-CtgProp $extract $n))
        }
    }
    # Redact even the SUCCESS line: a vendor that carries the API key in the URL PATH (Telegram-style
    # /bot{{secret…}}/…) would otherwise leak it here — stripping only the query (above) doesn't cover
    # the path. This line flows into the job result, run report, and ServiceNow work note.
    return (Hide-CtgConnectorSecrets "${Name}: $method $shownUri -> HTTP $($resp.Status)")
}

function Invoke-CtgConnectorLane {
    # Run a lane's steps in order. `when`/`skipWhen` gate, `warnWhen` adds a WARN action line (a
    # human must answer — run-report convention), `failWhen` throws, `optional` demotes a step's
    # failure to a WARN. Returns the action-line array.
    param($Definition, [Parameter(Mandatory)][string]$Lane, [Parameter(Mandatory)][hashtable]$Context)
    $steps = Get-CtgProp (Get-CtgProp $Definition 'lanes') $Lane
    if ($null -eq $steps) { throw "this connector defines no '$Lane' lane" }
    $actions = [System.Collections.Generic.List[string]]::new()
    foreach ($step in @($steps)) {
        $msg = [string](Get-CtgProp $step 'message')
        $warnWhen = [string](Get-CtgProp $step 'warnWhen')
        if ($warnWhen -and (Test-CtgConnectorCondition $warnWhen $Context)) {
            # Redact: a warnWhen message template can resolve a secret field, and this line reaches the
            # run report / work note.
            $actions.Add((Hide-CtgConnectorSecrets "WARN $(if ($msg) { Resolve-CtgConnectorTemplate $msg $Context } else { "condition '$warnWhen' holds" })"))
        }
        $failWhen = [string](Get-CtgProp $step 'failWhen')
        if ($failWhen -and (Test-CtgConnectorCondition $failWhen $Context)) {
            throw (Hide-CtgConnectorSecrets "$(if ($msg) { Resolve-CtgConnectorTemplate $msg $Context } else { "condition '$failWhen' holds" })")
        }
        $opName = [string](Get-CtgProp $step 'op')
        if (-not $opName) { continue }  # assertion-only step
        $when = [string](Get-CtgProp $step 'when')
        if ($when -and -not (Test-CtgConnectorCondition $when $Context)) { $actions.Add("$opName skipped (when: $when)"); continue }
        $skipWhen = [string](Get-CtgProp $step 'skipWhen')
        if ($skipWhen -and (Test-CtgConnectorCondition $skipWhen $Context)) { $actions.Add("$opName skipped (skipWhen: $skipWhen)"); continue }
        try {
            $actions.Add((Invoke-CtgConnectorOperation -Definition $Definition -Name $opName -Context $Context))
        }
        catch {
            if (Get-CtgProp $step 'optional') { $actions.Add((Hide-CtgConnectorSecrets "WARN optional step '$opName' failed: $($_.Exception.Message)")) }
            else { throw }
        }
    }
    return $actions.ToArray()
}

function Initialize-CtgConnectorContext {
    # Build the template context and register every secret field value for redaction. The secret
    # map exposes each brokered credential's Fields plus username/password conveniences.
    param($User, $Config, $Credentials, $Client, $Definition)
    $secretMap = @{}
    $redact = [System.Collections.Generic.List[string]]::new()
    if ($Credentials) {
        foreach ($name in @($Credentials.Keys)) {
            $c = $Credentials[$name]
            if (-not $c) { continue }
            $entry = @{}
            $fields = Get-CtgProp $c 'Fields'
            if ($fields) { foreach ($k in @($fields.Keys)) { $entry[$k] = $fields[$k]; if ($fields[$k]) { $redact.Add([string]$fields[$k]) } } }
            if ($c.Username) { $entry['username'] = [string]$c.Username }
            if ($c.Password) {
                $plain = [System.Net.NetworkCredential]::new('', $c.Password).Password
                $entry['password'] = $plain
                if ($plain) { $redact.Add($plain) }
            }
            $secretMap[$name] = $entry
        }
    }
    $script:ConnectorRedactions = @($redact | Select-Object -Unique)
    # New job → no carried-over browser session. On the fleet-wide runner this is what stops one
    # client's harvested cookie from authenticating the next client's http operations.
    $script:ConnectorSessions = @{}
    # config WITHOUT the injected definition — {{config.x}} means the per-client lane settings.
    $cfg = @{}
    if ($Config) {
        $props = if ($Config -is [System.Collections.IDictionary]) { $Config.Keys } else { $Config.PSObject.Properties.Name }
        foreach ($k in @($props)) { if ($k -ne 'connector') { $cfg[$k] = Get-CtgProp $Config $k } }
    }
    return @{
        user    = $User
        payload = $User
        config  = [pscustomobject]$cfg
        client  = $Client
        secret  = $secretMap
        vars    = @{}
        def     = $Definition
    }
}

function Get-CtgConnectorDefinition {
    # The claim-time injection: config.connector = { kind, definition }. Its absence means the app
    # has no PUBLISHED connector for this systemKey — say exactly that.
    param($Config, [string]$ExpectKind = 'http')
    $conn = Get-CtgProp $Config 'connector'
    $def = Get-CtgProp $conn 'definition'
    if (-not $def) {
        throw "this job carries no connector definition — the connector for this system is not published (drafts/archived connectors never run). Publish it in /connectors and re-run."
    }
    $kind = [string](Get-CtgProp $conn 'kind')
    if ($kind -ne $ExpectKind) { throw "this connector is kind '$kind' — the $ExpectKind executor can't run it" }
    # Runner-side re-validation of the load-bearing invariants (the app validates fully on save).
    if (-not (Get-CtgProp $def 'baseUrl') -or @(Get-CtgProp $def 'hosts').Count -eq 0) {
        throw "the connector definition is missing baseUrl/hosts — refusing to run without a host allowlist"
    }
    return $def
}

function Invoke-CtgConnectorOnboarding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$User,
        [Parameter(Mandatory)][AllowNull()]$Config,
        $Credentials,
        $Client,
        [string]$SystemKey = 'connector'
    )
    $def = Get-CtgConnectorDefinition $Config
    $ctx = Initialize-CtgConnectorContext $User $Config $Credentials $Client $def
    $actions = Invoke-CtgConnectorLane -Definition $def -Lane 'onboard' -Context $ctx
    [pscustomobject]@{ System = $SystemKey; Status = 'ok'; Actions = $actions }
}

function Invoke-CtgConnectorOffboarding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$User,
        [Parameter(Mandatory)][AllowNull()]$Config,
        $Credentials,
        $Client,
        [string]$SystemKey = 'connector'
    )
    $def = Get-CtgConnectorDefinition $Config
    $ctx = Initialize-CtgConnectorContext $User $Config $Credentials $Client $def
    $actions = Invoke-CtgConnectorLane -Definition $def -Lane 'offboard' -Context $ctx
    [pscustomobject]@{ System = $SystemKey; Status = 'ok'; Actions = $actions }
}

function Invoke-CtgConnectorBrowserLane {
    # Run a browser-kind connector's lane through the generic connector-steps flow (the same Node/
    # Playwright bridge the spanning force-sync uses). Builds the flow input from the job: the portal
    # secret (credentials.secretName) supplies {{secret.username/password}}, the case payload supplies
    # {{user.*}}, and an optional TOTP seed field on the secret feeds `totp` steps. Returns the standard
    # module result; a browser failure becomes Status=failed with the sidecar's message (never a secret).
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Job,
        [Parameter(Mandatory)][hashtable]$Creds,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard', 'test')][string]$Lane
    )
    $def = Get-CtgConnectorDefinition $Job.config -ExpectKind 'browser'
    $lanes = Get-CtgProp $def 'lanes'
    if (-not (Get-CtgProp $lanes $Lane)) { throw "this connector defines no '$Lane' browser lane" }

    $secretName = [string](Get-CtgProp (Get-CtgProp $def 'credentials') 'secretName')
    $secret = if ($secretName) { $Creds[$secretName] } else { $null }
    if (-not $secret) { throw "the job did not broker the '$secretName' secret this browser connector needs — wire it on the client system" }
    $username = [string]$secret.Username
    $password = if ($secret.Password) { [System.Net.NetworkCredential]::new('', $secret.Password).Password } else { '' }
    # A TOTP seed field on the secret (any of the usual names) lets a `totp` step clear an app-code MFA.
    $seed = $null
    if ($secret.Fields) {
        foreach ($k in @('TOTP', 'TotpSeed', 'AuthenticatorSeed', 'MFASeed', 'OTPSeed', 'Seed')) {
            if ($secret.Fields.ContainsKey($k) -and $secret.Fields[$k]) { $seed = [string]$secret.Fields[$k]; break }
        }
    }

    $params = @{
        definition = $def
        lane       = $Lane
        user       = $Job.payload
        config     = (Get-CtgProp $Job.config $Lane)
        client     = $Job.client
    }
    if ($seed) { $params.totpSeed = $seed }
    if ($env:CTG_CONNECTOR_ALLOW_ANY_ORIGIN -eq '1') { $params.allowAnyOrigin = $true }

    # Register THIS browser connector's own secrets for redaction. The http path populates
    # $script:ConnectorRedactions via Initialize-CtgConnectorContext, but the browser lane never builds
    # that context — so without this, Hide-CtgConnectorSecrets below would scrub against an empty set
    # (or, on the fleet-wide runner, a previous http job's secrets), leaving this portal's
    # username/password/TOTP seed unredacted if the sidecar ever surfaced one.
    $script:ConnectorRedactions = @($username, $password, $seed) | Where-Object { $_ }

    $flowInput = @{ username = $username; password = $password; params = $params }
    $r = Invoke-CtgBrowserFlow -Flow 'connector-steps' -InputObject $flowInput
    $actions = [System.Collections.Generic.List[string]]::new()
    if ($r.message) { $actions.Add((Hide-CtgConnectorSecrets ([string]$r.message))) }
    if (-not $r.ok) {
        $msg = if ($r.error) { Hide-CtgConnectorSecrets ([string]$r.error) } else { 'browser step failed' }
        throw $msg
    }
    $out = [pscustomobject]@{ System = [string]$Job.systemKey; Status = 'ok'; Actions = $actions.ToArray() }
    if ($r.evidence) { $out | Add-Member -NotePropertyName Evidence -NotePropertyValue ([string]$r.evidence) }
    $out
}

function Test-CtgConnectorConnection {
    # Connection-test probe: run the definition's `test` lane (typically one cheap read). No test
    # lane is an honest "unverifiable", not a pass. Kind-aware — the claim injects both http and
    # browser definitions, so read the kind here rather than defaulting to http (which would throw a
    # kind-mismatch for every browser connector).
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowNull()]$Config,
        $Credentials,
        $Client
    )
    $kind = [string](Get-CtgProp (Get-CtgProp $Config 'connector') 'kind')
    if ($kind -eq 'browser') {
        # A standalone browser probe would fire a real headless portal login on every sweep — exactly
        # what we avoid elsewhere. The access stage already proved the portal secret resolves; the
        # login itself is exercised when the lane runs. Report that honestly rather than false-fail.
        return @{ ok = $true; detail = 'browser connector — portal credential resolved; the sign-in is exercised when a lane runs (no standalone browser probe on the sweep)' }
    }
    $def = Get-CtgConnectorDefinition $Config
    # A browser-session (hybrid) http connector's test lane would trigger a real headless portal login,
    # same as a browser connector — so don't run it on the sweep. The access stage proved the portal
    # secret resolves; the sign-in is exercised when a lane runs.
    if ([string](Get-CtgProp (Get-CtgProp $def 'auth') 'type') -eq 'browser-session') {
        return @{ ok = $true; detail = 'browser-session connector — portal credential resolved; the sign-in is exercised when a lane runs (no standalone browser login on the sweep)' }
    }
    $lanes = Get-CtgProp $def 'lanes'
    if (-not (Get-CtgProp $lanes 'test')) {
        return @{ ok = $false; detail = "this connector defines no 'test' lane — add one (a single read operation) so access can be verified" }
    }
    $ctx = Initialize-CtgConnectorContext ([pscustomobject]@{}) $Config $Credentials $Client $def
    try {
        $actions = Invoke-CtgConnectorLane -Definition $def -Lane 'test' -Context $ctx
        return @{ ok = $true; detail = ($actions -join '; ') }
    }
    catch {
        return @{ ok = $false; detail = (Hide-CtgConnectorSecrets $_.Exception.Message) }
    }
}

Export-ModuleMember -Function @(
    'Get-CtgConnectorPath', 'Resolve-CtgConnectorTemplate', 'Resolve-CtgConnectorValue',
    'Test-CtgConnectorCondition', 'Invoke-CtgConnectorApi', 'Get-CtgConnectorAuthHeaders',
    'Get-CtgConnectorBrowserSession',
    'Assert-CtgConnectorHost', 'Invoke-CtgConnectorOperation', 'Invoke-CtgConnectorLane',
    'Initialize-CtgConnectorContext', 'Get-CtgConnectorDefinition',
    'Invoke-CtgConnectorOnboarding', 'Invoke-CtgConnectorOffboarding', 'Test-CtgConnectorConnection',
    'Invoke-CtgConnectorBrowserLane',
    'Hide-CtgConnectorSecrets'
)
