#Requires -Version 7.0
<#
.SYNOPSIS
    iam-engine runner. Polls the app, claims jobs, executes via Coretelligent.* modules,
    posts results. Same script runs as the central cloud runner or a client-network agent.
.NOTES
    Outbound HTTPS only. Authenticates with mTLS in production (omitted in this skeleton).
    See docs/RUNNER_PROTOCOL.md.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AppUrl,        # https://iam-engine.internal
    [Parameter(Mandatory)][string]$AgentId,
    [string]$ApiToken = $env:RUNNER_API_TOKEN,    # interim shared bearer (until mTLS)
    [int]$PollSeconds = 5,
    [int]$BatchSize   = 5,
    # ExchangeOnlineManagement 3.10.0's REST cmdlets break on PowerShell 7.6 ("[HttpResponseMessage]
    # does not contain a method named 'GetResponseHeader'"); 3.9.2 is the known-good build. Pin the
    # version the runner loads so it never auto-picks a broken one. Override per host if needed.
    [string]$ExoModuleVersion = '3.9.2'
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/modules/Coretelligent.M365/Coretelligent.M365.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Mimecast/Coretelligent.Mimecast.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.DirectorySync/Coretelligent.DirectorySync.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Zoom/Coretelligent.Zoom.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Adobe/Coretelligent.Adobe.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Perimeter81/Coretelligent.Perimeter81.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Spanning/Coretelligent.Spanning.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Egnyte/Coretelligent.Egnyte.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Salesforce/Coretelligent.Salesforce.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.KnowBe4/Coretelligent.KnowBe4.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Jira/Coretelligent.Jira.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.HubSpot/Coretelligent.HubSpot.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.SentinelOne/Coretelligent.SentinelOne.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Duo/Coretelligent.Duo.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.XMatters/Coretelligent.XMatters.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.LogicMonitor/Coretelligent.LogicMonitor.psd1" -Force
Import-Module "$PSScriptRoot/modules/Coretelligent.Notify/Coretelligent.Notify.psd1" -Force
# (Coretelligent.Secrets is no longer imported: the app now resolves the secret value and pushes it
# down in the credential response — the runner no longer talks to Delinea itself.)
# These modules depend on host-specific cmdlets: the AD module needs the on-prem ActiveDirectory
# module (client-network agent only); Exchange needs ExchangeOnlineManagement. Load each only
# where its dependency is present so the central cloud runner doesn't fail to import.
if (Get-Module -ListAvailable ActiveDirectory) {
    Import-Module "$PSScriptRoot/modules/Coretelligent.ActiveDirectory/Coretelligent.ActiveDirectory.psd1" -Force
}
$exoAvail = Get-Module -ListAvailable ExchangeOnlineManagement
if ($exoAvail) {
    # Load the pinned EXO version FIRST (before Coretelligent.Exchange's RequiredModules auto-picks the
    # highest) so a broken build (3.10.0 on PS7.6) is never the one in scope. Fall back to the newest
    # available if the pin isn't installed — with a warning, since that may be the broken one.
    $exoPick = $exoAvail | Where-Object { $_.Version -eq [version]$ExoModuleVersion } | Select-Object -First 1
    if ($exoPick) {
        Import-Module ExchangeOnlineManagement -RequiredVersion $ExoModuleVersion -Force
    } else {
        $newest = ($exoAvail | Sort-Object Version -Descending | Select-Object -First 1).Version
        Write-Warning "ExchangeOnlineManagement $ExoModuleVersion not installed; using $newest (install the pin if EXO cmdlets fail with 'GetResponseHeader')."
        Import-Module ExchangeOnlineManagement -RequiredVersion $newest -Force
    }
    Import-Module "$PSScriptRoot/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force
}

# Safe property/key read at the RUNNER scope. Each Coretelligent module has its own private copy of
# this helper, but those aren't exported — so a script-scope call (e.g. reading $job.config) must use
# this one. Without it, the call is an unresolved command that the dependency guard below mistakes for
# a missing host-specific module ("the Coretelligent module providing 'Get-CtgProp' isn't loaded…").
function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Persistent troubleshooting log: errors/warnings/failures append to runner.log next to the
# script (build-id + bundle walks skip *.log), rotating at 5 MB. Pull a line from here when
# reporting an issue — it has the timestamp, job id and full error the console may have scrolled.
$script:CtgLogPath = Join-Path $PSScriptRoot 'runner.log'
function Write-CtgLog {
    param([ValidateSet('ERROR', 'WARN', 'INFO')][string]$Level = 'INFO', [Parameter(Mandatory)][string]$Message)
    try {
        if ((Test-Path $script:CtgLogPath) -and (Get-Item $script:CtgLogPath).Length -gt 5MB) {
            Move-Item $script:CtgLogPath "$($script:CtgLogPath).1" -Force
        }
        Add-Content -Path $script:CtgLogPath -Value "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) [$Level] $Message"
    } catch { }  # logging must never break the runner
}

# Build the AD connection splat from the brokered ad-dc secret (Option 2): the AD module
# authenticates as the ad-dc account (-Credential) against the DC named in its Fields (-Server),
# so the runner's own process identity needs no AD rights. Empty when ad-dc isn't brokered (the
# central runner / a host already running as a domain account).
function New-CtgAdConnection($creds) {
    $ad = @{}
    $s = $creds['ad-dc']
    if ($s) {
        if ($s.Credential) { $ad.Credential = $s.Credential }
        $server = $s.Fields['Server']
        if (-not $server) { $server = $s.Fields['DomainController'] }
        if ($server) { $ad.Server = $server }
    }
    return $ad
}

# Point the Spanning module at this job's brokered secret. The verified API authenticates with
# Basic clientId:clientSecret against o365-api-{region}.spanningbackup.com/external — so with the
# "Automation - API" template, ClientID is the Basic USERNAME and ClientSecret the password. Legacy
# tenants (domain:access-token) still work: Domain/AccountID, or the client's primary domain, fill
# the username slot when no ClientID is present. Reads PLAIN values from .Fields (.Password is a
# SecureString). Called at the START OF EVERY spanning lane (not a cached Connect) so a rotated
# credential takes effect on the next job, no restart needed.
function Use-CtgSpanningSecret {
    param($Job, $Creds)
    $s = $Creds['spanning']
    if (-not $s) { throw "the job did not broker a 'spanning' secret — make sure the client's spanning system lists 'spanning' in its secrets" }
    $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
    $tokenNames = @('ClientSecret', 'AccessToken', 'Access Token', 'ApiToken', 'API Key', 'APIKey', 'Api Key', 'ApiKey', 'Token', 'Key', 'Password')
    $token = & $pick $tokenNames
    # Fail actionably, not with an opaque parameter-binding error: name the fields we looked
    # for AND the ones the secret actually has, so the fix (rename a Delinea field) is obvious.
    if (-not $token) { throw "the 'spanning' secret has no client-secret/token field — looked for $($tokenNames -join ', '); the secret has: $(@($s.Fields.Keys) -join ', '). Put the Spanning client secret in one of those fields (see /help/spanning)." }
    $user = & $pick @('ClientID', 'ClientId', 'Client ID', 'Domain', 'AccountID', 'AccountId', 'Account', 'Tenant')
    if (-not $user) { $user = if ($s.Username) { $s.Username } else { $Job.client.primaryDomain } }
    $baseUrl = & $pick @('apiURL', 'ApiUrl', 'ApiURL', 'BaseUrl', 'Url')
    if ($baseUrl) { Connect-CtgSpanning -Username $user -AccessToken $token -BaseUrl $baseUrl }
    else          { Connect-CtgSpanning -Username $user -AccessToken $token -Region $s.Fields['Region'] }
}

