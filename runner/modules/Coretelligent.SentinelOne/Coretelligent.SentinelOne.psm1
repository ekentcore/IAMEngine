#Requires -Version 7.0

# Coretelligent.SentinelOne  (SentinelOne endpoint protection — agent containment on offboard)
# Offboarding a departed user's machine: NETWORK-ISOLATE the endpoint (so it can't exfiltrate or be
# used) and, only when explicitly asked, SHUT IT DOWN. Onboarding is a no-op here — the S1 agent is
# deployed by MSI/RMM, not provisioned per user.
#
# DECISIONS (from the offboarding plan review):
#   - Isolate (network quarantine) is the DEFAULT and is reversible (connect re-enables the network).
#   - Shutdown is OFF unless config.shutdown is set: it's irreversible-for-the-session and only
#     matters once the box is already isolated, so it's opt-in + gated behind approval in the app.
#   - The machine is resolved from the user/job (Entra-device name carried on the payload/config),
#     NOT guessed: if we can't resolve exactly one agent, we DON'T act — we surface a clear note so an
#     operator picks the machine. A confident-but-wrong match would isolate/kill the wrong endpoint.
#
# API (SentinelOne management API v2.1):
#   Base URL : the tenant management console, e.g. https://usea1-partners.sentinelone.net
#   Auth     : header  Authorization: ApiToken <token>   (a service-user API token)
#   Find     : GET  /web/api/v2.1/agents?computerName={name}  -> { data: [ { id, computerName,
#              networkStatus: 'connected'|'disconnecting'|'disconnected', isActive, ... } ], pagination }
#   Isolate  : POST /web/api/v2.1/agents/actions/disconnect  { filter: { ids: [id] } }  (network quarantine)
#   Reconnect: POST /web/api/v2.1/agents/actions/connect     { filter: { ids: [id] } }
#   Shutdown : POST /web/api/v2.1/agents/actions/shutdown    { filter: { ids: [id] } }
# disconnect/connect/shutdown are idempotent server-side; we still read networkStatus first so the
# run report says "already isolated" instead of issuing a redundant action.

Set-StrictMode -Version Latest

$script:S1ApiUrl = $null
$script:S1Token  = $null

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

function Connect-CtgSentinelOne {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,   # the management console URL (host, with or without scheme)
        [Parameter(Mandatory)][string]$Token      # the API token (service user)
    )
    $u = $BaseUrl.Trim().TrimEnd('/')
    if ($u -notmatch '^https?://') { $u = "https://$u" }
    $script:S1ApiUrl = $u
    $script:S1Token  = $Token
}

