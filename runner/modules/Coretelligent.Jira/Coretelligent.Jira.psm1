#Requires -Version 7.0

# Coretelligent.Jira
# Atlassian Jira Cloud user lifecycle via the REST API. Onboard invites/creates a user with the
# configured product access; offboard removes the user from the site (revokes product access).
# Idempotent: a user is keyed by email (the address is derived from the person), so an existing
# email IS the same person — we adopt it and reconcile product access rather than re-create.
#
# Auth: Basic (admin email : API token) against https://<site>.atlassian.net. The admin must be an
# org/user-access admin; Jira must be added to the site for /user calls to succeed.

Set-StrictMode -Version Latest

$script:JiraAuth = $null
$script:JiraSite = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgJira {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Email, [Parameter(Mandatory)][string]$ApiToken, [Parameter(Mandatory)][string]$SiteUrl)
    $script:JiraAuth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${Email}:${ApiToken}"))
    $script:JiraSite = $SiteUrl.TrimEnd('/')
}

function Invoke-CtgJiraApi {
    # REST seam (Basic). Mocked in tests. Returns $null on 404.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:JiraAuth) { throw "Call Connect-CtgJira first." }
    $p = @{ Method = $Method; Uri = "$script:JiraSite$Path"; Headers = @{ Authorization = "Basic $script:JiraAuth" }; ContentType = 'application/json' }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { return Invoke-RestMethod @p }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }; throw }
}

function Get-CtgJiraUser {
    # The Jira user matching an email (privacy settings may hide emailAddress; the search still
    # resolves by it). Returns the first match or $null.
    param([Parameter(Mandatory)][string]$Email)
    $resp = Invoke-CtgJiraApi -Method GET -Path "/rest/api/3/user/search?query=$([uri]::EscapeDataString($Email))"
    $users = @($resp)
    if ($users.Count) { return $users[0] }
    return $null
}

function Invoke-CtgJiraOnboarding {
    <#
    .SYNOPSIS
        Idempotently invite/create a Jira Cloud user with the configured product access. An existing
        email is the same person (Atlassian keys users by email) — adopt it. Config: products[]
        (jira-software, jira-servicedesk, jira-core, jira-product-discovery).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()
    $email = [string]((Get-CtgProp $User 'WorkEmail') ?? $User.UserPrincipalName)
    $products = @(Get-CtgProp $Config 'products')

    $existing = Get-CtgJiraUser -Email $email
    if ($existing) {
        $actions.Add("Jira user already exists for $email — same person (email is the identity), skipped create")
    }
    elseif ($PSCmdlet.ShouldProcess($email, "Create Jira user")) {
        $body = @{ emailAddress = $email }
        if ($products.Count) { $body.products = $products } else { $body.products = @() }   # @() = default product access
        Invoke-CtgJiraApi -Method POST -Path '/rest/api/3/user' -Body $body | Out-Null
        $actions.Add("created Jira user: $email$(if ($products.Count) { " (products: $($products -join ', '))" } else { ' (default product access)' })")
    }

    [pscustomobject]@{ System = 'jira'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgJiraOffboarding {
    <#  .SYNOPSIS  Remove the user from the Jira site (revokes product access). The Atlassian account
        itself is org/SCIM-managed; this removes site access.  #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    # `?? $User.UserPrincipalName` was NOT StrictMode-safe: ?? evaluates its right operand precisely
    # when the left is null, which is exactly the case an offboard payload hits (a ServiceNow UM intake
    # carries `userToOffboard`, no UPN property at all) — so the dot-read threw. Every read goes through
    # Get-CtgProp; take the first EMAIL-shaped identifier, since a bare display name would report a
    # false "not found" success on an offboard.
    $email = [string](@('WorkEmail', 'UserPrincipalName', 'email', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { throw "jira: the case carries no email/UPN for the user to offboard — set the user's email on the case and re-run." }
    $found = Get-CtgJiraUser -Email $email
    if (-not $found) { return [pscustomobject]@{ System = 'jira'; Status = 'ok'; Actions = @("Jira user not found ($email)") } }
    $acctId = [string](Get-CtgProp $found 'accountId')
    if ($PSCmdlet.ShouldProcess($email, "Remove Jira site access")) {
        Invoke-CtgJiraApi -Method DELETE -Path "/rest/api/3/user?accountId=$([uri]::EscapeDataString($acctId))" | Out-Null
        $actions.Add("removed Jira site access: $email")
    }
    [pscustomobject]@{ System = 'jira'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgJira {
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config, [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action)
    # Same StrictMode-safe chain as the executor (`?? $User.UserPrincipalName` threw: ?? evaluates its
    # right operand exactly when the left is null, which is the offboard case). Unresolvable is NOT a
    # pass: with no email the lookup finds nobody, which reads as "already removed" and would
    # rubber-stamp an offboard that nobody performed.
    $email = [string](@('WorkEmail', 'UserPrincipalName', 'email', 'userToOffboard') | ForEach-Object { Get-CtgProp $User $_ } | Where-Object { $_ -match '@' } | Select-Object -First 1)
    if (-not $email) { return [pscustomobject]@{ ok = $false; checks = @(@{ name = 'no email/UPN on the case to verify against'; expected = $true; actual = $false; pass = $false }) } }
    $u = Get-CtgJiraUser -Email $email
    $checks = [System.Collections.Generic.List[hashtable]]::new()
    if ($Action -eq 'onboard') {
        $checks.Add(@{ name = 'Jira user present'; expected = $true; actual = [bool]$u; pass = [bool]$u })
    }
    else {
        $checks.Add(@{ name = 'Jira site access removed'; expected = $true; actual = (-not $u); pass = (-not $u) })
    }
    $ok = -not ($checks | Where-Object { -not $_.pass })
    [pscustomobject]@{ ok = [bool]$ok; checks = @($checks) }
}

Export-ModuleMember -Function Connect-CtgJira, Invoke-CtgJiraApi, Get-CtgJiraUser, Invoke-CtgJiraOnboarding, Invoke-CtgJiraOffboarding, Confirm-CtgJira