# Connect Google Workspace from the brokered 'google-admin' secret. Domain-wide-delegated SERVICE
# ACCOUNT: the secret carries the downloaded JSON key (whole, as ServiceAccountJson, or base64 as
# ServiceAccountKeyBase64 — Delinea-safe for the multi-line private_key) OR ClientEmail+PrivateKey
# split out; plus the super-admin to impersonate (Impersonate field, else the secret's Username).
# Connect-CtgGoogle mints a fresh OAuth token each call, so a rotated key takes effect next job. See
# /help/google for the Cloud/Workspace setup that produces these fields.
function Use-CtgGoogleSecret {
    param($Job, $Creds)
    $s = $Creds['google-admin']
    if (-not $s) { throw "the job did not broker a 'google-admin' secret — make sure the client's google-workspace system lists 'google-admin' in its secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $clientEmail = & $pick @('ClientEmail', 'ServiceAccountEmail', 'client_email')
    $privateKey  = & $pick @('PrivateKey', 'private_key')
    $json = & $pick @('ServiceAccountJson', 'ServiceAccountKeyJson', 'KeyJson')
    $b64  = & $pick @('ServiceAccountKeyBase64', 'ServiceAccountJsonBase64', 'KeyBase64')
    if ($b64 -and -not $json) { $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
    if ($json) {
        $sa = $json | ConvertFrom-Json
        if (-not $clientEmail) { $clientEmail = [string]$sa.client_email }
        if (-not $privateKey)  { $privateKey  = [string]$sa.private_key }
    }
    if (-not $clientEmail -or -not $privateKey) {
        throw "the 'google-admin' secret has no service-account key — set ServiceAccountKeyBase64 (the downloaded JSON key, base64-encoded) or ServiceAccountJson, or split ClientEmail+PrivateKey. The secret has: $(@($f.Keys) -join ', '). See /help/google."
    }
    $impersonate = & $pick @('Impersonate', 'AdminEmail', 'Admin', 'Subject', 'DelegatedAdmin', 'AdminUser')
    if (-not $impersonate -and $s.Username) { $impersonate = [string]$s.Username }
    if (-not $impersonate) { throw "the 'google-admin' secret has no admin to impersonate — set the Impersonate field to a Workspace super-admin's email (domain-wide delegation acts as a real admin). See /help/google." }
    $customer = & $pick @('CustomerId', 'Customer'); if (-not $customer) { $customer = 'my_customer' }
    $scopesRaw = & $pick @('Scopes', 'Scope')
    $scopes = if ($scopesRaw) { @($scopesRaw -split '[,\s]+' | Where-Object { $_ }) } else { @() }
    if ($scopes.Count) { Connect-CtgGoogle -ClientEmail $clientEmail -PrivateKey $privateKey -Impersonate $impersonate -CustomerId $customer -Scopes $scopes }
    else               { Connect-CtgGoogle -ClientEmail $clientEmail -PrivateKey $privateKey -Impersonate $impersonate -CustomerId $customer }
}

# Connect Salesforce from the brokered 'salesforce' secret. Connected App JWT bearer: ConsumerKey
# (the app's client_id), the integration Username to act as, and the cert PrivateKey (PEM, or
# PrivateKeyBase64 — Delinea-safe). Sandbox tenants set LoginUrl/IsSandbox. Each lane re-connects so
# a rotated cert applies next job. See /help/salesforce.
function Use-CtgSalesforceSecret {
    param($Job, $Creds)
    $s = $Creds['salesforce']
    if (-not $s) { throw "the job did not broker a 'salesforce' secret — list 'salesforce' in the client's salesforce system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $consumerKey = & $pick @('ConsumerKey', 'ClientID', 'ClientId', 'ConsumerId')
    $username    = & $pick @('Username', 'IntegrationUser', 'AdminUser', 'Subject'); if (-not $username -and $s.Username) { $username = [string]$s.Username }
    $privateKey  = & $pick @('PrivateKey', 'private_key')
    $b64         = & $pick @('PrivateKeyBase64', 'CertificateBase64', 'KeyBase64')
    if ($b64 -and -not $privateKey) { $privateKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
    if (-not $consumerKey -or -not $username -or -not $privateKey) {
        throw "the 'salesforce' secret needs ConsumerKey + Username + PrivateKey (or PrivateKeyBase64). The secret has: $(@($f.Keys) -join ', '). See /help/salesforce."
    }
    $loginUrl = & $pick @('LoginUrl', 'LoginURL', 'InstanceUrl')
    if (-not $loginUrl) { $loginUrl = if ((& $pick @('IsSandbox', 'Sandbox')) -match '^(true|1|yes)$') { 'https://test.salesforce.com' } else { 'https://login.salesforce.com' } }
    Connect-CtgSalesforce -ConsumerKey $consumerKey -Username $username -PrivateKey $privateKey -LoginUrl $loginUrl
}

# Connect KnowBe4 from the brokered 'knowbe4' secret — the SCIM bearer token (+ optional region BaseUrl).
function Use-CtgKnowBe4Secret {
    param($Job, $Creds)
    $s = $Creds['knowbe4']
    if (-not $s) { throw "the job did not broker a 'knowbe4' secret — list 'knowbe4' in the client's knowbe4 system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $token = & $pick @('ScimToken', 'SCIMToken', 'Token', 'ApiToken', 'Key', 'Password')
    if (-not $token) { throw "the 'knowbe4' secret has no SCIM token — set ScimToken (Account Settings > User Management > SCIM). The secret has: $(@($f.Keys) -join ', '). See /help/knowbe4." }
    $baseUrl = & $pick @('BaseUrl', 'ScimUrl', 'Url')
    if ($baseUrl) { Connect-CtgKnowBe4 -Token $token -BaseUrl $baseUrl } else { Connect-CtgKnowBe4 -Token $token }
}

# Connect Jira from the brokered 'jira' secret — Basic (admin email : API token) + the site URL.
function Use-CtgJiraSecret {
    param($Job, $Creds)
    $s = $Creds['jira']
    if (-not $s) { throw "the job did not broker a 'jira' secret — list 'jira' in the client's jira system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $email = & $pick @('Email', 'AdminEmail', 'Username'); if (-not $email -and $s.Username) { $email = [string]$s.Username }
    $token = & $pick @('ApiToken', 'Token', 'Key', 'Password')
    $site  = & $pick @('SiteUrl', 'Site', 'Url', 'BaseUrl')
    if (-not $email -or -not $token -or -not $site) { throw "the 'jira' secret needs Email + ApiToken + SiteUrl (https://<site>.atlassian.net). The secret has: $(@($f.Keys) -join ', '). See /help/jira." }
    Connect-CtgJira -Email $email -ApiToken $token -SiteUrl $site
}

# Connect HubSpot from the brokered 'hubspot' secret — a private-app access token (Bearer).
function Use-CtgHubSpotSecret {
    param($Job, $Creds)
    $s = $Creds['hubspot']
    if (-not $s) { throw "the job did not broker a 'hubspot' secret — list 'hubspot' in the client's hubspot system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $token = & $pick @('AccessToken', 'Token', 'PrivateAppToken', 'ApiKey', 'Key', 'Password')
    if (-not $token) { throw "the 'hubspot' secret has no access token — set AccessToken (a private-app token). The secret has: $(@($f.Keys) -join ', '). See /help/hubspot." }
    $baseUrl = & $pick @('BaseUrl', 'Url')
    if ($baseUrl) { Connect-CtgHubSpot -Token $token -BaseUrl $baseUrl } else { Connect-CtgHubSpot -Token $token }
}

# Connect SentinelOne from the brokered 'sentinelone' secret — the management console URL + an API
# token (service user). ApiToken auth. Re-broker each lane so a rotated token applies next job.
function Use-CtgSentinelOneSecret {
    param($Job, $Creds)
    $s = $Creds['sentinelone']
    if (-not $s) { throw "the job did not broker a 'sentinelone' secret — list 'sentinelone' in the client's sentinelone system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $baseUrl = & $pick @('BaseUrl', 'ConsoleUrl', 'MgmtUrl', 'ManagementUrl', 'Url', 'ApiUrl')
    if (-not $baseUrl) { throw "the 'sentinelone' secret has no console URL — set BaseUrl to the management console (e.g. https://usea1-partners.sentinelone.net). The secret has: $(@($f.Keys) -join ', '). See /help/sentinelone." }
    $token = & $pick @('ApiToken', 'Token', 'ApiKey', 'API Key', 'Key', 'Password')
    if (-not $token) { throw "the 'sentinelone' secret has no API token — set ApiToken (a service-user token). The secret has: $(@($f.Keys) -join ', '). See /help/sentinelone." }
    Connect-CtgSentinelOne -BaseUrl $baseUrl -Token $token
}

# Connect Duo from the brokered 'duo' secret — the Admin API host + integration key + secret key.
function Use-CtgDuoSecret {
    param($Job, $Creds)
    $s = $Creds['duo']
    if (-not $s) { throw "the job did not broker a 'duo' secret — list 'duo' in the client's duo system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $apiHost = & $pick @('ApiHost', 'Host', 'Hostname', 'ApiHostname', 'BaseUrl', 'Url')
    $ikey    = & $pick @('IntegrationKey', 'IKey', 'ClientID', 'ClientId', 'Username'); if (-not $ikey -and $s.Username) { $ikey = [string]$s.Username }
    $skey    = & $pick @('SecretKey', 'SKey', 'ClientSecret', 'Secret', 'ApiKey', 'Key', 'Password')
    if (-not $apiHost -or -not $ikey -or -not $skey) { throw "the 'duo' secret needs ApiHost (api-XXXX.duosecurity.com) + IntegrationKey + SecretKey from a Duo Admin API application. The secret has: $(@($f.Keys) -join ', '). See /help/duo." }
    Connect-CtgDuo -ApiHost $apiHost -IntegrationKey $ikey -SecretKey $skey
}

# Connect xMatters from the brokered 'xmatters' secret — the company URL + a REST web-service user
# (Basic). The credential is the secret's pscredential, or Username/Password fields.
function Use-CtgXMattersSecret {
    param($Job, $Creds)
    $s = $Creds['xmatters']
    if (-not $s) { throw "the job did not broker an 'xmatters' secret — list 'xmatters' in the client's xmatters system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $baseUrl = & $pick @('apiURL', 'ApiUrl', 'BaseUrl', 'CompanyUrl', 'Url', 'Instance')
    if (-not $baseUrl) { throw "the 'xmatters' secret has no company URL — set apiURL (https://{company}.xmatters.com). The secret has: $(@($f.Keys) -join ', '). See /help/xmatters." }
    # xMatters API KEY + SECRET as Basic auth (key = username, secret = password). The Delinea
    # "Automation API" template stores them as clientID + ClientSecret; a REST user's Username +
    # Password works too. Prefer explicit fields, else the stored credential. (accountId is unused.)
    $u = & $pick @('ClientID', 'ClientId', 'ApiKey', 'AccessKey', 'Key', 'Username', 'User')
    $p = & $pick @('ClientSecret', 'Secret', 'ApiSecret', 'Password', 'Token', 'ApiToken')
    if (-not $u -and $s.Credential -and $s.Credential.UserName) { $u = [string]$s.Credential.UserName }
    if (-not $u -and $s.Username) { $u = [string]$s.Username }
    if (-not $p -and $s.Credential -and $s.Credential.Password) { $p = ConvertFrom-SecureString $s.Credential.Password -AsPlainText }
    if (-not $u -or -not $p) { throw "the 'xmatters' secret needs an API key + secret (clientID/ClientSecret) or a REST user Username + Password. The secret has: $(@($f.Keys) -join ', '). See /help/xmatters." }
    $cred = [pscredential]::new(([string]$u).Trim(), (ConvertTo-SecureString (([string]$p).Trim()) -AsPlainText -Force))
    Connect-CtgXMatters -BaseUrl $baseUrl -Credential $cred
}

# Connect LogicMonitor from the brokered 'logicmonitor' secret — the portal account + LMv1 access id +
# access key (an API-token, not a user password).
function Use-CtgLogicMonitorSecret {
    param($Job, $Creds)
    $s = $Creds['logicmonitor']
    if (-not $s) { throw "the job did not broker a 'logicmonitor' secret — list 'logicmonitor' in the client's logicmonitor system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    $account = & $pick @('Account', 'Portal', 'Company', 'Subdomain', 'BaseUrl', 'Url')
    if (-not $account) { throw "the 'logicmonitor' secret has no Account — set Account to the portal subdomain (e.g. 'coretelligent'). The secret has: $(@($f.Keys) -join ', '). See /help/logicmonitor." }
    $accessId  = & $pick @('AccessId', 'AccessID', 'ClientID', 'ClientId', 'Username'); if (-not $accessId -and $s.Username) { $accessId = [string]$s.Username }
    $accessKey = & $pick @('AccessKey', 'ClientSecret', 'Secret', 'ApiKey', 'Key', 'Password')
    if (-not $accessId -or -not $accessKey) { throw "the 'logicmonitor' secret needs AccessId + AccessKey (an LMv1 API token from Settings > User Access > API Tokens). The secret has: $(@($f.Keys) -join ', '). See /help/logicmonitor." }
    Connect-CtgLogicMonitor -Account $account -AccessId $accessId -AccessKey $accessKey
}

# Connect Zoom from the brokered 'zoom' secret — a Server-to-Server OAuth app: Client ID (the
# credential's username, or a Client* field), Client Secret (the password / *Secret field), and the
# Account ID. Tolerant of field-name variants and fails actionably (names what it looked for + what
# the secret has) instead of an opaque parameter-bind error.
function Use-CtgZoomSecret {
    param($Job, $Creds)
    $s = $Creds['zoom']
    if (-not $s) { throw "the job did not broker a 'zoom' secret — list 'zoom' in the client's zoom system secrets" }
    $f = $s.Fields
    $pick = { param($names) foreach ($k in $names) { if ($f.ContainsKey($k) -and $f[$k]) { return [string]$f[$k] } } $null }
    # Accept the S2S app creds from EITHER explicit custom fields OR the secret's username/password —
    # whichever is set. Prefer a non-empty custom field, then fall back to the credential, so an
    # operator who put the Client ID in the Username slot AND one who used a ClientId field both work.
    $accountId    = & $pick @('AccountId', 'AccountID', 'Account ID', 'Account')
    $clientId     = & $pick @('ClientId', 'ClientID', 'Client ID')
    $clientSecret = & $pick @('ClientSecret', 'Client Secret', 'Secret', 'ApiKey', 'Key')
    if (-not $clientId -and $s.Credential -and $s.Credential.UserName) { $clientId = [string]$s.Credential.UserName }
    if (-not $clientId -and $s.Username) { $clientId = [string]$s.Username }
    if (-not $clientSecret -and $s.Credential -and $s.Credential.Password) { $clientSecret = ConvertFrom-SecureString $s.Credential.Password -AsPlainText }
    if (-not $clientSecret) { $clientSecret = & $pick @('Password') }
    # Trim copy-paste whitespace/newlines — a trailing space in the id/secret is a common cause of
    # Zoom's invalid_client (the value "looks right" but the Basic header carries the stray char).
    $accountId = ([string]$accountId).Trim(); $clientId = ([string]$clientId).Trim(); $clientSecret = ([string]$clientSecret).Trim()
    if (-not $accountId -or -not $clientId -or -not $clientSecret) { throw "the 'zoom' secret needs a Server-to-Server OAuth app — Username = Client ID, Password = Client Secret, plus an AccountId field (or ClientId/ClientSecret/AccountId custom fields). The secret has: $(@($f.Keys) -join ', '). See /help/zoom." }
    $cred = [pscredential]::new($clientId, (ConvertTo-SecureString $clientSecret -AsPlainText -Force))
    Connect-CtgZoom -Credential $cred -AccountId $accountId
}

# The M365/Exchange tenant identifier for this job, in priority order:
#   1. the m365-admin secret's TenantId field — the Directory (tenant) ID GUID from the app
#      registration; unambiguous and ALWAYS accepted by Entra, even when domain names are mis-set
#   2. the client's primary domain (set on the client page)
#   3. the m365-admin secret's Domain field (the cloud-auth guide's table includes it)
# A newly added client can have all three blank — without this guard that surfaced as the opaque
# "Cannot bind argument to parameter 'TenantId' because it is an empty string".
function Get-CtgTenantDomain {
    param($Job, $Creds)
    $s = $Creds['m365-admin']
    $t = if ($s -and $s.Fields['TenantId']) { $s.Fields['TenantId'] }
         elseif ($Job.client.primaryDomain) { $Job.client.primaryDomain }
         elseif ($s) { $s.Fields['Domain'] }
    if (-not $t) {
        $have = if ($s) { @($s.Fields.Keys) -join ', ' } else { 'no m365-admin secret brokered' }
        throw "no tenant for client '$($Job.client.slug)': client.primaryDomain is empty and the m365-admin secret has no TenantId/Domain field (its fields: $have). Best fix: put the Directory (tenant) ID from the app registration in a TenantId field on the secret, or set the client's primary domain (see /help/cloud-auth)."
    }
    $t
}

function Get-CtgExoOrganization {
    # Exchange Online's -Organization needs a DOMAIN (e.g. dcg.co / dcg.onmicrosoft.com), NOT the
    # tenant GUID that Get-CtgTenantDomain prefers (the GUID is right for Graph -TenantId but EXO
    # rejects it: "Organization cannot be a Guid"). Pick the first non-GUID domain we can find.
    param($Job, $Creds)
    $cand = [System.Collections.Generic.List[string]]::new()
    if ($Job.client -and $Job.client.primaryDomain) { $cand.Add([string]$Job.client.primaryDomain) }
    $s = $Creds['m365-admin']
    if ($s -and $s.Fields) { foreach ($k in @('Domain', 'TenantDomain', 'Organization')) { if ($s.Fields[$k]) { $cand.Add([string]$s.Fields[$k]) } } }
    if ($Job.payload -and $Job.payload.UserPrincipalName -and ([string]$Job.payload.UserPrincipalName) -match '@') { $cand.Add(([string]$Job.payload.UserPrincipalName -split '@')[1]) }
    foreach ($c in $cand) { $d = ([string]$c).Trim(); if ($d -and $d -notmatch '^[0-9a-fA-F-]{36}$') { return $d } }
    throw "no Exchange Online organization DOMAIN for '$($Job.client.slug)' — EXO needs a domain (e.g. <tenant>.onmicrosoft.com), not the tenant GUID. Set the client's primary domain, or add a Domain field to the m365-admin secret."
}

# systemKey -> { Connect?; Onboard; Offboard }. Connect (optional) runs once per tenant before
# the first job for that system; the action lanes receive ($job, $creds) where $creds maps each
# The initial password for a new user, in priority order:
#   1. A brokered Delinea secret — named by config.initialPasswordSecret, else a 'default-password'
#      secret if one was brokered (the app resolved + pushed it down like any credential).
#   2. A literal config.initialPassword (a default typed into the KB).
#   3. A generated policy-compliant password (the default).
# Always returns a SecureString. No StrictMode at runner scope, so missing config props read $null.
function Resolve-CtgInitialPassword {
    param($Job, $Creds)
    $cfg = $Job.config
    $secretName = if ($cfg) { [string]$cfg.initialPasswordSecret } else { $null }
    if ([string]::IsNullOrWhiteSpace($secretName) -and $Creds -and $Creds.ContainsKey('default-password')) { $secretName = 'default-password' }
    if (-not [string]::IsNullOrWhiteSpace($secretName) -and $Creds -and $Creds.ContainsKey($secretName) -and $Creds[$secretName]) {
        $s = $Creds[$secretName]
        $val = $null
        if ($s.Password) { $val = ConvertFrom-SecureString $s.Password -AsPlainText }
        if ([string]::IsNullOrWhiteSpace($val) -and $s.Fields) {
            foreach ($k in @('Password', 'InitialPassword', 'Value', 'Key', 'Secret')) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { $val = [string]$s.Fields[$k]; break } }
        }
        if (-not [string]::IsNullOrWhiteSpace($val)) { return (ConvertTo-SecureString $val -AsPlainText -Force) }
    }
    $literal = if ($cfg) { [string]$cfg.initialPassword } else { $null }
    if (-not [string]::IsNullOrWhiteSpace($literal)) { return (ConvertTo-SecureString $literal -AsPlainText -Force) }
    return (New-CtgCompliantPassword)
}

# Build the app-only Exchange Online cert args from a brokered secret's Fields — prefer a base64 PFX
# (cross-platform: macOS/Linux/Windows), else a Windows cert-store thumbprint. Empty when neither set.
function Get-CtgExoCertArgs {
    param($Secret)
    $a = @{}
    $f = if ($Secret) { $Secret.Fields } else { $null }
    if ($f) {
        $b64 = if ($f['CertificateBase64']) { $f['CertificateBase64'] } elseif ($f['CertificatePfxBase64']) { $f['CertificatePfxBase64'] } else { $null }
        if ($b64) {
            $a['CertificateBase64'] = [string]$b64
            if ($f['CertificatePassword']) { $a['CertificatePassword'] = [string]$f['CertificatePassword'] }
        }
        elseif ($f['CertificateThumbprint']) { $a['CertificateThumbprint'] = [string]$f['CertificateThumbprint'] }
    }
    $a
}

function Invoke-CtgM365ExoFinish {
    # Finish the m365 onboard over Exchange Online with the SAME m365-admin app cert (no separate
    # Exchange system): (1) add the distribution / mail-enabled groups Graph couldn't write; and when
    # MIRRORING, (2) copy the mirror user's cloud DLs and (3) their SHARED-MAILBOX permissions
    # (FullAccess / SendAs / SendOnBehalf) — the part Graph can't do. One EXO connection for all of it.
    # Idempotent + best-effort; returns action lines.
    param($Job, $Creds, [string[]]$Names, [string]$MirrorUser)
    $out = [System.Collections.Generic.List[string]]::new()
    $names = @($Names | Where-Object { $_ })
    $mirror = if ([string]::IsNullOrWhiteSpace($MirrorUser)) { $null } else { [string]$MirrorUser }
    if ($names.Count -eq 0 -and -not $mirror) { return $out.ToArray() }

    if (-not (Get-Command Invoke-CtgExchangeNamedGroups -ErrorAction SilentlyContinue)) {
        if ($names.Count) { $out.Add("note: $($names.Count) distribution list(s) not added — ExchangeOnlineManagement isn't installed on this runner, so the Coretelligent.Exchange module didn't load. Install it (or run this client on a runner that has it).") }
        if ($mirror) { $out.Add("note: shared mailboxes / DLs not mirrored — ExchangeOnlineManagement isn't installed on this runner.") }
        return $out.ToArray()
    }
    $s = $Creds['m365-admin']
    $certArgs = Get-CtgExoCertArgs $s
    if ($certArgs.Count -eq 0) {
        $out.Add("note: Exchange Online steps skipped — the m365-admin secret has no EXO cert: set CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows), and grant the app Exchange.ManageAsApp.")
        return $out.ToArray()
    }
    try {
        $what = @($(if ($names.Count) { 'distribution lists' }), $(if ($mirror) { 'mirror (DLs + shared mailboxes)' }) | Where-Object { $_ }) -join ' + '
        Set-CtgPhase $Job.id "finishing over Exchange Online (app-only): $what"
        Connect-CtgExchange -AppId $s.Credential.UserName -Organization (Get-CtgExoOrganization $Job $Creds) @certArgs
        $upn = [string]$Job.payload.UserPrincipalName
        if ($names.Count) { foreach ($a in (Invoke-CtgExchangeNamedGroups -NewUser $upn -Groups $names)) { $out.Add($a) } }
        if ($mirror) {
            foreach ($a in (Invoke-CtgExchangeDistListMirror -MirrorUser $mirror -NewUser $upn)) { $out.Add($a) }
            foreach ($a in (Invoke-CtgExchangeSharedMailboxMirror -MirrorUser $mirror -NewUser $upn)) { $out.Add($a) }
        }
    } catch {
        $out.Add("WARN Exchange Online finish failed ($($_.Exception.Message)) — grant the m365-admin app Exchange.ManageAsApp + set its cert (CertificateBase64 or CertificateThumbprint) on the secret.")
    }
    return $out.ToArray()
}

# named secret to its resolved credential object (.Credential is a pscredential).
$DISPATCH = @{
    'm365' = @{
        Connect  = { param($job, $creds)
            $tenant = Get-CtgTenantDomain $job $creds
            # Phase carries WHAT we're attempting (tenant + app id, never the secret) so a failure
            # reads "while connecting to m365 (tenant X, app Y): <error>" instead of a bare error.
            Set-CtgPhase $job.id "connecting to m365 (tenant $tenant, app $($creds['m365-admin'].Credential.UserName))"
            Connect-CtgM365 -Credential $creds['m365-admin'].Credential -TenantId $tenant
        }
        Onboard  = { param($job, $creds)
            $r = Invoke-CtgM365Onboarding -User $job.payload -Config $job.config -InitialPassword (Resolve-CtgInitialPassword -Job $job -Creds $creds)
            # Finish over Exchange Online with the SAME m365-admin app (cert) — no separate Exchange
            # system needed: the DLs Graph couldn't write, plus (when mirroring) the mirror user's DLs
            # and shared-mailbox permissions. One EXO connection, best-effort.
            $dls = @(if ($r.PSObject.Properties['DeferredDistributionGroups']) { $r.DeferredDistributionGroups })
            $mirror = [string](Get-CtgProp $job.config 'mirrorFromUser')
            if ($dls.Count -gt 0 -or $mirror) {
                foreach ($a in (Invoke-CtgM365ExoFinish -Job $job -Creds $creds -Names $dls -MirrorUser $mirror)) { $r.Actions = @($r.Actions) + $a }
            }
            $r
        }
        Offboard = { param($job, $creds) Invoke-CtgM365Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgM365 -User $job.payload -Config $job.config -Action $job.action }
    }
    'active-directory' = @{
        Onboard  = { param($job, $creds) Invoke-CtgADOnboarding  -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Offboard = { param($job, $creds) Invoke-CtgADOffboarding -User (Add-ClientContext $job) -Config $job.config -AdConnection (New-CtgAdConnection $creds) }
        Validate = { param($job, $creds) Confirm-CtgAD -User (Add-ClientContext $job) -Config $job.config -Action $job.action -AdConnection (New-CtgAdConnection $creds) }
    }
    'mimecast' = @{
        # Mimecast API 2.0: OAuth2 client-credentials. Template-tolerant — the client id can live in
        # Username OR a ClientID-style field ("Automation - API" template), the client secret in
        # Password OR a ClientSecret-style field. Fails with the fields it saw, never a null-binding.
        Connect  = { param($job, $creds)
            $s = $creds['mimecast']
            if (-not $s) { throw "the job did not broker a 'mimecast' secret — make sure the client's mimecast system lists 'mimecast' in its secrets" }
            $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
            $id = & $pick @('ClientID', 'ClientId', 'Client ID', 'AppId', 'Application ID', 'Username')
            $secret = & $pick @('ClientSecret', 'Client Secret', 'Secret', 'API Key', 'ApiKey', 'AccessToken', 'Token', 'Password')
            if (-not $id -or -not $secret) {
                throw "the 'mimecast' secret needs a CLIENT ID (Username or ClientID field) + CLIENT SECRET (Password or ClientSecret field) from the API 2.0 application; the secret has: $(@($s.Fields.Keys) -join ', ') (see /help/mimecast)"
            }
            Connect-CtgMimecast -Credential ([pscredential]::new([string]$id, (ConvertTo-SecureString ([string]$secret) -AsPlainText -Force)))
        }
        Onboard  = { param($job, $creds) Invoke-CtgMimecastOnboarding  -User $job.payload -Config $job.config -InitialPassword (ConvertFrom-SecureString (Resolve-CtgInitialPassword -Job $job -Creds $creds) -AsPlainText) }
        Offboard = { param($job, $creds) Invoke-CtgMimecastOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgMimecast -User $job.payload -Config $job.config -Action $job.action }
    }
    'directory-sync' = @{
        # ad-dc credential lets the runner remote into the Entra Connect host (config.host) when the
        # ADSync module isn't on this agent's box (Model A: one DC runner remotes to Core-CCE-AzSync).
        Onboard  = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config -Credential ($creds['ad-dc']).Credential }
        Offboard = { param($job, $creds) Invoke-CtgDirectorySync -Config $job.config -Credential ($creds['ad-dc']).Credential }
        Validate = { param($job, $creds) Confirm-CtgDirectorySync -User $job.payload -Config $job.config -Action $job.action -Credential ($creds['ad-dc']).Credential }
    }
    'exchange' = @{
        # EXO app-only needs certificate auth (m365-admin carries the cert thumbprint). A hybrid
        # onboard ALSO needs an on-prem Exchange session for Enable-RemoteMailbox — established only
        # when the job brokered the `exchange-onprem` secret (its Fields carry the PowerShell URI).
        Connect  = { param($job, $creds)
            $s = $creds['m365-admin']
            Set-CtgPhase $job.id "connecting to Exchange Online (app-only cert auth, app $($s.Credential.UserName))"
            $exoCert = Get-CtgExoCertArgs $s
            if ($exoCert.Count -eq 0) { throw "the m365-admin secret has no Exchange Online cert — set CertificateBase64 (a .pfx, cross-platform) or CertificateThumbprint (Windows store), and grant the app Exchange.ManageAsApp." }
            Connect-CtgExchange -AppId $s.Credential.UserName -Organization (Get-CtgExoOrganization $job $creds) @exoCert
            # On-prem session for BOTH lanes when the `exchange-onprem` secret is brokered: onboard
            # needs Enable-RemoteMailbox; a HYBRID offboard needs Set-RemoteMailbox -Type Shared
            # (an EXO Set-Mailbox would be overwritten by AD Connect on an on-prem-mastered mailbox).
            # The credential may reuse the ad-dc Delinea id (the domain admin already has Exchange
            # rights). The PowerShell URI comes from the secret's ConnectionUri field if present, else
            # the system config (`onPremExchangeUri`) — so reusing ad-dc needs no extra Delinea field.
            $op = $creds['exchange-onprem']
            if ($op) {
                # The PowerShell endpoint URI can live in any of these secret fields (so an existing
                # "Document Link"/"URL" field can be reused instead of adding a ConnectionUri one),
                # else falls back to the exchange system config's onPremExchangeUri.
                $pickUri = { param($names) foreach ($k in $names) { if ($op.Fields.ContainsKey($k) -and $op.Fields[$k]) { return [string]$op.Fields[$k] } } $null }
                $opUri = & $pickUri @('ConnectionUri', 'ConnectionUrl', 'ConnectionURL', 'Uri', 'Url', 'URL', 'PowerShellUri', 'PowerShellUrl', 'Link', 'DocumentLink', 'Document Link')
                # System config: a real job's config is the action sub-object (top-level key); a
                # connection test passes the whole config, so also look under onboard/offboard.
                if (-not $opUri) {
                    $cfg = $job.config
                    $opUri = [string]((Get-CtgProp $cfg 'onPremExchangeUri') ?? (Get-CtgProp (Get-CtgProp $cfg 'offboard') 'onPremExchangeUri') ?? (Get-CtgProp (Get-CtgProp $cfg 'onboard') 'onPremExchangeUri'))
                }
                if (-not $opUri) { throw "the on-prem Exchange session needs a PowerShell URI — set ConnectionUri (or a Document Link / URL field) on the exchange-onprem secret, or onPremExchangeUri on the exchange system. e.g. http://core-cce1-ex01.core.tech/PowerShell/" }
                Set-CtgPhase $job.id "connecting to on-prem Exchange ($opUri)"
                Connect-CtgExchangeOnPrem -ConnectionUri $opUri -Credential $op.Credential
            }
        }
        # Hybrid onboard, one pass across the sync boundary: enable remote mailbox -> trigger an Entra
        # Connect delta sync (so the mailbox provisions now) -> wait for it -> regional/calendar. The
        # sync trigger reuses the on-prem (ad-dc) credential and auto-discovers the Entra Connect host.
        Onboard  = { param($job, $creds)
            # CLOUD client (no on-prem Exchange session brokered): the M365 license already made the
            # mailbox, so skip Enable-RemoteMailbox and just do the EXO-only work — add the requested
            # distribution lists by name. HYBRID (on-prem session present): the full remote-mailbox pass.
            if (-not $creds['exchange-onprem']) {
                Invoke-CtgExchangeCloudOnboard -User $job.payload -Config $job.config
            }
            else {
                $syncCred = ($creds['exchange-onprem']).Credential
                $trigger = if ($syncCred) { { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) -Credential $syncCred | Out-Null }.GetNewClosure() } else { $null }
                Invoke-CtgExchangeHybridOnboard -User $job.payload -Config $job.config -TriggerSync $trigger
            }
        }
        Offboard = { param($job, $creds)
            # Pass a delta-sync trigger (reusing the on-prem credential) so a HYBRID convert-to-shared
            # via Set-RemoteMailbox is pushed to the cloud immediately; cloud-only offboards ignore it.
            $op = $creds['exchange-onprem']
            $syncCred = if ($op) { $op.Credential } else { $null }
            $trigger = if ($syncCred) { { Invoke-CtgDirectorySync -Config ([pscustomobject]@{}) -Credential $syncCred | Out-Null }.GetNewClosure() } else { $null }
            Invoke-CtgExchangeOffboarding -User $job.payload -Config $job.config -TriggerSync $trigger
        }
        Validate = { param($job, $creds) Confirm-CtgExchange -User $job.payload -Config $job.config -Action $job.action }
    }
    'zoom' = @{
        Connect  = { param($job, $creds) Use-CtgZoomSecret -Job $job -Creds $creds }
        Onboard  = { param($job, $creds) Invoke-CtgZoomOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgZoomOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgZoom -User $job.payload -Config $job.config -Action $job.action }
    }
    'adobe' = @{
        Connect  = { param($job, $creds) Connect-CtgAdobe -Credential $creds['adobe'].Credential -OrgId $creds['adobe'].Fields['OrgId'] }
        Onboard  = { param($job, $creds) Invoke-CtgAdobeOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgAdobeOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgAdobe -User $job.payload -Config $job.config -Action $job.action }
    }
    'perimeter81' = @{
        Connect  = { param($job, $creds) Connect-CtgPerimeter81 -ApiKey $creds['perimeter81'].Fields['ApiKey'] }
        Onboard  = { param($job, $creds) Invoke-CtgPerimeter81Onboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgPerimeter81Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgPerimeter81 -User $job.payload -Config $job.config -Action $job.action }
    }
    'egnyte' = @{
        # Egnyte: per-tenant host https://{Domain}.egnyte.com, OAuth2 bearer. Secret fields:
        # Domain (the tenant subdomain, e.g. "drakestar") + either a long-lived Token (preferred —
        # Egnyte tokens don't expire) or ClientID (the API key) + Username/Password (service
        # account) for the password grant. Template-tolerant field matching; actionable errors.
        Connect  = { param($job, $creds)
            $s = $creds['egnyte']
            if (-not $s) { throw "the job did not broker an 'egnyte' secret — make sure the client's egnyte system lists 'egnyte' in its secrets" }
            $pick = { param($names) foreach ($k in $names) { if ($s.Fields.ContainsKey($k) -and $s.Fields[$k]) { return $s.Fields[$k] } } $null }
            $domain = & $pick @('Domain', 'EgnyteDomain', 'Tenant', 'AccountID', 'AccountId')
            if (-not $domain) { throw "the 'egnyte' secret has no Domain field — set it to the tenant subdomain (e.g. 'drakestar' for drakestar.egnyte.com); the secret has: $(@($s.Fields.Keys) -join ', ') (see /help/egnyte)" }
            $token = & $pick @('Token', 'AccessToken', 'Access Token', 'ApiToken', 'API Key', 'APIKey', 'Api Key', 'ApiKey', 'Bearer')
            if ($token) { Connect-CtgEgnyte -Domain $domain -Token $token }
            else {
                $clientId = & $pick @('ClientID', 'ClientId', 'Client ID', 'Key')
                if (-not $clientId -or -not $s.Credential) { throw "the 'egnyte' secret needs either a Token field (preferred) or ClientID + Username/Password for the password grant; the secret has: $(@($s.Fields.Keys) -join ', ') (see /help/egnyte)" }
                Connect-CtgEgnyte -Domain $domain -ClientId $clientId -Credential $s.Credential
            }
        }
        Onboard  = { param($job, $creds) Invoke-CtgEgnyteOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgEgnyteOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgEgnyte -User $job.payload -Config $job.config -Action $job.action }
    }
    'spanning' = @{
        # Spanning Backup: HTTP Basic auth, username = the CLIENT ID, password = the CLIENT SECRET
        # (see Use-CtgSpanningSecret). NO Connect block ON PURPOSE: Connect-CtgSpanning is a pure
        # local assignment (no network), so each lane just re-reads the brokered secret (free) —
        # which also means a rotated credential applies on the very next job.
        Onboard  = { param($job, $creds) Use-CtgSpanningSecret $job $creds; Invoke-CtgSpanningOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgSpanningSecret $job $creds; Invoke-CtgSpanningOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgSpanningSecret $job $creds; Confirm-CtgSpanning -User $job.payload -Config $job.config -Action $job.action }
    }
    'google-workspace' = @{
        Connect  = { param($job, $creds) Use-CtgGoogleSecret -Job $job -Creds $creds }
        Onboard  = { param($job, $creds) Invoke-CtgGoogleOnboarding  -User $job.payload -Config $job.config -InitialPassword (New-CtgCompliantPassword) }
        Offboard = { param($job, $creds) Invoke-CtgGoogleOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgGoogle -User $job.payload -Config $job.config -Action $job.action }
    }
    'salesforce' = @{
        Connect  = { param($job, $creds) Use-CtgSalesforceSecret $job $creds }
        Onboard  = { param($job, $creds) Invoke-CtgSalesforceOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgSalesforceOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgSalesforce -User $job.payload -Config $job.config -Action $job.action }
    }
    'knowbe4' = @{
        # No network in Connect — re-broker the SCIM token each lane (a rotated token applies next job).
        Onboard  = { param($job, $creds) Use-CtgKnowBe4Secret $job $creds; Invoke-CtgKnowBe4Onboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgKnowBe4Secret $job $creds; Invoke-CtgKnowBe4Offboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgKnowBe4Secret $job $creds; Confirm-CtgKnowBe4 -User $job.payload -Config $job.config -Action $job.action }
    }
    'jira' = @{
        Onboard  = { param($job, $creds) Use-CtgJiraSecret $job $creds; Invoke-CtgJiraOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgJiraSecret $job $creds; Invoke-CtgJiraOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgJiraSecret $job $creds; Confirm-CtgJira -User $job.payload -Config $job.config -Action $job.action }
    }
    'hubspot' = @{
        Onboard  = { param($job, $creds) Use-CtgHubSpotSecret $job $creds; Invoke-CtgHubSpotOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgHubSpotSecret $job $creds; Invoke-CtgHubSpotOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgHubSpotSecret $job $creds; Confirm-CtgHubSpot -User $job.payload -Config $job.config -Action $job.action }
    }
    'sentinelone' = @{
        # Connect key (vs inline) so the connection-test harness can exercise it; the job loop's
        # connect-cache re-brokers when the credential fingerprint changes (rotated token next job).
        Connect  = { param($job, $creds) Use-CtgSentinelOneSecret $job $creds }
        Onboard  = { param($job, $creds) Invoke-CtgSentinelOneOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgSentinelOneOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgSentinelOne -User $job.payload -Config $job.config -Action $job.action }
    }
    'duo' = @{
        Onboard  = { param($job, $creds) Use-CtgDuoSecret $job $creds; Invoke-CtgDuoOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgDuoSecret $job $creds; Invoke-CtgDuoOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgDuoSecret $job $creds; Confirm-CtgDuo -User $job.payload -Config $job.config -Action $job.action }
    }
    'xmatters' = @{
        Connect  = { param($job, $creds) Use-CtgXMattersSecret $job $creds }
        Onboard  = { param($job, $creds) Invoke-CtgXMattersOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgXMattersOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgXMatters -User $job.payload -Config $job.config -Action $job.action }
    }
    'logicmonitor' = @{
        Onboard  = { param($job, $creds) Use-CtgLogicMonitorSecret $job $creds; Invoke-CtgLogicMonitorOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Use-CtgLogicMonitorSecret $job $creds; Invoke-CtgLogicMonitorOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Use-CtgLogicMonitorSecret $job $creds; Confirm-CtgLogicMonitor -User $job.payload -Config $job.config -Action $job.action }
    }
    'notify' = @{
        # Sends offboard emails via Graph sendMail using the m365-admin app — reuse the m365 Connect so
        # the ambient Microsoft.Graph context (Send-MgUserMail) is established. Runs last in the offboard.
        Connect  = { param($job, $creds)
            $tenant = Get-CtgTenantDomain $job $creds
            Set-CtgPhase $job.id "connecting to Graph for notifications (tenant $tenant, app $($creds['m365-admin'].Credential.UserName))"
            Connect-CtgM365 -Credential $creds['m365-admin'].Credential -TenantId $tenant
        }
        Onboard  = { param($job, $creds) Invoke-CtgNotifyOnboarding  -User $job.payload -Config $job.config }
        Offboard = { param($job, $creds) Invoke-CtgNotifyOffboarding -User $job.payload -Config $job.config }
        Validate = { param($job, $creds) Confirm-CtgNotify -User $job.payload -Config $job.config -Action $job.action }
    }
}

# entra is the Entra-ID slice of the M365 module — same executor + read-backs (catalog
# moduleName = Coretelligent.M365). Alias it so an `entra` job isn't left without an executor.
$DISPATCH['entra'] = $DISPATCH['m365']

# Action -> validate, with idempotent auto-retry. On a validation miss we re-run the (idempotent)
# action and re-validate up to $MaxRevalidate times — this self-heals eventual-consistency lags.
# A persistent miss is NOT a failure: the job still succeeds; the validation block (ok=$false)
# rides along on the result and the app's run report flags it as a warning.
$MaxRevalidate = 2

function Invoke-JobWithValidation {
    param($Job, $Handler, [scriptblock]$Fn, $Creds, [bool]$DryRun)

    # Dry run: set WhatIf so every module's SupportsShouldProcess short-circuits the mutations, then
    # run the validators read-only. MUST be $global: — module functions (Coretelligent.*) resolve
    # preference variables from their own/module/GLOBAL scope, NOT the caller's, so a local
    # $WhatIfPreference here would be ignored and the executors would run LIVE despite dry-run.
    if ($DryRun) { $global:WhatIfPreference = $true }
    try { $result = & $Fn $Job $Creds }
    finally { if ($DryRun) { $global:WhatIfPreference = $false } }

    $validate = if ($Handler.ContainsKey('Validate')) { $Handler['Validate'] } else { $null }
    $validation = $null
    if ($validate) {
        $validation = & $validate $Job $Creds
        $attempt = 0
        while ($validation -and -not $validation.ok -and -not $DryRun -and $attempt -lt $MaxRevalidate) {
            Start-Sleep -Seconds (2 * ($attempt + 1))
            $result = & $Fn $Job $Creds          # idempotent re-run
            $validation = & $validate $Job $Creds
            $attempt++
        }
    }
    [pscustomobject]@{ Result = $result; Validation = $validation }
}

# Track which tenant+credential each system's Connect block is CURRENTLY connected with. The
# Coretelligent.* modules hold exactly one connection in module state (Connect-Ctg* overwrites it),
# so a per-(system|tenant) "already connected" set is wrong on a multi-client runner: an A->B->A
# job interleave would skip A's reconnect and silently run A's job against B's tenant. Keying
# system -> "tenant|credential-fingerprint" reconnects on every tenant switch AND on credential
# rotation (and keeps blank-domain clients with different secret TenantIds apart).
$script:ConnectedTenant = @{}

# A short, non-reversible fingerprint of every brokered secret's fields for this job. Used ONLY as
# a connect-cache key component — never logged, never sent anywhere. SHA-256 over sorted
# name.field=value pairs, truncated.
function Get-CtgCredFingerprint {
    param($Creds)
    $sb = [System.Text.StringBuilder]::new()
    foreach ($name in (@($Creds.Keys) | Sort-Object)) {
        $c = $Creds[$name]
        if (-not $c -or -not $c.Fields) { continue }
        foreach ($k in (@($c.Fields.Keys) | Sort-Object)) { [void]$sb.Append("$name.$k=$($c.Fields[$k]);") }
    }
    $hash = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($sb.ToString()))
    ([BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16)
}

# The on-prem AD module needs the client's primary domain to build the OU DN; fold it in from
# the job's client context if the intake payload didn't carry it.
function Add-ClientContext {
    param($Job)
    $u = $Job.payload
    if ($u -and -not $u.PSObject.Properties['PrimaryDomain']) {
        $u | Add-Member -NotePropertyName PrimaryDomain -NotePropertyValue $Job.client.primaryDomain -Force
    }
    $u
}

function Invoke-AppApi {
    param([string]$Method, [string]$Path, $Body)
    # ngrok-skip-browser-warning bypasses ngrok-free's HTML interstitial (harmless on other hosts).
    $headers = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $headers['Authorization'] = "Bearer $ApiToken" }
    $p = @{ Method = $Method; Uri = "$AppUrl$Path"; ContentType = 'application/json'; Headers = $headers }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 12) }
    Invoke-RestMethod @p   # mTLS replaces the shared bearer in production
}

function global:Send-CtgProgress {
    # Post one progress line for the current job. GLOBAL on purpose: the Coretelligent.* modules run in
    # their own scope and can't see the runner's script functions — only global ones — so a long module
    # operation (e.g. the Exchange mailbox sync-wait) can call this to emit a "still trying" heartbeat.
    # Reads per-job globals; best-effort (a failed post never breaks the job).
    param([string]$Message)
    $jid = $global:CtgProgressJobId
    if (-not $jid) { return }
    $h = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($global:CtgProgressToken) { $h['Authorization'] = "Bearer $($global:CtgProgressToken)" }
    try { Invoke-RestMethod -Method POST -Uri "$($global:CtgProgressUrl)/api/jobs/$jid/progress" -ContentType 'application/json' -Headers $h -Body (@{ agentId = $global:CtgProgressAgent; phase = $Message } | ConvertTo-Json) | Out-Null } catch { }
}

function Set-CtgPhase {
    # Record what we're doing right now: keep it in $script:Phase (so a thrown error can say WHICH
    # phase failed instead of a bare "Unauthorized"), and beacon it to the app so the run report can
    # show live progress. Routes through the global poster so module + runner share one path.
    param([string]$JobId, [string]$Phase)
    $script:Phase = $Phase
    if ($JobId) { $global:CtgProgressJobId = $JobId }
    Write-Host "  · $Phase" -ForegroundColor DarkGray
    Send-CtgProgress $Phase
}

# Self-heal: only auto-install modules that are part of our trusted IAM toolchain — never an arbitrary
# gallery module conjured from a typo'd cmdlet name.
$script:CtgAutoInstallModules = @('Microsoft.Graph.*', 'ExchangeOnlineManagement', 'MSOnline', 'AzureAD', 'AzureADPreview', 'Az.*', 'ADSync', 'ActiveDirectory')

function Get-CtgMissingCommandName {
    # Pull the unresolved command name out of a CommandNotFoundException (or its "The term 'X' is not
    # recognized" message). Returns $null when the error isn't a missing-command.
    param($ErrorRecord)
    $ex = $ErrorRecord.Exception
    while ($ex) {
        if ($ex -is [System.Management.Automation.CommandNotFoundException]) { return $ex.CommandName }
        $ex = $ex.InnerException
    }
    $m = "$($ErrorRecord.Exception.Message)"
    if ($m -match "[Tt]he term '([^']+)' is not recognized") { return $matches[1] }
    return $null
}

function Repair-CtgMissingModule {
    # Given a missing cmdlet, find the gallery module that provides it and install+import it — but only
    # if that module is in our trusted allowlist. Returns the module name on success, else $null.
    param([string]$CommandName)
    if (-not $CommandName) { return $null }
    if (-not (Get-Command Find-Command -ErrorAction SilentlyContinue)) { return $null }  # needs PowerShellGet
    $mod = $null
    try { $mod = (Find-Command -Name $CommandName -ErrorAction Stop | Select-Object -First 1).ModuleName } catch { return $null }
    if (-not $mod) { return $null }
    $trusted = $false
    foreach ($p in $script:CtgAutoInstallModules) { if ($mod -like $p) { $trusted = $true; break } }
    if (-not $trusted) { Write-Warning "self-heal: '$CommandName' is in module '$mod', not on the auto-install allowlist — skipping"; return $null }
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        # The runner is detached (no stdin), so Install-Module must NEVER prompt or it hangs forever.
        # Bootstrap the NuGet provider + trust the gallery up front, then install fully non-interactively.
        if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
            Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
        }
        if ((Get-PSRepository -Name PSGallery -ErrorAction SilentlyContinue).InstallationPolicy -ne 'Trusted') {
            Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
        }
        Install-Module $mod -Scope CurrentUser -Force -AllowClobber -Confirm:$false -AcceptLicense -ErrorAction Stop
        Import-Module $mod -Force -ErrorAction Stop
        return $mod
    } catch { Write-Warning "self-heal: failed to install '$mod' for '$CommandName': $($_.Exception.Message)"; return $null }
}

function Update-CtgRunner {
    # Operator clicked "Update": re-pull every runner file from the app's manifest into our own
    # folder, then relaunch this script (new pwsh process = new code) and exit. Re-runnable and
    # self-contained so the operator never has to hand-walk a re-pull on the host again.
    $H = @{ 'ngrok-skip-browser-warning' = 'true' }
    if ($ApiToken) { $H['Authorization'] = "Bearer $ApiToken" }
    Write-Host "self-update: pulling latest runner from $AppUrl" -ForegroundColor Yellow
    $manifest = Invoke-RestMethod -Uri "$AppUrl/api/runner/manifest" -Headers $H -TimeoutSec 30
    foreach ($rel in $manifest.files) {
        # Manifest paths are POSIX-style ('a/b/c'); Join-Path accepts '/' on Windows and it's native
        # on macOS/Linux, so use $rel as-is rather than forcing a backslash (which would corrupt
        # paths on a non-Windows central runner).
        $dest = Join-Path $PSScriptRoot $rel
        New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
        $resp = Invoke-WebRequest -Uri "$AppUrl/api/runner/file?path=$([uri]::EscapeDataString($rel))" -UseBasicParsing -Headers $H -TimeoutSec 60
        [System.IO.File]::WriteAllText($dest, $resp.Content)
    }
    # PRUNE files no longer in the bundle. Pulling-without-deleting leaves stale leftovers (a removed/
    # renamed module), and Get-CtgBuildId hashes EVERY file in the folder — so one leftover makes our
    # build id differ from the app's forever: "update available" that re-pulls but never converges
    # ("updated, back online… still the same version"). Keep only manifest files + the runtime files
    # the hash already excludes (.build, .runner.lock, *.log). Mirrors Get-CtgBuildId's skip-list.
    $want = @{}; foreach ($rel in $manifest.files) { $want[(Join-Path $PSScriptRoot $rel)] = $true }
    foreach ($f in Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File -ErrorAction SilentlyContinue) {
        if ($want.ContainsKey($f.FullName)) { continue }
        if ($f.Name -eq '.build' -or $f.Name -eq '.runner.lock' -or $f.Name -eq '.DS_Store' -or $f.Name -like '*.log') { continue }
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; Write-Host "self-update: pruned stale $($f.Name)" -ForegroundColor DarkYellow } catch { }
    }
    Write-Host "self-update: pulled $($manifest.files.Count) files (build $($manifest.buildId)) — restarting" -ForegroundColor Green
    # Relaunch a fresh process on the just-downloaded script, then exit this one. Spawn it via WMI
    # (Win32_Process.Create), NOT Start-Process: the WMI host creates the process, so it BREAKS AWAY
    # from this process's job object and survives our exit. Under a SYSTEM Scheduled Task a
    # Start-Process child lives in the task's job object and is KILLED when this process exits — which
    # silently left the runner on the OLD code (the pull succeeded but the restart never landed).
    $pwshPath = (Get-Process -Id $PID).Path
    if (-not $pwshPath) { $pwshPath = (Get-Command pwsh -ErrorAction SilentlyContinue).Source }
    $self = Join-Path $PSScriptRoot 'Start-IamRunner.ps1'
    $qq = { param([string]$s) '"' + ($s -replace '"', '\"') + '"' }  # quote args (paths may have spaces)
    $cmd = (& $qq $pwshPath) + ' -NoProfile -ExecutionPolicy Bypass -File ' + (& $qq $self) +
           ' -AppUrl ' + (& $qq $AppUrl) + ' -AgentId ' + (& $qq $AgentId) +
           ' -PollSeconds ' + $PollSeconds + ' -BatchSize ' + $BatchSize +
           ' -ExoModuleVersion ' + (& $qq $ExoModuleVersion)
    # Forward an explicit -ApiToken (env is inherited; an explicit arg would otherwise be lost -> 401).
    if ($ApiToken) { $cmd += ' -ApiToken ' + (& $qq $ApiToken) }
    # WMI Win32_Process.Create is Windows-only and is needed specifically to break out of a SYSTEM
    # Scheduled Task's job object. On macOS/Linux (the central cloud runner) there's no CIM server —
    # calling it errors or stalls, which left the Mac stuck "updating" (pull ok, restart never landed).
    # So branch on platform: WMI on Windows, a plain detached relaunch everywhere else.
    if ($IsWindows) {
        try {
            $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop
            if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
            Write-Host "self-update: relaunched on new code (pid $($r.ProcessId))" -ForegroundColor Green
        }
        catch {
            Write-Warning "self-update relaunch via WMI failed ($($_.Exception.Message)); using Start-Process"
            Start-Process -FilePath $pwshPath -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-AppUrl',$AppUrl,'-AgentId',$AgentId,'-PollSeconds',$PollSeconds,'-BatchSize',$BatchSize,'-ExoModuleVersion',$ExoModuleVersion) | Out-Null
        }
    }
    else {
        # macOS/Linux: no job object to escape, so a detached child survives our exit. Pass args
        # explicitly (env is inherited, but an explicit -ApiToken arg would otherwise be lost).
        $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$self,'-AppUrl',$AppUrl,'-AgentId',$AgentId,'-PollSeconds',$PollSeconds,'-BatchSize',$BatchSize,'-ExoModuleVersion',$ExoModuleVersion)
        if ($ApiToken) { $a += @('-ApiToken',$ApiToken) }
        Start-Process -FilePath $pwshPath -ArgumentList $a | Out-Null
        Write-Host "self-update: relaunched on new code (Start-Process)" -ForegroundColor Green
    }
    exit 0
}

function Protect-CtgSecretsInText {
    # Redact brokered secret VALUES out of free text (a failure message) before it's posted to the
    # app — Job.error is persisted and shown in the run report + ServiceNow work note + audit, and a
    # failing API call can echo a key/token/password in its exception. Only values of secret-named
    # fields are scrubbed, so usernames/servers stay visible for diagnosis.
    param([string]$Text, [hashtable]$Creds)
    if ([string]::IsNullOrEmpty($Text) -or -not $Creds) { return $Text }
    foreach ($c in $Creds.Values) {
        if (-not $c -or -not $c.Fields) { continue }
        foreach ($k in @($c.Fields.Keys)) {
            if ($k -notmatch '(?i)pass|secret|key|token|credential') { continue }
            $v = [string]$c.Fields[$k]
            if ($v.Length -ge 4 -and $Text.Contains($v)) { $Text = $Text.Replace($v, '***') }
        }
    }
    return $Text
}

function Get-CtgBuildId {
    # This runner's build id = SHA-256 over its own files (raw bytes, ordinal-sorted POSIX relpaths),
    # truncated to 12 hex. EXACTLY the hash the app computes over the bundle it serves (lib/runner/
    # bundle.ts runnerBuildId), so the app can show "up to date" vs "update available" with no version
    # string to bump and no marker file to keep in sync. 'unknown' if anything goes wrong.
    $root = $PSScriptRoot
    $skip = 'tests', 'dist', '.git', 'node_modules'
    try {
        $rels = foreach ($f in Get-ChildItem -LiteralPath $root -Recurse -File) {
            $rel = ([System.IO.Path]::GetRelativePath($root, $f.FullName)) -replace '\\', '/'
            if ($rel.Split('/') | Where-Object { $skip -contains $_ }) { continue }
            # Skip runtime/non-bundle files (logs, build marker) — they aren't in the app's bundle, so
            # counting them makes the hash drift forever vs the app ("update available" that never clears).
            if ($f.Name -like '*.Tests.ps1' -or $f.Name -like '*.log' -or $f.Name -eq '.DS_Store' -or $f.Name -eq '.build' -or $f.Name -eq '.runner.lock') { continue }
            $rel
        }
        $arr = @($rels); [Array]::Sort($arr, [System.StringComparer]::Ordinal)
        $ms = New-Object System.IO.MemoryStream
        foreach ($rel in $arr) {
            $rb = [System.Text.Encoding]::UTF8.GetBytes($rel)
            $cb = [System.IO.File]::ReadAllBytes((Join-Path $root $rel))
            $ms.Write($rb, 0, $rb.Length); $ms.WriteByte(0); $ms.Write($cb, 0, $cb.Length); $ms.WriteByte(0)
        }
        $ms.Position = 0
        $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($ms)
        $ms.Dispose()
        return (-join ($h | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
    }
    catch { return 'unknown' }
}

function Invoke-CtgAdDiscovery {
    # Operator clicked "Refresh AD objects": read the DC's OUs + groups (read-only; the agent's own
    # domain context can read the directory — no brokered credential needed) and report them back so
    # the rules editor can offer real OU/group pickers instead of hand-typed DNs.
    if (-not (Get-Module -ListAvailable -Name ActiveDirectory)) { Write-Warning "AD discovery skipped — no ActiveDirectory module on this host"; return }
    try {
        $ous = @(Get-ADOrganizationalUnit -Filter * -ErrorAction Stop | Select-Object -ExpandProperty DistinguishedName)
        $groups = @(Get-ADGroup -Filter * -ErrorAction Stop | Select-Object -ExpandProperty Name)
        Invoke-AppApi POST '/api/agents/ad-objects' @{ agentId = $AgentId; ous = $ous; groups = $groups } | Out-Null
        Write-Host "AD discovery: reported $($ous.Count) OUs, $($groups.Count) groups" -ForegroundColor Green
    }
    catch {
        Write-Warning "AD discovery failed: $($_.Exception.Message)"
    }
}

function Get-JobCredential {
    # Push-down model: ask the app to broker secret $SecretName for this job. The app resolves the
    # VALUE from Delinea and returns the fields (Username/Password/Server/...), so the runner needs
    # no Delinea creds of its own. We rebuild the same shape the executors expect
    # (.Username/.Password/.Credential/.Fields) from those fields.
    param($JobId, $SecretName)
    $ref = Invoke-AppApi POST "/api/jobs/$JobId/credential" @{ agentId = $AgentId; secretName = $SecretName }
    # $ref.fields is a JSON object -> PSCustomObject; flatten to a hashtable.
    $fields = @{}
    if ($ref.fields) { foreach ($p in $ref.fields.PSObject.Properties) { $fields[$p.Name] = $p.Value } }
    # Treat an absent OR empty field set as unresolved — an empty {} is truthy in PS and would
    # otherwise slip through and surface much later as an opaque null-credential bind error.
    if ($fields.Count -eq 0) {
        $why = if ($ref.note) { $ref.note } else { "the app returned no secret fields" }
        throw "secret '$SecretName' was not resolved by the app — $why"
    }
    $username = $fields['Username']
    $password = if ($fields.ContainsKey('Password') -and $fields['Password']) {
        ConvertTo-SecureString ([string]$fields['Password']) -AsPlainText -Force
    } else { $null }
    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
    [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $fields }
}

function Get-ConnTestCredential {
    # Same push-down broker as Get-JobCredential, but for a connection test (no job). Rebuilds the
    # .Username/.Password/.Credential/.Fields shape the $DISPATCH Connect blocks expect.
    param($TestId, $SecretName)
    $ref = Invoke-AppApi POST "/api/runner/conn-tests/$TestId/credential" @{ agentId = $AgentId; secretName = $SecretName }
    $fields = @{}
    if ($ref.fields) { foreach ($p in $ref.fields.PSObject.Properties) { $fields[$p.Name] = $p.Value } }
    if ($fields.Count -eq 0) {
        $why = if ($ref.note) { $ref.note } else { "the app returned no secret fields" }
        throw "secret '$SecretName' was not resolved by the app — $why"
    }
    $username = $fields['Username']
    $password = if ($fields.ContainsKey('Password') -and $fields['Password']) { ConvertTo-SecureString ([string]$fields['Password']) -AsPlainText -Force } else { $null }
    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
    [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $fields }
}

# Which Graph permissions the M365 onboarder actually exercises, each satisfied by ANY of the listed
# scopes. Compared against the connection's GRANTED scopes (Get-MgContext) so the test can name the
# exact permission someone forgot to grant + admin-consent, instead of a bare "Insufficient privileges".
function Get-CtgGraphScopeGaps {
    param([string[]]$Granted)
    $req = @(
        @{ need = 'create / update users + assign licenses'; anyOf = @('User.ReadWrite.All', 'Directory.ReadWrite.All') }
        @{ need = 'add users to groups';                      anyOf = @('Group.ReadWrite.All', 'GroupMember.ReadWrite.All', 'Directory.ReadWrite.All') }
        @{ need = 'read licenses / groups (SKUs)';            anyOf = @('Organization.Read.All', 'Directory.Read.All', 'Directory.ReadWrite.All', 'User.Read.All', 'Group.Read.All') }
    )
    $gaps = @()
    foreach ($r in $req) {
        $have = $false
        foreach ($s in $r.anyOf) { if ($Granted -contains $s) { $have = $true; break } }
        if (-not $have) { $gaps += "$($r.need) — grant one of: $($r.anyOf -join ', ')" }
    }
    $gaps
}

# Connection-test probes: after Connect (auth), one cheap authorized READ proves real access — not
# just that the credential authenticates. The m365 probe ALSO diffs the granted Graph scopes against
# what onboarding needs, so a permissions gap is reported by name. Systems with a $DISPATCH Connect
# but no probe here are connect-only. AD/dir-sync have no session Connect, so their probe binds with
# the ad-dc credential. Extend freely — keep reads cheap + read-only.
$CONNTEST_PROBE = @{
    'm365'             = { param($job, $creds)
        $ctx = Get-MgContext
        $granted = @(); if ($ctx -and $ctx.Scopes) { $granted = @($ctx.Scopes) }
        $org = $null; try { $org = @(Get-MgOrganization -ErrorAction Stop)[0] } catch { }
        $base = if ($org) { "tenant: $($org.DisplayName)" } else { "connected" }
        if ($granted.Count -eq 0) { return "$base · connected (couldn't read granted scopes to verify permissions)" }
        $gaps = Get-CtgGraphScopeGaps $granted
        if ($gaps.Count) { throw "$base, but MISSING Graph permissions: $($gaps -join ' || '). Add these as APPLICATION permissions on the app registration and grant admin consent, then re-test." }
        "$base · all required Graph permissions present ($($granted.Count) granted)"
    }
    'exchange'         = { param($job, $creds) $o = Get-OrganizationConfig -ErrorAction Stop; "org: $($o.Name)" }
    'mimecast'         = { param($job, $creds)
        # Probe the actual operations onboarding needs and report which the API 2.0 app is permitted
        # to do — so "Test connections" shows the app's real permission map (Mimecast has no API to
        # list an app's granted permissions; this infers them from what works).
        $report = @()
        $try = {
            param($label, $path)
            try { Invoke-CtgMimecastApi -Path $path | Out-Null; "$($label): allowed" }
            catch { if ([string]$_.Exception.Message -match 'forbidden|not .{0,6}permitted|denied|unauthoriz|\b403\b') { "$($label): FORBIDDEN" } else { "$($label): error" } }
        }
        $report += & $try 'account read'           '/api/account/get-account'
        $report += & $try 'directory/domains read' '/api/domain/get-internal-domain'
        $report += & $try 'directory-sync read'    '/api/directory/get-connection'
        # USER read is what onboarding actually needs (get-profile). Probe a benign address in an
        # internal domain: FORBIDDEN = the missing permission; not-found = the permission IS granted.
        $dom = $null
        try { $idr = @(Invoke-CtgMimecastApi -Path '/api/domain/get-internal-domain'); $dom = @($idr | ForEach-Object { $d = Get-CtgProp $_ 'domain'; if (-not $d) { $d = Get-CtgProp $_ 'domainName' }; $d } | Where-Object { $_ })[0] } catch { }
        if ($dom) {
            try {
                $resp = Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{ emailAddress = "postmaster@$dom" } -AllowFail
                $codes = @(@(Get-CtgProp $resp 'fail') | ForEach-Object { @(Get-CtgProp $_ 'errors') | ForEach-Object { [string](Get-CtgProp $_ 'code') } })
                if (($codes -join ' ') -match 'forbidden|operation_forbidden') { $report += 'user read (get-profile): FORBIDDEN — THIS is the onboarding gap' }
                else { $report += 'user read (get-profile): allowed' }
            } catch { $report += 'user read (get-profile): error' }
        }
        $detail = "app permissions -> $($report -join ' | ')"
        # Fail the test (visibly red) when a permission onboarding needs is missing.
        if (($report -join ' ') -match 'FORBIDDEN') { throw $detail }
        $detail
    }
    'active-directory' = { param($job, $creds) $c = New-CtgAdConnection $creds; $d = Get-ADDomain @c -ErrorAction Stop; "domain: $($d.DNSRoot)" }
    'directory-sync'   = { param($job, $creds) $c = New-CtgAdConnection $creds; $d = Get-ADDomain @c -ErrorAction Stop; "AD reachable: $($d.DNSRoot)" }
}
$CONNTEST_PROBE['entra'] = $CONNTEST_PROBE['m365']  # entra is the M365 module's Entra slice — same Graph perms
# Cloud REST systems: after Connect (above), do one read so the test validates the credential +
# read scope against the live API (not just that Connect assembled an auth header).
$CONNTEST_PROBE['zoom']        = { param($job, $creds) Invoke-CtgZoomApi -Method GET -Path '/users?page_size=1' | Out-Null; 'zoom: users readable' }
$CONNTEST_PROBE['sentinelone'] = { param($job, $creds) Invoke-CtgSentinelOneApi -Method GET -Path '/web/api/v2.1/agents?limit=1' | Out-Null; 'sentinelone: agents readable' }
$CONNTEST_PROBE['xmatters']    = { param($job, $creds) Invoke-CtgXMattersApi -Method GET -Path '/people?limit=1' | Out-Null; 'xmatters: people readable' }

function Invoke-CtgConnectionTests {
    # Claim + run any queued connection tests for this agent. Fully isolated from the job pipeline:
    # connect with the brokered credential, run the read probe, report pass/fail + a one-line detail.
    $tests = @()
    try { $tests = Invoke-AppApi POST '/api/runner/conn-tests/claim' @{ agentId = $AgentId; max = 5 } } catch { return }
    # Flatten an exception chain to a one-line, secret-redacted message.
    $errLine = { param($e, $c) $ex = $e.Exception; $ch = [System.Collections.Generic.List[string]]::new(); while ($ex) { if ($ex.Message) { [void]$ch.Add($ex.Message) }; $ex = $ex.InnerException }; Protect-CtgSecretsInText (($ch | Select-Object -Unique) -join ' <- ') $c }
    foreach ($t in @($tests)) {
        $global:CtgProgressJobId = $null   # no job -> keep Connect's Set-CtgPhase from posting progress
        # TWO STAGES, reported separately: (1) ACCESS — can the runner resolve the secret(s) from the
        # app/Delinea; (2) API — connect + one live read against the vendor. A failed access skips API.
        $accessOk = $true; $accessDetail = ''
        $apiOk = $true; $apiDetail = ''
        $creds = @{}
        # Pass the system's config so a Connect that reads it (e.g. exchange's onPremExchangeUri) works
        # in the test. It's the whole ClientSystem.config (onboard/offboard sub-objects), not a lane.
        $job = [pscustomobject]@{ id = ''; systemKey = $t.systemKey; action = 'onboard'; config = $t.config; client = [pscustomobject]@{ slug = $t.clientSlug; primaryDomain = $t.primaryDomain } }

        try {
            $names = @(@($t.secretNames) | Where-Object { $_ })
            foreach ($sn in $names) { $creds[$sn] = Get-ConnTestCredential $t.id $sn }
            $accessDetail = if ($names.Count) { "resolved $($names.Count) secret$(if ($names.Count -ne 1) { 's' }): $($names -join ', ')" } else { 'no secret required' }
        }
        catch {
            $accessOk = $false; $accessDetail = & $errLine $_ $creds
            $apiOk = $false; $apiDetail = 'skipped — secret not resolved from Delinea'
        }

        if ($accessOk) {
            try {
                $handler = $DISPATCH[$t.systemKey]
                $probe = $CONNTEST_PROBE[$t.systemKey]
                $hasConnect = $handler -and $handler.ContainsKey('Connect')
                if (-not $hasConnect -and -not $probe) { throw "no automated connection test available for '$($t.systemKey)' — verify it manually" }
                if ($hasConnect) { & $handler.Connect $job $creds; $apiDetail = 'connected' }
                if ($probe) { $apiDetail = & $probe $job $creds }
            }
            catch { $apiOk = $false; $apiDetail = & $errLine $_ $creds }
            finally {
                # A conn-test connects OUTSIDE the cached-connection path — drop this system's cache key
                # so the next REAL job reconnects with its own tenant/creds (never reuses this session).
                if ($script:ConnectedTenant) { [void]$script:ConnectedTenant.Remove($t.systemKey) }
            }
        }
        try { Invoke-AppApi POST "/api/runner/conn-tests/$($t.id)/result" @{ agentId = $AgentId; accessOk = $accessOk; accessDetail = "$accessDetail"; ok = $apiOk; detail = "$apiDetail" } } catch { }
    }
}

function Invoke-CtgCloudGroupDiscovery {
    # Central runner only (the claim endpoint returns nothing to client agents). For each client that
    # requested it, connect to M365 with the brokered m365 secret and read the tenant's groups, tagged
    # DL / Security / M365 Group, so the app's pickers can offer cloud groups AD sync never covers.
    $work = @()
    try { $work = Invoke-AppApi POST '/api/runner/cloud-groups/claim' @{ agentId = $AgentId } } catch { return }
    foreach ($w in @($work)) {
        $global:CtgProgressJobId = $null
        try {
            # Rebuild $creds from the pushed fields (push-down model — no Delinea creds on the runner).
            $creds = @{}
            if ($w.creds) {
                foreach ($p in $w.creds.PSObject.Properties) {
                    $f = @{}
                    if ($p.Value.fields) { foreach ($q in $p.Value.fields.PSObject.Properties) { $f[$q.Name] = $q.Value } }
                    $username = $f['Username']
                    $password = if ($f.ContainsKey('Password') -and $f['Password']) { ConvertTo-SecureString ([string]$f['Password']) -AsPlainText -Force } else { $null }
                    $cred = if ($username -and $password) { [pscredential]::new([string]$username, $password) } else { $null }
                    $creds[$p.Name] = [pscustomobject]@{ Username = $username; Password = $password; Credential = $cred; Fields = $f }
                }
            }
            $job = [pscustomobject]@{ id = ''; systemKey = 'm365'; client = [pscustomobject]@{ slug = $w.clientSlug; primaryDomain = $w.primaryDomain } }
            & $DISPATCH['m365'].Connect $job $creds
            if ($script:ConnectedTenant) { [void]$script:ConnectedTenant.Remove('m365') }  # don't let a real job reuse this connection
            $groups = @()
            foreach ($g in (Get-MgGroup -All -Property 'DisplayName,GroupTypes,MailEnabled,SecurityEnabled' -ErrorAction Stop)) {
                $type = if ($g.GroupTypes -contains 'Unified') { 'm365' }
                        elseif ($g.MailEnabled -and -not $g.SecurityEnabled) { 'dl' }
                        else { 'security' }
                if ($g.DisplayName) { $groups += @{ name = [string]$g.DisplayName; type = $type } }
            }
            Invoke-AppApi POST '/api/runner/cloud-groups/result' @{ agentId = $AgentId; clientSlug = $w.clientSlug; groups = $groups }
            Write-Host "  cloud groups: reported $($groups.Count) for $($w.clientSlug)" -ForegroundColor Green
        } catch {
            Write-Warning "cloud group discovery failed for $($w.clientSlug): $($_.Exception.Message)"
        }
    }
}

# Build id of the code we're actually running = hash of our own files (matches the app's hash of the
# bundle it serves). Reported on every heartbeat → accurate even if a past restart half-landed, with
# no marker file to keep in sync.
$script:RunnerBuild = Get-CtgBuildId

# Single-instance guard. The newest runner process for this folder claims .runner.lock with its PID
# at startup; an OLDER process (e.g. one a half-landed self-update failed to replace) sees a different
# PID on its next loop and exits. Without this, a stale process keeps claiming jobs with OLD in-memory
# modules while a newer process reports the new build — "agent up to date but running old code", which
# silently ran outdated executors after an update. Lock I/O is best-effort (never fatal).
$script:LockPath = Join-Path $PSScriptRoot '.runner.lock'
try { [System.IO.File]::WriteAllText($script:LockPath, [string]$PID) } catch { }

Write-Host "iam-engine runner $AgentId (build $script:RunnerBuild, pid $PID) polling $AppUrl every ${PollSeconds}s" -ForegroundColor Cyan
# Per-process progress globals, read by Send-CtgProgress (callable from the Coretelligent.* modules).
$global:CtgProgressUrl   = $AppUrl
$global:CtgProgressToken = $ApiToken
$global:CtgProgressAgent = $AgentId
while ($true) {
    $jobs = @()   # reset BEFORE try: a heartbeat/claim throw must not leave a stale value driving the drain check below
    # Superseded by a newer instance? It overwrote .runner.lock with its PID at startup. Exit so this
    # (older) process stops heartbeating + claiming jobs with stale modules. Best-effort; on any lock
    # read error we just continue (fail open — better to keep running than to wrongly self-terminate).
    try {
        if (Test-Path -LiteralPath $script:LockPath) {
            $owner = ([System.IO.File]::ReadAllText($script:LockPath)).Trim()
            if ($owner -and $owner -ne [string]$PID) {
                Write-Warning "a newer runner instance (pid $owner) has taken over; exiting this one (pid $PID)."
                exit 0
            }
        }
    } catch { }
    try {
        $hb = Invoke-AppApi POST '/api/agents/heartbeat' @{ agentId = $AgentId; version = $script:RunnerBuild }
        if ($hb.enabled -eq $false) { Write-Warning "agent disabled server-side; stopping."; break }
        if ($hb.update -eq $true) { Update-CtgRunner }  # operator requested self-update — re-pull + restart (never returns)
        if ($hb.discover -eq $true) { Invoke-CtgAdDiscovery }  # operator requested AD OU/group discovery
        # Send our build id so the app refuses to dispatch to a STALE runner (a half-landed update can
        # leave an old process alive; this stops it claiming jobs with old modules in memory).
        $jobs = Invoke-AppApi POST '/api/jobs/claim' @{ agentId = $AgentId; batchSize = $BatchSize; version = $script:RunnerBuild }

        foreach ($job in @($jobs)) {
            $creds = @{}  # in scope for the catch's secret-scrub even if broking/execution throws early
            $script:Phase = 'starting'  # what we're doing now — the catch reports WHICH phase failed
            $global:CtgProgressJobId = $job.id  # so module-level Send-CtgProgress targets this job
            # A system with no per-user config (mimecast, spanning, …) is planned with config=null; the
            # executors take a [Mandatory] -Config, which a null fails to bind ("Cannot bind argument to
            # parameter 'Config' because it is null"). Normalize to an empty object — Get-CtgProp on it
            # just returns null for absent keys, so base onboarding runs.
            if ($null -eq $job.config) { $job.config = [pscustomobject]@{} }
            try {
                $handler = $DISPATCH[$job.systemKey]
                if (-not $handler) {
                    # No executor for this system: resolve as a manual follow-up, not a failure,
                    # so an uncovered `api` system doesn't kill the whole case.
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'skipped'; error = "no executor for $($job.systemKey) — manual follow-up" }
                    continue
                }
                $fn = if ($job.action -eq 'offboard') { $handler.Offboard } else { $handler.Onboard }
                if (-not $fn) {
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'skipped'; error = "no $($job.action) lane for $($job.systemKey) — manual follow-up" }
                    continue
                }

                # First thing the operator sees for this step — it has started.
                Set-CtgPhase $job.id "starting $($job.action) $($job.systemKey)"

                # Broker every secret the job names (least-privilege, one call each), keyed by name.
                Set-CtgPhase $job.id 'brokering credentials'
                foreach ($sn in @($job.secretNames)) { if ($sn) { $creds[$sn] = Get-JobCredential $job.id $sn } }

                # Connect before the first job for this system, and RE-connect whenever the job's
                # tenant OR its brokered credentials differ from what the module is currently
                # connected with (modules hold one connection; see $script:ConnectedTenant). The key
                # includes a fingerprint of the brokered secret fields so that (a) two clients that
                # both lack a primaryDomain but carry different secret TenantIds can NEVER share a
                # connection (the raw-domain key would collide on ''), and (b) rotating a credential
                # in Delinea reconnects on the very next job — no runner restart. Record the key ONLY
                # after Connect succeeds — a throw here (bad cred, unreachable on-prem Exchange,
                # transient) must NOT poison the cache, or every later job in this long-lived process
                # would skip Connect and run unconnected (e.g. "Get-RemoteMailbox not recognized").
                if ($handler.ContainsKey('Connect')) {
                    $tenant = if ($job.client) { $job.client.primaryDomain } else { '' }
                    $connectKey = "$tenant|$(Get-CtgCredFingerprint $creds)"
                    if ($script:ConnectedTenant[$job.systemKey] -ne $connectKey) {
                        Set-CtgPhase $job.id "connecting to $($job.systemKey)"
                        & $handler.Connect $job $creds
                        $script:ConnectedTenant[$job.systemKey] = $connectKey
                    }
                }

                # Verify pass: run ONLY the read-only validator (Confirm-Ctg*), no executor/mutation.
                if ([bool]$job.validateOnly) {
                    Set-CtgPhase $job.id "verifying $($job.systemKey)"
                    $vfn = $handler.Validate
                    $vbody = @{ agentId = $AgentId; status = 'succeeded' }
                    if ($vfn) {
                        $validation = & $vfn $job $creds
                        if ($null -ne $validation) { $vbody.validation = $validation }
                    } else {
                        # No validator: report a passing validation, NOT a result — posting a result
                        # here would REPLACE the executor's stored result (and its WARN action lines)
                        # when the auto-verify sweep re-runs a succeeded job.
                        $vbody.validation = @{ ok = $true; checks = @(@{ name = 'no validator for this system — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
                    }
                    Invoke-AppApi POST "/api/jobs/$($job.id)/result" $vbody
                    continue
                }

                $dryRun = [bool]$job.dryRun
                Set-CtgPhase $job.id "$($job.action) $($job.systemKey)$(if ($dryRun) { ' (dry run)' })"
                # Self-heal once: if execution fails because a cmdlet's module isn't installed, find +
                # install it (trusted modules only) and retry — so a missing Graph/EXO submodule fixes
                # itself instead of failing the step.
                $outcome = $null
                for ($try = 0; $try -lt 2; $try++) {
                    try { $outcome = Invoke-JobWithValidation -Job $job -Handler $handler -Fn $fn -Creds $creds -DryRun $dryRun; break }
                    catch {
                        $missing = Get-CtgMissingCommandName $_
                        # A missing '*-Ctg*' function is one of OUR bundled module functions — it means
                        # the Coretelligent.* module didn't load on this host (a missing host dependency),
                        # NOT a gallery module to install. Surface a clear, actionable error instead.
                        if ($missing -like '*-Ctg*') {
                            throw "the Coretelligent module providing '$missing' isn't loaded on this host — it needs a host-specific dependency (the ActiveDirectory/RSAT module for AD, ExchangeOnlineManagement for Exchange, the ADSync module for directory-sync). This step must run on the client-network agent that has it, not the central/cloud runner."
                        }
                        if ($try -eq 0 -and $missing) {
                            Set-CtgPhase $job.id "missing command '$missing' — locating + installing its module"
                            $mod = Repair-CtgMissingModule $missing
                            if ($mod) { Set-CtgPhase $job.id "installed $mod — retrying $($job.systemKey)"; continue }
                        }
                        throw
                    }
                }
                $body = @{ agentId = $AgentId; status = 'succeeded'; result = $outcome.Result }
                if ($null -ne $outcome.Validation) { $body.validation = $outcome.Validation }
                # Surface the module's evidence snapshot (e.g. group memberships captured before an
                # offboard removes them) so it's persisted with the job and shown in the run report.
                if ($outcome.Result -and $outcome.Result.PSObject.Properties['Evidence'] -and $null -ne $outcome.Result.Evidence) {
                    $body.evidence = $outcome.Result.Evidence
                }
                Invoke-AppApi POST "/api/jobs/$($job.id)/result" $body
            }
            catch {
                # Walk the FULL inner-exception chain (deduped) so the real cause surfaces — a generic
                # outer like "Authentication failed, see inner exception" usually wraps the actual
                # logon/LDAP error (e.g. "The user name or password is incorrect", "account locked").
                $chain = [System.Collections.Generic.List[string]]::new()
                $ex = $_.Exception
                while ($ex) { if ($ex.Message) { [void]$chain.Add($ex.Message) }; $ex = $ex.InnerException }
                $msg = (($chain | Select-Object -Unique) -join ' <- ')
                if (-not $msg) { $msg = $_.Exception.GetType().Name }
                # A Graph "Insufficient privileges" tells you nothing about WHICH permission is missing.
                # Always append the permission the FAILING PHASE needs (reliable across auth modes), and
                # refine it with the precise gap from granted scopes when we can read them. Best-effort —
                # never let this enrichment break the real error report.
                if (($job.systemKey -in @('m365', 'entra')) -and ($msg -match 'Insufficient privileges|Authorization_RequestDenied|Access(Denied| is denied)')) {
                    $ph = [string]$script:Phase
                    $need = if ($ph -match 'group') { 'Group.ReadWrite.All (or GroupMember.ReadWrite.All)' }
                            elseif ($ph -match 'licen') { 'User.ReadWrite.All + Organization.Read.All' }
                            elseif ($ph -match 'user|creat|onboard|attribute|disable') { 'User.ReadWrite.All' }
                            else { 'User.ReadWrite.All, Group.ReadWrite.All, Organization.Read.All' }
                    $hint = "the app registration is missing a Graph APPLICATION permission for this step ($ph) — grant + admin-consent: $need"
                    try {
                        $ctx = Get-MgContext
                        $granted = @(); if ($ctx -and $ctx.Scopes) { $granted = @($ctx.Scopes) }
                        if ($granted.Count -gt 0) {
                            $gaps = Get-CtgGraphScopeGaps $granted
                            if ($gaps.Count) { $hint = "missing Graph permission(s): $($gaps -join ' || '). Grant + admin-consent (Application permissions on the app registration)." }
                        }
                    } catch { }
                    $msg += " — $hint"
                }
                # Name the phase that failed ("while connecting to on-prem Exchange (…): Unauthorized")
                # so the operator sees WHAT broke, not just the bare provider message.
                $where = if ($script:Phase) { " while $($script:Phase)" } else { "" }
                # Scrub any brokered secret value the exception may have echoed before it's persisted.
                $err = Protect-CtgSecretsInText "[$($job.systemKey)]$($where): $msg" $creds
                Write-Warning "job $($job.id) failed: $err"
                Write-CtgLog -Level ERROR -Message "job $($job.id) [$($job.systemKey)] $($job.action) FAILED: $err"
                Invoke-AppApi POST "/api/jobs/$($job.id)/result" @{ agentId = $AgentId; status = 'failed'; error = $err }
            }
            finally { $global:CtgProgressJobId = $null }  # don't let a stray post target a finished job
        }

        # Separate, isolated lane: operator-requested connection/permission tests (cloud here on the
        # central runner; on-prem on the client agent). Never affects the job pipeline above.
        Invoke-CtgConnectionTests
        Invoke-CtgCloudGroupDiscovery
    }
    catch {
        Write-Warning "poll cycle error: $($_.Exception.Message)"
        Write-CtgLog -Level WARN -Message "poll cycle error: $($_.Exception.Message)"
    }
    # Drain: if this cycle claimed work, more may have just unblocked (dependency chains, an
    # operator's re-run) — poll again immediately and only sleep once the queue is empty.
    if (@($jobs).Count -eq 0) { Start-Sleep -Seconds $PollSeconds }
}