function Invoke-CtgSentinelOneApi {
    # Single HTTP seam (mocked in tests). Auth: ApiToken header. Never logs the token.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:S1Token) { throw "Call Connect-CtgSentinelOne first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:S1ApiUrl$Path"
        Headers     = @{ Authorization = "ApiToken $script:S1Token"; Accept = 'application/json' }
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
        throw "SentinelOne API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

function Resolve-CtgS1MachineName {
    # The endpoint to act on. Prefer an explicit config value, then the device name carried on the
    # user payload (the M365/Entra step resolves the registered device and rides it on the case).
    param($User, $Config)
    foreach ($v in @(
            (Get-CtgProp $Config 'machineName'), (Get-CtgProp $Config 'computerName'),
            (Get-CtgProp $User 'computerName'), (Get-CtgProp $User 'deviceName'),
            (Get-CtgProp $User 'machineName'), (Get-CtgProp $User 'EntraDeviceName')
        )) {
        if ($v) { return [string]$v }
    }
    return $null
}

function Find-CtgS1Agents {
    # All agents matching a computer name (case-insensitive exact match on computerName). Returns an
    # array (possibly empty / many — the caller decides whether the match is unambiguous).
    param([Parameter(Mandatory)][string]$ComputerName)
    $resp = Invoke-CtgSentinelOneApi -Method GET -Path "/web/api/v2.1/agents?computerName=$([uri]::EscapeDataString($ComputerName))"
    $data = Get-CtgProp $resp 'data'
    if ($null -eq $data) { $data = $resp }
    $needle = $ComputerName.ToLower()
    @(@($data) | Where-Object { ([string](Get-CtgProp $_ 'computerName')).ToLower() -eq $needle })
}

function Test-CtgS1Isolated {
    # networkStatus 'disconnected' (or mid-flight 'disconnecting') = already quarantined.
    param($Agent)
    $s = ([string](Get-CtgProp $Agent 'networkStatus')).ToLower()
    $s -eq 'disconnected' -or $s -eq 'disconnecting'
}

function Invoke-CtgSentinelOneOnboarding {
    <#
    .SYNOPSIS
        No-op: the SentinelOne agent is deployed by MSI/RMM, not provisioned per user. Records that
        nothing is done so the step is visible in the run report rather than silently absent.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $actions.Add("SentinelOne onboarding is handled by MSI/RMM agent deployment — nothing to do per user")
    [pscustomobject]@{ System = 'sentinelone'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Invoke-CtgSentinelOneOffboarding {
    <#
    .SYNOPSIS
        Network-isolate EVERY one of the departed user's endpoints (default), and shut each down only
        when config.shutdown is set. Idempotent — skips machines already isolated. Per machine, if it
        can't be resolved to exactly one agent, takes NO action on it and says why (an operator picks).
    .PARAMETER Machines
        The machine names to contain — normally the user's Entra device names, resolved upstream and
        passed in. Falls back to the single Resolve-CtgS1MachineName (config/payload) when not supplied.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [string[]]$Machines
    )

    $actions  = [System.Collections.Generic.List[string]]::new()
    $isolated = [System.Collections.Generic.List[object]]::new()  # {machine; agentId} — for the reconnect UI

    $names = @($Machines | Where-Object { $_ })
    if (-not $names.Count) { $one = Resolve-CtgS1MachineName $User $Config; if ($one) { $names = @($one) } }
    if (-not $names.Count) {
        $actions.Add("WARN no machine name(s) — cannot resolve a SentinelOne agent to isolate. The Entra device step (or offboard config.machineName) must provide one. No action taken.")
        return [pscustomobject]@{ System = 'sentinelone'; Status = 'ok'; Actions = $actions.ToArray(); Isolated = @() }
    }

    $shutdown = [bool](Get-CtgProp $Config 'shutdown')
    foreach ($machine in (@($names) | Select-Object -Unique)) {
        $agents = @(Find-CtgS1Agents -ComputerName $machine)  # @() so empty stays a 0-count array
        if ($agents.Count -eq 0) {
            $actions.Add("no SentinelOne agent found for '$machine' — nothing to isolate (already removed, or a different console)")
            continue
        }
        if ($agents.Count -gt 1) {
            $ids = @($agents | ForEach-Object { Get-CtgProp $_ 'id' }) -join ', '
            $actions.Add("WARN $($agents.Count) SentinelOne agents match '$machine' (ids: $ids) — ambiguous, so NO action was taken on it. Isolate the correct endpoint by hand.")
            continue
        }
        $agent = $agents[0]
        $id    = [string](Get-CtgProp $agent 'id')

        if (Test-CtgS1Isolated $agent) {
            $actions.Add("endpoint '$machine' already network-isolated — no change")
            $isolated.Add([pscustomobject]@{ machine = $machine; agentId = $id })  # still isolated -> show it (reconnectable)
        }
        elseif ($PSCmdlet.ShouldProcess($machine, "Network-isolate SentinelOne agent")) {
            Invoke-CtgSentinelOneApi -Method POST -Path '/web/api/v2.1/agents/actions/disconnect' -Body @{ filter = @{ ids = @($id) } } | Out-Null
            $actions.Add("network-isolated endpoint '$machine' (quarantined from the network)")
            $isolated.Add([pscustomobject]@{ machine = $machine; agentId = $id })
        }

        # Shutdown is opt-in and irreversible-for-the-session: only when explicitly requested.
        if ($shutdown -and $PSCmdlet.ShouldProcess($machine, "Shut down SentinelOne endpoint")) {
            Invoke-CtgSentinelOneApi -Method POST -Path '/web/api/v2.1/agents/actions/shutdown' -Body @{ filter = @{ ids = @($id) } } | Out-Null
            $actions.Add("sent shutdown to endpoint '$machine'")
        }
    }
    if (-not $shutdown) { $actions.Add("shutdown not requested (config.shutdown is off) — endpoints isolated but left running") }

    [pscustomobject]@{ System = 'sentinelone'; Status = 'ok'; Machines = @($names); Isolated = @($isolated.ToArray()); Actions = $actions.ToArray() }
}

function Invoke-CtgSentinelOneReconnect {
    <#
    .SYNOPSIS
        Undo a network isolation — put an endpoint back on the network (the in-app "Reconnect" button).
        Resolve by agent id (preferred — recorded when we isolated) or by machine name. Idempotent.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$AgentId, [string]$Machine)
    $actions = [System.Collections.Generic.List[string]]::new()
    $id = $AgentId
    if (-not $id) {
        if (-not $Machine) { throw "Invoke-CtgSentinelOneReconnect needs -AgentId or -Machine." }
        $agents = @(Find-CtgS1Agents -ComputerName $Machine)
        if ($agents.Count -ne 1) {
            $actions.Add("WARN could not uniquely resolve '$Machine' in SentinelOne ($($agents.Count) match) — reconnect it by hand.")
            return [pscustomobject]@{ System = 'sentinelone'; Status = 'ok'; Actions = $actions.ToArray() }
        }
        $id = [string](Get-CtgProp $agents[0] 'id')
    }
    $label = if ($Machine) { "'$Machine' ($id)" } else { $id }
    if ($PSCmdlet.ShouldProcess(($Machine ? $Machine : $id), "Reconnect SentinelOne agent")) {
        Invoke-CtgSentinelOneApi -Method POST -Path '/web/api/v2.1/agents/actions/connect' -Body @{ filter = @{ ids = @($id) } } | Out-Null
        $actions.Add("reconnected endpoint $label to the network — no longer isolated")
    }
    [pscustomobject]@{ System = 'sentinelone'; Status = 'ok'; AgentId = $id; Machine = $Machine; Actions = $actions.ToArray() }
}

function Confirm-CtgSentinelOne {
    <#
    .SYNOPSIS
        Read-back. onboard -> always passes (deployment is out of band). offboard -> the endpoint is
        network-isolated (or absent). No mutations. Passes cleanly when no machine is resolvable
        (nothing was claimed to be done) so a missing-machine offboard isn't a permanent miss.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action,
        [string[]]$Machines
    )
    if ($Action -eq 'onboard') {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'SentinelOne agent deployment is out of band — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
    }

    $names = @($Machines | Where-Object { $_ })
    if (-not $names.Count) { $one = Resolve-CtgS1MachineName $User $Config; if ($one) { $names = @($one) } }
    if (-not $names.Count) {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'no machine resolved — nothing to isolate'; expected = $true; actual = $true; pass = $true }) }
    }
    $checks = @(foreach ($machine in (@($names) | Select-Object -Unique)) {
        $agents = @(Find-CtgS1Agents -ComputerName $machine)
        if ($agents.Count -ne 1) {
            # 0 = nothing to contain (pass); >1 = ambiguous, can't assert — surfaced by the executor already.
            @{ name = "SentinelOne agent for '$machine' not uniquely present ($($agents.Count)) — nothing asserted"; expected = $true; actual = $true; pass = $true }
        } else {
            $iso = Test-CtgS1Isolated $agents[0]
            @{ name = "SentinelOne endpoint '$machine' network-isolated"; expected = $true; actual = $iso; pass = $iso }
        }
    })
    [pscustomobject]@{ ok = (@($checks | Where-Object { -not $_.pass }).Count -eq 0); checks = $checks }
}

Export-ModuleMember -Function Connect-CtgSentinelOne, Invoke-CtgSentinelOneApi, Resolve-CtgS1MachineName, Find-CtgS1Agents, Test-CtgS1Isolated, Invoke-CtgSentinelOneOnboarding, Invoke-CtgSentinelOneOffboarding, Invoke-CtgSentinelOneReconnect, Confirm-CtgSentinelOne
