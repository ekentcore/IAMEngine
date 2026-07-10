#Requires -Version 7.0

# Coretelligent.M365
# Shared system module — written once, reused by every client.
# Depends on the Microsoft.Graph SDK. Required delegated/app scopes:
#   User.ReadWrite.All, Group.ReadWrite.All, Organization.Read.All
#
# Public surface:
#   Connect-CtgM365            - establish a Graph session from a credential
#   New-CtgCompliantPassword   - generate a policy-compliant initial password
#   Resolve-CtgSkuId           - license name/part-number -> tenant SkuId
#   Invoke-CtgM365Onboarding   - idempotent: user + licenses + groups + alias
#   Invoke-CtgM365Offboarding  - idempotent: block sign-in + groups + license teardown
#
# Everything is idempotent: safe to re-run after a partial failure.

Set-StrictMode -Version Latest

#region internal helpers ------------------------------------------------------

function Get-CtgRandomInt {
    param([Parameter(Mandatory)][int]$ExclusiveMax)
    # Cryptographically strong, unbiased.
    [System.Security.Cryptography.RandomNumberGenerator]::GetInt32($ExclusiveMax)
}

function Get-CtgRandomChar {
    param([Parameter(Mandatory)][string]$Set)
    $Set[(Get-CtgRandomInt $Set.Length)]
}

# Safe property read under StrictMode: $null if the member/key is absent.
function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    # IDictionary (not just [hashtable]) so it also reads the Graph SDK's AdditionalProperties, which
    # is a generic Dictionary[string,object] — [hashtable] alone returned $null for every key there
    # (blank group names, broken on-prem/dynamic filters).
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Add a user to a group, tolerating Entra's eventual consistency right after a hybrid sync: a
# just-synced user can briefly be unqueryable for group ops ("...reference-property objects are not
# present"). Retries with backoff; "already a member" counts as success. Returns $null on success or
# the error message on persistent failure, so the caller records a visible WARN instead of letting a
# raw Graph error dump to the console while the step still reports "verified".
# Narrate into the live run-report progress (Send-CtgProgress is the runner's global poster; absent
# under Pester, so guard it). Narration must never change behaviour.
function Write-CtgM365Step([string]$Message) {
    if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress $Message }
}

function Add-CtgGroupMember {
    param([Parameter(Mandatory)][string]$GroupId, [Parameter(Mandatory)][string]$UserId, [int]$Retries = 3)
    # Distinguish a missing GROUP (a stale/wrong configured id — a config error, no point retrying)
    # from the user not yet being replicated in Entra. The Graph "Resource ... does not exist" message
    # is the same for both, so check the group up front. Only a genuine 404 is a config error — a
    # transient failure falls through to the add attempt (which retries), not a false "not found".
    try { $null = Get-MgGroup -GroupId $GroupId -ErrorAction Stop }
    catch {
        if ($_.Exception.Message -match 'NotFound|does not exist|ResourceNotFound|\b404\b') {
            return "group '$GroupId' not found in Entra — the configured group id is wrong or the group was deleted"
        }
        # transient (throttle/network) — proceed; New-MgGroupMember below has its own retry.
    }
    $last = $null
    for ($i = 0; $i -lt $Retries; $i++) {
        try { New-MgGroupMember -GroupId $GroupId -DirectoryObjectId $UserId -ErrorAction Stop; return $null }
        catch {
            $last = $_.Exception.Message
            if ($last -match 'already exist|references already exist') { return $null }   # idempotent: already a member
            # Group exists (checked above), so a "not present" now means the USER hasn't replicated yet.
            if ($i -lt $Retries - 1 -and $last -match 'does not exist|not present|ResourceNotFound') {
                if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress "group add: user not yet replicated in Entra — retrying in 15s ($($i + 2)/$Retries)" }
                Start-Sleep -Seconds 15
            } else { break }
        }
    }
    return $last
}

# Resolve a reference user in Entra by UPN, then displayName as a fallback.
function Resolve-CtgEntraUser {
    # Find a reference user (mirror / manager) from whatever the intake carries. Prefer an EMAIL/UPN —
    # the one identifier that's stable between ServiceNow and 365 — then fall back to the display name,
    # trying parenthetical-nickname variants because SNOW often shows "James (Jim) Goodmiller" while 365
    # shows "Jim Goodmiller". Returns the Graph user or $null.
    param([Parameter(Mandatory)][string]$Identity)
    $id = ([string]$Identity).Trim()
    if (-not $id) { return $null }
    $esc = { param($s) ($s -replace "'", "''") }

    # 1. Email / UPN — exact, stable.
    if ($id -match '@') {
        $e = & $esc $id
        $u = Get-MgUser -Filter "userPrincipalName eq '$e' or mail eq '$e'" -Top 1 -ErrorAction SilentlyContinue
        if ($u) { return $u }
    }

    # 2. Display-name variants: as given, parens stripped ("James Goodmiller"), and the nickname
    #    substituted for the first name ("Jim Goodmiller").
    $variants = [System.Collections.Generic.List[string]]::new()
    $variants.Add($id)
    if ($id -match '\(([^)]+)\)') {
        $nick = $Matches[1].Trim()
        $stripped = ((($id -replace '\s*\([^)]*\)\s*', ' ').Trim()) -replace '\s+', ' ')
        $variants.Add($stripped)
        $rest = ($stripped -replace '^\S+\s*', '').Trim()   # surname(s) after the first word
        if ($nick -and $rest) { $variants.Add("$nick $rest") }
    }
    foreach ($v in @($variants | Where-Object { $_ } | Select-Object -Unique)) {
        $e = & $esc $v
        $u = Get-MgUser -Filter "displayName eq '$e'" -Top 1 -ErrorAction SilentlyContinue
        if ($u) { return $u }
    }
    $null
}

# Mirror the reference user's CLOUD-ONLY Entra groups onto the new user — the piece that "mirror
# <user>" misses for hybrid clients. AD-synced groups are managed on-prem (the AD lane's mirror
# handles them and Graph can't edit them) and dynamic-membership groups can't be assigned, so both
# are skipped. This is what pulls in cloud licensing groups (e.g. "APP - M365 E3"), distribution and
# M365 groups. Returns an actions array.
function Invoke-CtgM365CloudMirror {
    param([Parameter(Mandatory)][string]$MirrorUser, [Parameter(Mandatory)][string]$UserId)
    $actions = [System.Collections.Generic.List[string]]::new()
    $ref = Resolve-CtgEntraUser -Identity $MirrorUser
    if (-not $ref) { $actions.Add("WARN mirror user not found in Entra: $MirrorUser"); return $actions.ToArray() }

    Write-CtgM365Step "mirroring cloud groups from $($ref.UserPrincipalName)"
    $refGroups = @(Get-MgUserMemberOf -UserId $ref.Id -All -ErrorAction SilentlyContinue)
    $mine = @(Get-MgUserMemberOf -UserId $UserId -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $copied = 0; $skipped = 0; $exch = 0
    foreach ($mg in $refGroups) {
        $ap = $mg.AdditionalProperties
        $otype = [string](Get-CtgProp $ap '@odata.type')
        if ($otype -and $otype -notmatch 'microsoft\.graph\.group') { continue }              # only groups (not roles/AUs)
        $gname = [string](Get-CtgProp $ap 'displayName'); if (-not $gname) { $gname = $mg.Id }
        if ((Get-CtgProp $ap 'onPremisesSyncEnabled') -eq $true) { $skipped++; Write-CtgM365Step "– on-prem group (AD lane owns it): $gname"; continue }
        if (@(Get-CtgProp $ap 'groupTypes') -contains 'DynamicMembership') { $skipped++; Write-CtgM365Step "– dynamic group (rule-based): $gname"; continue }
        # Distribution lists + mail-enabled security groups are managed in Exchange, NOT Graph —
        # New-MgGroupMember errors on them. Unified (M365) groups ARE mail-enabled but Graph-addable.
        $mailEnabled = (Get-CtgProp $ap 'mailEnabled') -eq $true
        $isUnified = @(Get-CtgProp $ap 'groupTypes') -contains 'Unified'
        if ($mailEnabled -and -not $isUnified) {
            # Graph can't write distribution lists / mail-enabled security groups — the EXCHANGE step
            # does. But Graph can READ them, so confirm whether the user is already a member (i.e. the
            # exchange lane already added it) instead of leaving an ambiguous "needs Exchange".
            $exch++
            if ($mine -contains $mg.Id) { $actions.Add("distribution/mail-enabled '$gname' — already added by the Exchange step"); Write-CtgM365Step "✓ $gname — distribution, already added (Exchange step)" }
            else { $actions.Add("distribution/mail-enabled '$gname' — added by the Exchange step (Graph can't); not present yet"); Write-CtgM365Step "↷ $gname — distribution, handled by the Exchange step" }
            continue
        }
        if ($mine -contains $mg.Id) { $actions.Add("already in group: $gname"); Write-CtgM365Step "– already a member: $gname"; continue }
        $err = Add-CtgGroupMember -GroupId $mg.Id -UserId $UserId
        if ($err) {
            # If Graph rejects because the group is AD-synced / read-only (a memberOf response that
            # didn't carry onPremisesSyncEnabled, so the skip above missed it), treat it as a skip,
            # not a warning — the AD lane owns that group.
            if ($err -match 'synchroni[sz]ed|on-?prem|cannot be (modified|updated)|not allowed|RequestDenied') {
                $skipped++; $actions.Add("skipped on-prem/read-only group: $gname"); Write-CtgM365Step "↷ skipped on-prem/read-only group: $gname"
            } else {
                $actions.Add("WARN mirror group '$gname': $err"); Write-CtgM365Step "✗ mirror group: $gname — $err"
            }
        }
        else { $actions.Add("mirrored cloud group: $gname"); Write-CtgM365Step "✓ mirrored cloud group: $gname"; $copied++ }
    }
    $actions.Add("cloud mirror from ${MirrorUser}: $copied added, $skipped skipped (on-prem/dynamic)$(if ($exch) { ", $exch need Exchange (distribution/mail-enabled)" })")
    return $actions.ToArray()
}

# Friendly license name -> Entra SkuPartNumber, for the SKUs that appear in client profiles.
# Unknown names fall through to a direct SkuPartNumber match against the tenant.
$script:LicenseSkuMap = @{
    'microsoft 365 e3'                                = 'SPE_E3'
    'microsoft 365 e5'                                = 'SPE_E5'
    'microsoft 365 f3'                                = 'SPE_F1'
    'microsoft 365 business premium'                  = 'SPB'
    'microsoft 365 business standard'                 = 'O365_BUSINESS_PREMIUM'
    'microsoft 365 business basic'                    = 'O365_BUSINESS_ESSENTIALS'
    'office 365 e1'                                   = 'STANDARDPACK'
    'office 365 e3'                                   = 'ENTERPRISEPACK'
    'office 365 e5'                                   = 'ENTERPRISEPREMIUM'
    'microsoft entra id p1'                           = 'AAD_PREMIUM'
    'microsoft entra id p2'                           = 'AAD_PREMIUM_P2'
    'microsoft defender for office 365 (plan 1)'      = 'ATP_ENTERPRISE'
    'microsoft defender for office 365 (plan 2)'      = 'THREAT_INTELLIGENCE'
    'exchange online (plan 1)'                        = 'EXCHANGESTANDARD'
    'exchange online (plan 2)'                        = 'EXCHANGEENTERPRISE'
    'microsoft teams phone standard'                  = 'MCOEV'
    'microsoft teams domestic calling plan'           = 'MCOPSTN1'
    'microsoft teams audio conferencing'              = 'MCOMEETADV'
    'microsoft intune plan 1'                         = 'INTUNE_A'
    'power bi pro'                                     = 'POWER_BI_PRO'
    'project plan 3'                                  = 'PROJECTPROFESSIONAL'
    'visio plan 2'                                    = 'VISIOCLIENT'
}

#endregion

function Invoke-CtgM365Write {
    # Retry a Graph WRITE on transient tenant errors — ConcurrencyViolation (overlapping writes to
    # the same tenant, e.g. two onboardings at once) and throttling (429/503) — with backoff. The
    # M365 executors are idempotent, so a retried write is safe. Non-transient errors (e.g. no
    # available license seats) re-throw immediately so their handlers still see them.
    param([Parameter(Mandatory)][scriptblock]$Operation, [int]$MaxAttempts = 4)
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try { return (& $Operation) }
        catch {
            $msg = "$($_.Exception.Message)"
            $transient = $msg -match 'ConcurrencyViolation|concurrent requests|TooManyRequests|throttl|\b429\b|\b503\b|ServiceUnavailable|temporarily'
            if (-not $transient -or $attempt -ge $MaxAttempts) { throw }
            $delay = [int][Math]::Min(8, [Math]::Pow(2, $attempt))  # 2, 4, 8s
            if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress "tenant busy (concurrent/throttled) — retrying in ${delay}s ($($attempt + 1)/$MaxAttempts)" }
            Start-Sleep -Seconds $delay
        }
    }
}

function Resolve-CtgSkuId {
    <#
    .SYNOPSIS
        Resolve a license spec to a tenant SkuId. Accepts an explicit { skuId } object, a raw
        SkuPartNumber, or a friendly name (e.g. "Microsoft 365 E3"). Returns $null if the tenant
        does not have a matching subscribed SKU (caller logs a WARN rather than failing the job).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)]$License)

    $explicit = Get-CtgProp $License 'skuId'
    if ($explicit) { return $explicit }

    $name = if ($License -is [string]) { $License } else { Get-CtgProp $License 'name' }
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }

    $skus = @(Get-MgSubscribedSku -All -ErrorAction SilentlyContinue)
    $direct = $skus | Where-Object { $_.SkuPartNumber -ieq $name } | Select-Object -First 1
    if ($direct) { return $direct.SkuId }

    $part = $script:LicenseSkuMap[$name.ToLower()]
    if ($part) {
        $mapped = $skus | Where-Object { $_.SkuPartNumber -ieq $part } | Select-Object -First 1
        if ($mapped) { return $mapped.SkuId }
    }
    return $null
}

function Get-CtgM365LicenseInventory {
    <#
    .SYNOPSIS
        The tenant's license inventory for the seat-shortage picker: each owned SKU with its free
        seat count (available = prepaid enabled - consumed). Only SKUs with >0 prepaid seats; the
        most-available first. Friendly name from the reverse of LicenseSkuMap, else the part number.
    #>
    $rev = @{}
    foreach ($k in $script:LicenseSkuMap.Keys) { $p = $script:LicenseSkuMap[$k]; if (-not $rev.ContainsKey($p)) { $rev[$p] = $k } }
    @(Get-MgSubscribedSku -All -ErrorAction SilentlyContinue | ForEach-Object {
        # StrictMode-safe reads — Graph mocks (and trimmed responses) may omit these properties.
        $pp       = Get-CtgProp $_ 'PrepaidUnits'
        $enabled  = if ($pp) { [int](Get-CtgProp $pp 'Enabled') } else { 0 }
        $consumed = [int](Get-CtgProp $_ 'ConsumedUnits')
        $part     = [string](Get-CtgProp $_ 'SkuPartNumber')
        [pscustomobject]@{
            skuId         = [string](Get-CtgProp $_ 'SkuId')
            skuPartNumber = $part
            name          = if ($rev.ContainsKey($part)) { (Get-Culture).TextInfo.ToTitleCase($rev[$part]) } else { $part }
            enabled       = $enabled
            consumed      = $consumed
            available     = [Math]::Max(0, $enabled - $consumed)
        }
    }) | Where-Object { $_.enabled -gt 0 } | Sort-Object -Property @{ Expression = 'available'; Descending = $true }, skuPartNumber
}

# Seat-aware E5/E3 fallback (the internal script's rule): read LIVE SKU consumption — a decision the
# planner can't make — and add the user to the E5 Entra group when a seat is free, else fall back to
# E3. Config.seatAwareLicense: { skuId, entraGroupWhenAvailable, entraGroupFallback?, adGroupFallback? }.
# Returns the chosen Tier + (when the fallback is an AD group the M365 lane can't touch) the AD group
# name for the runner to hand to the active-directory lane.
function Set-CtgSeatAwareLicense {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$UserId, [Parameter(Mandatory)]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $sku = Get-MgSubscribedSku -SubscribedSkuId (Get-CtgProp $Config 'skuId') -ErrorAction SilentlyContinue
    $enabled = [int](Get-CtgProp (Get-CtgProp $sku 'PrepaidUnits') 'Enabled')
    $consumed = [int](Get-CtgProp $sku 'ConsumedUnits')
    $available = $enabled - $consumed
    $fallbackAdGroup = $null

    if ($sku -and $available -gt 0) {
        $tier = 'E5'
        $g = Get-CtgProp $Config 'entraGroupWhenAvailable'
        if ($g -and $PSCmdlet.ShouldProcess($UserId, "Add to E5 group $g")) {
            $err = Add-CtgGroupMember -GroupId $g -UserId $UserId
            if ($err) { $actions.Add("WARN could not add to E5 Entra group: $err") }
            else { $actions.Add("E5 seat available ($available) — added to E5 Entra group") }
        }
    }
    else {
        $tier = 'E3'
        $eg = Get-CtgProp $Config 'entraGroupFallback'
        if ($eg) {
            if ($PSCmdlet.ShouldProcess($UserId, "Add to E3 group $eg")) {
                $err = Add-CtgGroupMember -GroupId $eg -UserId $UserId
                if ($err) { $actions.Add("WARN could not add to E3 Entra group: $err") }
                else { $actions.Add("no E5 seat — added to E3 Entra group") }
            }
        }
        else {
            $fallbackAdGroup = Get-CtgProp $Config 'adGroupFallback'
            $actions.Add("no E5 seat — fall back to AD group: $fallbackAdGroup")
        }
    }
    [pscustomobject]@{ Tier = $tier; FallbackAdGroup = $fallbackAdGroup; Actions = $actions.ToArray() }
}

function New-CtgCompliantPassword {
    <#
    .SYNOPSIS
        Generate a random password that is guaranteed to satisfy the policy.
    .DESCRIPTION
        Guarantees at least one character from each required class, then fills
        the remainder from the combined pool and shuffles with a crypto RNG.
        Ambiguous characters (I, l, 1, O, 0) are excluded to reduce help-desk
        callbacks when a user has to type the temporary credential.
    .OUTPUTS
        System.Security.SecureString
    #>
    [CmdletBinding()]
    [OutputType([securestring])]
    param(
        [int]$MinLength      = 14,
        [bool]$RequireUpper  = $true,
        [bool]$RequireLower  = $true,
        [bool]$RequireNumber = $true,
        [bool]$RequireSpecial= $true
    )

    $upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ'   # no I, O
    $lower   = 'abcdefghijkmnpqrstuvwxyz'   # no l, o
    $number  = '23456789'                   # no 0, 1
    $special = '!@#$%^&*-_=+?'

    $required = [System.Collections.Generic.List[char]]::new()
    $poolBuilder = [System.Text.StringBuilder]::new()

    if ($RequireUpper)   { $required.Add((Get-CtgRandomChar $upper));   [void]$poolBuilder.Append($upper) }
    if ($RequireLower)   { $required.Add((Get-CtgRandomChar $lower));   [void]$poolBuilder.Append($lower) }
    if ($RequireNumber)  { $required.Add((Get-CtgRandomChar $number));  [void]$poolBuilder.Append($number) }
    if ($RequireSpecial) { $required.Add((Get-CtgRandomChar $special)); [void]$poolBuilder.Append($special) }

    $pool = $poolBuilder.ToString()
    if ([string]::IsNullOrEmpty($pool)) { throw "At least one character class must be required." }

    $length = [Math]::Max($MinLength, $required.Count)
    $chars = [System.Collections.Generic.List[char]]::new($required)
    while ($chars.Count -lt $length) { $chars.Add((Get-CtgRandomChar $pool)) }

    # Fisher–Yates shuffle so the guaranteed chars aren't predictably positioned.
    for ($i = $chars.Count - 1; $i -gt 0; $i--) {
        $j = Get-CtgRandomInt ($i + 1)
        ($chars[$i], $chars[$j]) = ($chars[$j], $chars[$i])
    }

    ConvertTo-SecureString (-join $chars) -AsPlainText -Force
}

function Connect-CtgM365 {
    <#
    .SYNOPSIS
        Connect to Microsoft Graph using a credential resolved from Delinea.
    .PARAMETER Credential
        App registration credential. UserName = client/app id, Password = secret.
    .PARAMETER TenantId
        Entra tenant id or verified domain.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscredential]$Credential,
        [Parameter(Mandatory)][string]$TenantId
    )
    # Client-secret flow shown for brevity; prefer certificate auth in production.
    Connect-MgGraph -TenantId $TenantId -ClientSecretCredential $Credential -NoWelcome
    Write-Verbose "Connected to Graph for tenant $TenantId."
}

function Resolve-CtgM365User {
    # Look up a user by UPN, distinguishing a GENUINE absence ($null) from a TRANSIENT Graph error
    # (throttle 429 / 5xx / timeout). A plain `Get-MgUser -ErrorAction SilentlyContinue` swallows the
    # transient case and returns $null too — which makes the onboarder think the user doesn't exist
    # (so it skips the marker/adopt logic and tries to CREATE) and makes the validator false-report
    # "user exists = false". We retry transient errors and, if they persist, THROW rather than guess.
    # -Upn is NOT [Mandatory]: an empty value would throw the opaque "Cannot bind argument to
    # parameter 'Upn' because it is an empty string". Return $null (genuinely absent) instead.
    param([string]$Upn, [string[]]$Property = @('Id', 'DisplayName', 'AccountEnabled', 'OnPremisesExtensionAttributes'))
    if ([string]::IsNullOrWhiteSpace($Upn)) { return $null }
    for ($i = 0; $i -lt 4; $i++) {
        if ($i) { Start-Sleep -Seconds (2 * $i) }
        try { return (Get-MgUser -UserId $Upn -Property $Property -ErrorAction Stop) }
        catch {
            $m = [string]$_.Exception.Message
            if ($m -match 'Request_ResourceNotFound|ResourceNotFound|does not exist|\bNotFound\b|\b404\b') { return $null }  # genuinely absent
            if ($i -eq 3) { throw "Graph lookup of '$Upn' kept failing (transient — throttle/timeout): $m" }  # never assume "absent" on a transient error
        }
    }
    $null
}

# The offboard target's UPN: from the case when present, else by DISPLAY NAME via Graph (exactly-one
# match wins; 0/many -> ''). Used by the offboard executor AND the validator so they resolve the SAME
# user — a validator that resolved differently would always "miss" and trigger the re-run loop.
function Resolve-CtgM365Upn {
    param([pscustomobject]$User)
    $upn = [string]$User.UserPrincipalName
    if (-not [string]::IsNullOrWhiteSpace($upn)) { return $upn }
    $dn = [string](Get-CtgProp $User 'DisplayName')
    if (-not $dn) { return '' }
    $dnEsc = $dn -replace "'", "''"   # escape quotes so a name like "Sean O'Brien" can't break the OData filter
    $byName = @(Get-MgUser -Filter "displayName eq '$dnEsc'" -All -ErrorAction SilentlyContinue)
    if ($byName.Count -eq 1) { return [string]((Get-CtgProp $byName[0] 'UserPrincipalName') ?? '') }
    return ''
}

function Get-CtgM365UserDevices {
    # The user's Entra-registered devices as @(@{ Id; DisplayName }). UserId is a UPN or object id.
    # This is the single source of machine names for the endpoint-containment steps (SentinelOne
    # isolate, the AD computer-object disable) — they call this with the SAME user so they act on the
    # SAME machines the offboard captured. Empty array when none / unresolved (never throws here).
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$UserId)
    if ([string]::IsNullOrWhiteSpace($UserId)) { return @() }
    $devices = @(Get-MgUserRegisteredDevice -UserId $UserId -All -ErrorAction SilentlyContinue) |
        Where-Object { (Get-CtgProp $_.AdditionalProperties '@odata.type') -eq '#microsoft.graph.device' }
    @(foreach ($d in $devices) { [pscustomobject]@{ Id = $d.Id; DisplayName = (Get-CtgProp $d.AdditionalProperties 'displayName') } })
}

function Invoke-CtgM365Onboarding {
    <#
    .SYNOPSIS
        Idempotently provision a user in Microsoft 365.
    .PARAMETER User
        Normalized user object: FirstName, LastName, DisplayName,
        UserPrincipalName, MobilePhone, JobTitle, UsageLocation.
    .PARAMETER Config
        The 'config' block from the m365 system entry in the client profile.
    .PARAMETER InitialPassword
        SecureString produced by New-CtgCompliantPassword.
    .OUTPUTS
        Result object with Status and an Actions log.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][securestring]$InitialPassword,
        [bool]$RequireChangeAtSignIn = $true
    )

    $actions = [System.Collections.Generic.List[string]]::new()
    $upn = $User.UserPrincipalName

    # 1. Choose a username + ensure the user exists ----------------------------
    # The username is the PRIMARY pattern (e.g. first.last); if that UPN is already taken by a
    # DIFFERENT person, fall through to the configured fallback patterns (e.g. first.mi), in order.
    # To tell a re-run (OUR account) from a same-name COLLISION (a different person), we stamp a
    # provisioning MARKER (onPremisesExtensionAttributes.extensionAttribute1) on accounts we create
    # and match on it — NOT on display name, so two "John Smith"s never get cross-assigned. (employeeId
    # is NOT usable for this: Entra caps it at 16 chars, so an email/"ctg:Name|date" marker is rejected
    # with "invalid value specified for property 'employeeId'".) We only ever write the attribute on
    # accounts we provision, so a stranger's value is never clobbered. Direct GET by UPN is strongly consistent;
    # the filter query is a post-create-lag fallback.
    if ([string]::IsNullOrWhiteSpace($upn)) {
        throw "no username could be derived for this user — the client's primary domain is missing. Set the client's domain, then re-run."
    }
    $marker = [string](Get-CtgProp $User 'PersonalEmail')
    if ([string]::IsNullOrWhiteSpace($marker)) { $marker = "ctg:$([string]$User.DisplayName)|$([string](Get-CtgProp $User 'StartDate'))" }
    $candidates = @(@($upn) + @(Get-CtgProp $User 'UserPrincipalNameFallbacks') | Where-Object { $_ })
    # Drop malformed candidates — a "{first}.{mi}" pattern with no middle initial yields "felix."
    # (leading/trailing/double separator in the local part), which Entra rejects on the UPN AND the
    # mailNickname. Belt-and-suspenders: the app now omits these, but old planned cases may still carry one.
    $candidates = @($candidates | Where-Object { $lp = ($_ -split '@')[0]; $lp -and ($lp -notmatch '(^[._-]|[._-]$|[._-]{2,})') })
    $existing = $null
    $chosenUpn = $null
    $adopt = $false
    $targetName = ([string]$User.DisplayName).Trim()
    # How to handle a same-name account with NO provisioning marker (ambiguous: our re-run vs a
    # different person who happens to share a name): 'adopt' = it's ours, 'new' = different person
    # (use a fallback), unset/'ask' = PAUSE and let an operator decide on the case.
    $collisionPolicy = [string](Get-CtgProp $Config 'usernameCollisionPolicy')
    foreach ($cand in $candidates) {
        # Transient-aware: a genuine 404 -> $null (available); a throttle/timeout retries, then throws —
        # so a transient blip can NEVER make us skip the marker/adopt check and create a duplicate.
        $found = Resolve-CtgM365User -Upn $cand -Property @('Id', 'DisplayName', 'OnPremisesExtensionAttributes')
        if (-not $found) { $chosenUpn = $cand; Write-CtgM365Step "username available: $cand"; break }
        # Safe nested read (StrictMode throws on an absent property): a stranger's account may carry no
        # extensionAttributes at all.
        $ext = if ($found.PSObject.Properties.Name -contains 'OnPremisesExtensionAttributes') { $found.OnPremisesExtensionAttributes } else { $null }
        $foundMarker = if ($ext -and ($ext.PSObject.Properties.Name -contains 'ExtensionAttribute1')) { [string]$ext.ExtensionAttribute1 } else { '' }
        if ($foundMarker -and $foundMarker -ieq $marker) {
            $existing = $found; $chosenUpn = $cand; $actions.Add("user exists ($cand) — our account (re-run), skipped create"); break
        }
        # No marker but the SAME display name = AMBIGUOUS: a prior run created the account before
        # failing (ours, a re-run) OR a genuinely different person with the same name. Honor the
        # operator's decision if one was made; otherwise PAUSE and ask rather than guess.
        if (-not $foundMarker -and $targetName -and ([string]$found.DisplayName).Trim() -ieq $targetName) {
            if ($collisionPolicy -ieq 'adopt') {
                $existing = $found; $chosenUpn = $cand; $adopt = $true
                $actions.Add("user exists ($cand) with no marker but matching name '$($found.DisplayName)' — operator chose ADOPT (stamping marker), skipping create")
                Write-CtgM365Step "↪ adopting existing '$($found.DisplayName)' ($cand) — continuing with licensing/groups"
                break
            }
            elseif ($collisionPolicy -ine 'new') {
                # No decision yet -> stop and ask. The app turns this into a case decision (Adopt / Different person).
                throw "DECISION_NEEDED:username_collision | An account already exists for '$($found.DisplayName)' at $cand with no provisioning marker. If this is a RE-RUN of the same person, choose Adopt; if it's a DIFFERENT person with the same name, choose a new username. Decide on the case and re-run. | upn=$cand | name=$($found.DisplayName)"
            }
            # collisionPolicy 'new' -> operator said different person: fall through to the collision path below.
        }
        $actions.Add("username '$cand' is taken by a different user ($($found.DisplayName)) — trying the next pattern")
        Write-CtgM365Step "↪ $cand taken by $($found.DisplayName) — trying fallback"
    }
    if (-not $chosenUpn) {
        throw "all candidate usernames are taken by other users: $($candidates -join ', '). Add another username fallback pattern (e.g. {firstinitial}{last}), or assign one manually."
    }
    if ($chosenUpn -ne $upn) { $actions.Add("using fallback username: $chosenUpn (primary $upn taken)"); Write-CtgM365Step "→ using fallback username: $chosenUpn"; $upn = $chosenUpn }

    if ($existing) {
        $userId = $existing.Id
        # Adopted an unmarked same-name account: stamp our provisioning marker so the next re-run
        # recognizes it by marker (and never has to name-match again).
        if ($adopt -and $PSCmdlet.ShouldProcess($chosenUpn, "Stamp provisioning marker on adopted user")) {
            try { Update-MgUser -UserId $userId -OnPremisesExtensionAttributes @{ ExtensionAttribute1 = $marker } -ErrorAction Stop }
            catch { $actions.Add("note: couldn't stamp the provisioning marker on $chosenUpn ($($_.Exception.Message)) — it'll be name-matched again next run") }
        }
    }
    else {
        if ($PSCmdlet.ShouldProcess($upn, "Create M365 user")) {
            $passwordProfile = @{
                Password                      = (ConvertFrom-SecureString $InitialPassword -AsPlainText)
                ForceChangePasswordNextSignIn = $RequireChangeAtSignIn
            }
            # Required fields always; optional ones (JobTitle/MobilePhone/GivenName/Surname) only when
            # they hold a real value — Graph rejects an empty string or an unresolved {token} (e.g.
            # "Invalid value specified for property 'jobTitle'"). Omitting the property = leave it unset.
            $hasValue = { param($v) -not [string]::IsNullOrWhiteSpace([string]$v) -and ([string]$v) -notmatch '\{' }
            $params = @{
                AccountEnabled    = $true
                DisplayName       = $User.DisplayName
                UserPrincipalName = $upn
                MailNickname      = ($upn.Split('@')[0])
                UsageLocation     = ([string]((Get-CtgProp $User 'UsageLocation') ?? 'US'))
                # provisioning marker: lets a re-run recognize OUR account vs a same-name collision.
                # extensionAttribute1 (writable for cloud users, up to 1024 chars) — NOT employeeId (16-char cap).
                OnPremisesExtensionAttributes = @{ ExtensionAttribute1 = $marker }
                PasswordProfile   = $passwordProfile
            }
            foreach ($opt in @(
                @{ K = 'GivenName';   V = (Get-CtgProp $User 'FirstName') }
                @{ K = 'Surname';     V = (Get-CtgProp $User 'LastName') }
                @{ K = 'JobTitle';    V = (Get-CtgProp $User 'JobTitle') }
                @{ K = 'MobilePhone'; V = (Get-CtgProp $User 'MobilePhone') }
            )) { if (& $hasValue $opt.V) { $params[$opt.K] = [string]$opt.V } }
            try {
                $created = Invoke-CtgM365Write { New-MgUser @params }
                $userId = $created.Id
                $actions.Add("created user $upn" + $(if (-not $params.ContainsKey('JobTitle')) { " (no job title)" } else { "" }))
            }
            catch {
                if ($_.Exception.Message -notmatch 'already exists') { throw }
                # The pre-check missed (throttle / consistency lag) but Graph says the UPN IS taken —
                # confirm it's our user and carry on to licensing/groups instead of failing the step.
                $found = $null
                for ($i = 0; $i -lt 3 -and -not $found; $i++) {
                    if ($i) { Start-Sleep -Seconds (2 * $i) }
                    $found = Get-MgUser -UserId $upn -ErrorAction SilentlyContinue
                }
                if (-not $found) { throw }
                $userId = $found.Id
                $actions.Add("user already exists ($upn) — confirmed by UPN, continuing to licensing/groups")
            }
        }
    }

    # 1b. Profile attributes — write the directory fields from the intake on create AND re-run, so an
    # existing/adopted user gets any MISSING fields filled (previously only DisplayName/UPN/title/mobile
    # were ever set, so department/office/address/company never landed). Each is set only when it holds
    # a real value (Graph rejects an empty string or an unresolved {token}); reads are case-insensitive
    # so they pick up the camelCase intake payload (department, officeLocation, homeAddress, …).
    $hasVal = { param($v) -not [string]::IsNullOrWhiteSpace([string]$v) -and ([string]$v) -notmatch '\{' }
    if ($userId) {
        $attrMap = @(
            @{ K = 'JobTitle';       V = (Get-CtgProp $User 'JobTitle') }
            @{ K = 'Department';     V = (Get-CtgProp $User 'Department') }
            @{ K = 'CompanyName';    V = ((Get-CtgProp $User 'CompanyName') ?? (Get-CtgProp $Config 'companyName')) }
            @{ K = 'OfficeLocation'; V = ((Get-CtgProp $User 'OfficeLocation') ?? (Get-CtgProp $User 'OfficeName')) }
            @{ K = 'MobilePhone';    V = (Get-CtgProp $User 'MobilePhone') }
            @{ K = 'StreetAddress';  V = ((Get-CtgProp $User 'StreetAddress') ?? (Get-CtgProp $User 'HomeAddress')) }
            @{ K = 'City';           V = ((Get-CtgProp $User 'City') ?? (Get-CtgProp $User 'Locality')) }
            @{ K = 'State';          V = (Get-CtgProp $User 'State') }
            @{ K = 'PostalCode';     V = ((Get-CtgProp $User 'PostalCode') ?? (Get-CtgProp $User 'Zip')) }
            @{ K = 'Country';        V = (Get-CtgProp $User 'Country') }
        )
        $update = @{}
        foreach ($a in $attrMap) { if (& $hasVal $a.V) { $update[$a.K] = [string]$a.V } }
        # business / office phone is an ARRAY in Graph
        $office = (Get-CtgProp $User 'OfficePhone') ?? (Get-CtgProp $User 'BusinessPhone') ?? (Get-CtgProp $User 'Did')
        if (& $hasVal $office) { $update['BusinessPhones'] = @([string]$office) }
        if ($update.Count -and $PSCmdlet.ShouldProcess($upn, "Set profile attributes: $($update.Keys -join ', ')")) {
            try {
                Invoke-CtgM365Write { Update-MgUser -UserId $userId @update -ErrorAction Stop }
                $actions.Add("set profile: $($update.Keys -join ', ')"); Write-CtgM365Step "✓ set profile: $($update.Keys -join ', ')"
            } catch {
                $pm = [string]$_.Exception.Message
                # A hybrid (AD-synced) user is on-prem-mastered — Graph refuses to write these directory
                # attributes. That's expected: the AD lane sets them on-prem and they sync up. Report an
                # informational skip, not a warning (same stance as manager + on-prem groups).
                if ($pm -match 'on-premises mastered|Directory Sync objects') {
                    $actions.Add("profile attributes ($($update.Keys -join ', ')) are on-prem-mastered (AD-synced) — the AD lane sets them on-prem; skipped in the cloud")
                    Write-CtgM365Step "↷ profile attrs on-prem-mastered — AD lane sets them: $($update.Keys -join ', ')"
                } else {
                    $actions.Add("WARN could not set profile attributes ($($update.Keys -join ', ')): $pm")
                }
            }
        }
    }

    # 1c. Manager — resolve the manager (by email when the intake provided one, else by name — see
    # Resolve-CtgEntraUser) and set the Graph manager relationship. Without this the org chart /
    # "Reports to" stays empty even when u_manager_name was filled in.
    $mgr = (Get-CtgProp $User 'ManagerEmail') ?? (Get-CtgProp $User 'ManagerName') ?? (Get-CtgProp $User 'Manager')
    if ((& $hasVal $mgr) -and $PSCmdlet.ShouldProcess($upn, "Set manager $mgr")) {
        $mgrUser = Resolve-CtgEntraUser -Identity ([string]$mgr)
        if ($mgrUser) {
            try {
                Invoke-CtgM365Write { Set-MgUserManagerByRef -UserId $userId -BodyParameter @{ '@odata.id' = "https://graph.microsoft.com/v1.0/users/$($mgrUser.Id)" } -ErrorAction Stop }
                $actions.Add("set manager: $($mgrUser.DisplayName)"); Write-CtgM365Step "✓ set manager: $($mgrUser.DisplayName)"
            } catch {
                $mm = [string]$_.Exception.Message
                # A hybrid (AD-synced) user is on-prem-mastered — Graph refuses to write source-of-authority
                # attributes like manager. That's expected: the AD lane sets the manager on-prem and it
                # syncs up. Report it as an informational skip, NOT a warning (same stance as on-prem groups).
                if ($mm -match 'on-premises mastered|Directory Sync objects') {
                    $actions.Add("manager is on-prem-mastered (AD-synced) — the AD lane sets manager '$mgr' on-prem; skipped in the cloud")
                    Write-CtgM365Step "↷ manager on-prem-mastered — AD lane sets it: $mgr"
                } else {
                    $actions.Add("WARN could not set manager '$mgr': $mm")
                }
            }
        } else { $actions.Add("WARN manager not found in Entra (tried email + name): $mgr"); Write-CtgM365Step "✗ manager not found: $mgr" }
    }

    # 2. Licenses — add only what's missing ------------------------------------
    # Canonical config uses `licenses` (name strings or {name,skuId}); fall back to the older
    # `defaultLicenses` shape. Names resolve to SkuIds against the tenant.
    $seatShortage = $false  # set when an assignment fails for no seats -> return the SKU inventory so the operator can pick another
    $licenseSpecs = @(Get-CtgProp $Config 'licenses') + @(Get-CtgProp $Config 'defaultLicenses') | Where-Object { $_ }
    # Licensing REQUIRES a usageLocation on the user, else Graph rejects "License assignment cannot be
    # done for user with invalid usage location". A synced/adopted user (hybrid clients — the account is
    # AD-mastered) often has none: New-MgUser sets it only when WE create the user, and the AD lane
    # doesn't. Set it in its OWN call (not bundled with the profile attrs above — several of those are
    # on-prem-mastered and can fail for a synced user, which would take usageLocation down with them).
    # usageLocation is a CLOUD attribute, writable via Graph even on a synced user.
    if (@($licenseSpecs).Count -gt 0) {
        $wantLoc = [string]((Get-CtgProp $User 'UsageLocation') ?? 'US')
        if ($wantLoc -and $PSCmdlet.ShouldProcess($upn, "Set usageLocation $wantLoc")) {
            try {
                Invoke-CtgM365Write { Update-MgUser -UserId $userId -UsageLocation $wantLoc -ErrorAction Stop } | Out-Null
                $actions.Add("set usageLocation: $wantLoc"); Write-CtgM365Step "✓ set usageLocation: $wantLoc"
            } catch {
                $actions.Add("WARN could not set usageLocation '$wantLoc': $($_.Exception.Message)")
            }
        }
    }
    $assigned = @(Get-MgUserLicenseDetail -UserId $userId -ErrorAction SilentlyContinue | ForEach-Object { $_.SkuId })
    # Batch pass: assign ALL missing licenses in ONE Set-MgUserLicense call so INTERDEPENDENT service
    # plans across licenses are enabled together. Assigning one-by-one fails Graph's dependency check —
    # e.g. Microsoft Defender for Office 365 (Plan 2)'s plan depends on Exchange Online (which lives in
    # E3), and Teams Phone depends on Teams; added separately, the dependency isn't yet satisfied. On ANY
    # batch failure we fall through to the per-license loop below (which keeps per-license seat/usage-
    # location diagnostics). Only batch when 2+ licenses are new (a lone license has no cross-dependency).
    $newSku = [ordered]@{}
    foreach ($lic in $licenseSpecs) {
        $sk = Resolve-CtgSkuId $lic
        $nm = if ($lic -is [string]) { $lic } else { (Get-CtgProp $lic 'name') ?? (Get-CtgProp $lic 'skuId') }
        if ($sk -and ($assigned -notcontains $sk) -and -not $newSku.Contains($sk)) { $newSku[$sk] = $nm }
    }
    if (@($newSku.Keys).Count -gt 1 -and $PSCmdlet.ShouldProcess($upn, "Assign licenses together: $(@($newSku.Values) -join ', ')")) {
        $addAll = @(@($newSku.Keys) | ForEach-Object { @{ SkuId = $_ } })
        Write-CtgM365Step "assigning licenses together: $(@($newSku.Values) -join ', ')"
        try {
            Invoke-CtgM365Write { Set-MgUserLicense -UserId $userId -AddLicenses $addAll -RemoveLicenses @() -ErrorAction Stop } | Out-Null
            foreach ($nm in @($newSku.Values)) { $actions.Add("assigned license: $nm") }
            $assigned = @($assigned) + @($newSku.Keys)  # so the per-license loop sees them as present
            Write-CtgM365Step "✓ assigned licenses together: $(@($newSku.Values) -join ', ')"
        } catch {
            $actions.Add("batch license assign failed ($($_.Exception.Message)) — retrying per-license")
            Write-CtgM365Step "batch assign failed — retrying per-license"
        }
    }
    foreach ($lic in $licenseSpecs) {
        $name  = if ($lic -is [string]) { $lic } else { (Get-CtgProp $lic 'name') ?? (Get-CtgProp $lic 'skuId') }
        $skuId = Resolve-CtgSkuId $lic
        if (-not $skuId) { $actions.Add("WARN license not in tenant: $name"); continue }
        if ($assigned -contains $skuId) {
            $actions.Add("license present: $name")
            continue
        }
        if ($PSCmdlet.ShouldProcess($upn, "Assign license $name")) {
            Write-CtgM365Step "assigning license: $name"
            try {
                Invoke-CtgM365Write { Set-MgUserLicense -UserId $userId -AddLicenses @(@{ SkuId = $skuId }) -RemoveLicenses @() -ErrorAction Stop } | Out-Null
                $actions.Add("assigned license: $name")
                Write-CtgM365Step "✓ assigned license: $name"
            } catch {
                $lm = [string]$_.Exception.Message
                # No seats left in the tenant: don't fail the onboard — the account is already created,
                # it just needs a license ordered. Surface a clear procurement action; the step is a
                # warning, not a failure.
                if ($lm -match 'does not have any available licenses|no available licenses|not have any available') {
                    $seatShortage = $true
                    $actions.Add("WARN no available '$name' license seats — user CREATED UNLICENSED. Pick another license below (owned SKUs + free seats shown), or open a Procurement Case to order a $name license, then re-run.")
                    Write-CtgM365Step "⚠ $name — no seats available; user left unlicensed. Pick another license or order one."
                } elseif ($lm -match 'invalid usage location|usageLocation|usage location') {
                    # The pre-set above didn't stick (timing, or it was rejected). Set it explicitly, read it
                    # back, and retry the license ONCE. If it still fails, throw a DIAGNOSTIC error that shows
                    # the user's actual usageLocation + whether the set was rejected (which points at an
                    # on-prem-mastered attribute — then it must be set in AD to sync, or in the admin center).
                    $loc = [string]((Get-CtgProp $User 'UsageLocation') ?? 'US')
                    $setErr = $null
                    try { Invoke-CtgM365Write { Update-MgUser -UserId $userId -UsageLocation $loc -ErrorAction Stop } | Out-Null } catch { $setErr = $_.Exception.Message }
                    $confirmed = [string]((Get-MgUser -UserId $userId -Property UsageLocation -ErrorAction SilentlyContinue).UsageLocation)
                    try {
                        Invoke-CtgM365Write { Set-MgUserLicense -UserId $userId -AddLicenses @(@{ SkuId = $skuId }) -RemoveLicenses @() -ErrorAction Stop } | Out-Null
                        $actions.Add("set usageLocation $loc, then assigned license: $name"); Write-CtgM365Step "✓ set usageLocation $loc + assigned license: $name"
                    } catch {
                        throw "assigning '$name' failed — user usageLocation is '$confirmed' (tried to set '$loc'$(if ($setErr) { "; the set was REJECTED: $setErr — usageLocation is on-prem mastered here, so set it in AD (it'll sync) or in the M365 admin center" } else { '' })). Underlying: $($_.Exception.Message)"
                    }
                } else { throw }
            }
        }
    }

    # 3. Groups — DETERMINE each group's type, then add via the right path, narrating as we go.
    # Graph (this lane) can add Security groups and Microsoft 365 (Unified) groups. Distribution lists
    # and mail-enabled security groups are Exchange-managed — the Exchange step adds those. A config
    # group may be a plain name or { name, type } where type hints dl|security|m365|unsure (from the
    # KB); we verify the actual type in Entra and narrate it, so an unclear doc still resolves.
    $groupSpecs = @(Get-CtgProp $Config 'groups') + @(Get-CtgProp $Config 'defaultGroups') | Where-Object { $_ }
    $deferredDls = [System.Collections.Generic.List[string]]::new()  # DL/mail-enabled groups Graph can't write — finished over EXO by the runner
    foreach ($gspec in $groupSpecs) {
        $gname = if ($gspec -is [string]) { $gspec } else { [string](Get-CtgProp $gspec 'name') }
        $hint  = if ($gspec -is [string]) { $null } else { [string](Get-CtgProp $gspec 'type') }
        if ([string]::IsNullOrWhiteSpace($gname)) { continue }
        Write-CtgM365Step "checking group: $gname$(if ($hint) { " (documented as $hint)" })"
        # Match on mail, alias (mailNickname) AND displayName — Graph compares these case-insensitively,
        # so a config value like "TEAMDCG" resolves the group whose alias is "TeamDCG" / name "Team DCG".
        # (Matching only mail+displayName is why a real 365 group read as "not a Graph group" and got
        # deferred.) Double any single quote so a name like O'Brien can't break the OData filter.
        $gesc = $gname -replace "'", "''"
        # Request groupTypes + isAssignableToRole so we can recognize dynamic / role-assignable groups
        # (neither is a normal manual add) — these aren't all in the default property set.
        $group = Get-MgGroup -Filter "mail eq '$gesc' or mailNickname eq '$gesc' or displayName eq '$gesc'" -Top 1 -Property "id,displayName,mail,mailNickname,mailEnabled,securityEnabled,groupTypes,isAssignableToRole" -ErrorAction SilentlyContinue
        if (-not $group) {
            $actions.Add("group '$gname' not resolvable as a Graph group by name — adding over Exchange Online (a DL, or a 365 group whose alias differs from its name)")
            Write-CtgM365Step "↷ $gname — not found as a Graph group by name; adding over Exchange Online"
            $deferredDls.Add($gname)
            continue
        }
        $isUnified   = @(Get-CtgProp $group 'GroupTypes') -contains 'Unified'
        $mailEnabled = (Get-CtgProp $group 'MailEnabled') -eq $true
        $secEnabled  = (Get-CtgProp $group 'SecurityEnabled') -eq $true
        $isDynamic = @(Get-CtgProp $group 'GroupTypes') -contains 'DynamicMembership'
        $roleAssignable = (Get-CtgProp $group 'IsAssignableToRole') -eq $true
        $kind = if ($isUnified) { 'Microsoft 365 group' } elseif ($mailEnabled) { 'distribution/mail-enabled group' } elseif ($secEnabled) { 'Security group' } else { 'group' }
        Write-CtgM365Step "→ $gname is a $kind$(if ($isDynamic) { ' (dynamic)' } elseif ($roleAssignable) { ' (role-assignable)' })"
        if ($isDynamic) {
            # Dynamic groups compute membership from a rule — members can't be added manually (Graph
            # returns Authorization_RequestDenied). The user is included automatically once the rule
            # matches, so this is a no-op, NOT a failure. Skipping (not a warning, not a deferral).
            $actions.Add("skipped dynamic group '$gname' — membership is rule-computed; the user is added automatically when the rule matches, not manually")
            Write-CtgM365Step "↷ $gname — dynamic group; membership is automatic (rule-computed), nothing to add"
            continue
        }
        if ($mailEnabled -and -not $isUnified) {
            # Graph cannot add DLs / mail-enabled security groups — finished over Exchange Online (same app).
            $actions.Add("$gname → $kind — adding over Exchange Online (Graph can't write distribution/mail-enabled groups)")
            Write-CtgM365Step "↷ $gname — $kind, adding over Exchange Online"
            $deferredDls.Add($gname)
            continue
        }
        $isMember = @(Get-MgGroupMember -GroupId $group.Id -All -ErrorAction SilentlyContinue | ForEach-Object Id) -contains $userId
        if ($isMember) { $actions.Add("already in $kind`: $gname"); Write-CtgM365Step "✓ already in $gname"; continue }
        if ($PSCmdlet.ShouldProcess($upn, "Add to $kind $gname")) {
            Write-CtgM365Step "adding to $kind`: $gname"
            $err = Add-CtgGroupMember -GroupId $group.Id -UserId $userId
            if ($err) {
                # Name the likely cause when Graph denies the write: a role-assignable group needs
                # RoleManagement.ReadWrite.Directory (or Privileged Role Admin), not just Group write.
                $hint = if ($roleAssignable -and $err -match 'Authorization_RequestDenied|Insufficient privileges') {
                    " — this is a role-assignable group; adding members needs RoleManagement.ReadWrite.Directory or the Privileged Role Administrator role, which the app lacks"
                } elseif ($err -match 'Authorization_RequestDenied|Insufficient privileges') {
                    " — the app's service principal lacks rights to write this group's membership (check it isn't on-prem-synced/owner-restricted, and the app has GroupMember.ReadWrite.All)"
                } else { '' }
                $actions.Add("WARN could not add to $kind ${gname}: $err$hint"); Write-CtgM365Step "✗ $gname — $err$hint"
            }
            else { $actions.Add("added to $kind`: $gname"); Write-CtgM365Step "✓ added to $kind`: $gname" }
        }
    }

    # 3c. Mirror the reference user's cloud-only Entra groups (incl. cloud licensing groups) ---------
    $mirrorUser = Get-CtgProp $Config 'mirrorFromUser'
    if ($mirrorUser -and $PSCmdlet.ShouldProcess($upn, "Mirror cloud groups from $mirrorUser")) {
        foreach ($a in (Invoke-CtgM365CloudMirror -MirrorUser ([string]$mirrorUser) -UserId $userId)) { $actions.Add($a) }
    }

    # 3b. Seat-aware E5/E3 fallback (live SKU consumption) ----------------------
    $licenseFallbackAdGroup = $null
    $seatAware = Get-CtgProp $Config 'seatAwareLicense'
    if ($seatAware) {
        $sal = Set-CtgSeatAwareLicense -UserId $userId -Config $seatAware
        foreach ($a in $sal.Actions) { $actions.Add("license: $a") }
        # The E3 fallback is an on-prem AD group this (Graph) lane can't add — surface it on the
        # result so the runner hands it to the active-directory lane (the AD groups already ran, so
        # this is a follow-up add).
        $licenseFallbackAdGroup = $sal.FallbackAdGroup
    }

    # 4. Alias — only if requested ---------------------------------------------
    $alias = Get-CtgProp $Config 'alias'
    if ($alias -and (Get-CtgProp $alias 'enabled')) {
        $address = Get-CtgProp $alias 'address'
        $proxy = "smtp:$address"
        $current = @((Get-MgUser -UserId $userId -Property ProxyAddresses).ProxyAddresses)
        if ($current -contains $proxy) {
            $actions.Add("alias present: $address")
        }
        elseif ($PSCmdlet.ShouldProcess($upn, "Add alias $address")) {
            Invoke-CtgM365Write { Update-MgUser -UserId $userId -ProxyAddresses ($current + $proxy) }
            $actions.Add("added alias: $address")
        }
    }

    $warned = @($actions | Where-Object { $_ -like 'WARN*' }).Count
    Write-CtgM365Step "$(if ($warned) { "⚠ m365 onboard finished with $warned warning(s)" } else { '✓ m365 onboard complete' }) — $($actions -join '; ')"
    # The mailbox's ASSIGNED primary SMTP — consumed by the ad-email-writeback step to set AD's `mail`.
    # Read from Graph; fall back to the UPN (== primary SMTP for these tenants) so the write-back always
    # has an address even if Graph hasn't surfaced `mail` yet (sync lag on a fresh hybrid account).
    $primarySmtp = $null
    # onPremisesSyncEnabled + onPremisesImmutableId feed the ad-consistency-check step (does the on-prem
    # object link to this Entra object, or would it duplicate?). One Graph read for all three fields.
    $onPremImmutableId = $null; $onPremSyncEnabled = $null
    try {
        $mgu = Get-MgUser -UserId $userId -Property Mail, OnPremisesSyncEnabled, OnPremisesImmutableId -ErrorAction SilentlyContinue
        if ($mgu) {
            $primarySmtp = [string]$mgu.Mail
            $onPremImmutableId = [string]$mgu.OnPremisesImmutableId
            if ($null -ne $mgu.OnPremisesSyncEnabled) { $onPremSyncEnabled = [bool]$mgu.OnPremisesSyncEnabled }
        }
    } catch { $primarySmtp = $null }
    if ([string]::IsNullOrWhiteSpace($primarySmtp)) { $primarySmtp = $upn }
    [pscustomobject]@{
        System  = 'm365'
        Status  = 'ok'
        UserId  = $userId
        Upn     = $upn
        PrimarySmtpAddress = $primarySmtp
        OnPremImmutableId = $onPremImmutableId  # Entra source anchor (base64) — for the consistency check
        OnPremSyncEnabled = $onPremSyncEnabled  # $true synced from AD, $false cloud-only (duplicate risk)
        LicenseFallbackAdGroup = $licenseFallbackAdGroup  # AD group the runner must add (E3 fallback), or $null
        # Distribution / mail-enabled groups Graph couldn't write — the runner finishes these over
        # Exchange Online using the SAME m365-admin app, so no separate Exchange system is needed.
        DeferredDistributionGroups = $deferredDls.ToArray()
        # On a seat shortage, return the tenant's SKU inventory so the app can offer a license picker.
        AvailableLicenses = if ($seatShortage) { Get-CtgM365LicenseInventory } else { @() }
        Actions = $actions.ToArray()
    }
}

function Invoke-CtgM365Offboarding {
    <#
    .SYNOPSIS
        Idempotently tear down a user's 365-admin footprint: block sign-in, capture group
        evidence then remove all groups, and remove the license — honoring the mailbox size
        threshold (keep E3 if the mailbox is over the limit, per the "do not remove yet" rule).
        Mailbox conversion and Entra/Exchange specifics are handled by their own modules.
    .PARAMETER User
        Normalized user object; must carry UserPrincipalName.
    .PARAMETER Config
        The 'config' block from the m365 system's offboard lane: blockSignIn, removeAllGroups,
        oneDriveBackup{...}, mailbox{sizeThresholdGB,aboveThreshold}, removeLicense{...}.
    .PARAMETER MailboxSizeGB
        Current mailbox size (from Exchange upstream); drives the keep-license threshold.
    .OUTPUTS
        Result object with Status, an Evidence snapshot (groups removed), and an Actions log.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [double]$MailboxSizeGB = 0
    )

    $actions = [System.Collections.Generic.List[string]]::new()
    $upn = [string]$User.UserPrincipalName
    $displayName = [string](Get-CtgProp $User 'DisplayName')

    # Resolve the existing user: by UPN when the case carries one, else by DISPLAY NAME against the
    # directory (offboard intakes often have only the name). A display-name search that matches exactly
    # one user is authoritative; 0 or many -> stop with a clear note rather than act on the wrong person.
    $existing = $null
    if ($upn) { $existing = Get-MgUser -Filter "userPrincipalName eq '$($upn -replace "'", "''")'" -ErrorAction SilentlyContinue }
    if (-not $existing -and $displayName) {
        $dnEsc = $displayName -replace "'", "''"   # escape quotes so "Sean O'Brien" can't break the OData filter
        $byName = @(Get-MgUser -Filter "displayName eq '$dnEsc'" -All -ErrorAction SilentlyContinue)
        if ($byName.Count -eq 1) {
            $existing = $byName[0]
            $actions.Add("resolved offboard target by display name '$displayName' -> $(Get-CtgProp $existing 'UserPrincipalName')")
        }
        elseif ($byName.Count -gt 1) {
            return [pscustomobject]@{ System = 'm365'; Status = 'ok'; Upn = $upn; Actions = @("WARN $($byName.Count) users match display name '$displayName' — set the exact UPN on the case to disambiguate. Nothing done."); Evidence = @{ Groups = @(); Devices = @() } }
        }
    }
    if (-not $existing) {
        $who = if ($upn) { $upn } else { $displayName }
        return [pscustomobject]@{ System = 'm365'; Status = 'ok'; Upn = $upn; Actions = @("user not found ($who) — nothing to offboard"); Evidence = @{ Groups = @(); Devices = @() } }
    }
    $userId = $existing.Id
    $upn = [string]((Get-CtgProp $existing 'UserPrincipalName') ?? $upn)   # authoritative from here on

    # 1. Evidence FIRST — snapshot group memberships before we remove anything ----
    $memberships = @(Get-MgUserMemberOf -UserId $userId -All -ErrorAction SilentlyContinue) |
        Where-Object { (Get-CtgProp $_.AdditionalProperties '@odata.type') -eq '#microsoft.graph.group' }
    $groupEvidence = foreach ($g in $memberships) {
        $ap = $g.AdditionalProperties
        [pscustomobject]@{
            Id          = $g.Id
            DisplayName = (Get-CtgProp $ap 'displayName')
            # Why a group may NOT be removable via Graph (Entra) — used to route it instead of erroring:
            OnPrem      = [bool](Get-CtgProp $ap 'onPremisesSyncEnabled')                 # AD-mastered -> the AD step removes it
            MailEnabled = [bool](Get-CtgProp $ap 'mailEnabled')                           # DL / mail-enabled security -> managed in Exchange
            Dynamic     = (@(Get-CtgProp $ap 'groupTypes') -contains 'DynamicMembership') # rule-managed -> can't remove a member
        }
    }
    $actions.Add("captured $($groupEvidence.Count) group membership(s) as evidence")

    # 2. Block sign-in (idempotent) --------------------------------------------
    $blockSignIn = Get-CtgProp $Config 'blockSignIn'
    if ($blockSignIn -ne $false) {
        if ((Get-CtgProp $existing 'AccountEnabled') -eq $false) {
            $actions.Add("sign-in already blocked")
        }
        elseif ($PSCmdlet.ShouldProcess($upn, "Block sign-in")) {
            Invoke-CtgM365Write { Update-MgUser -UserId $userId -AccountEnabled:$false }
            $actions.Add("blocked sign-in")
        }
    }

    # 2b. Revoke active sign-in sessions (invalidates issued tokens / forces re-auth) ----
    # Blocking sign-in stops NEW logins; existing refresh tokens stay valid until revoked.
    if ((Get-CtgProp $Config 'revokeSessions') -ne $false) {
        if ($PSCmdlet.ShouldProcess($upn, "Revoke sign-in sessions")) {
            try {
                Revoke-MgUserSignInSession -UserId $userId -ErrorAction Stop | Out-Null
                $actions.Add("revoked sign-in sessions (issued tokens invalidated)")
            }
            catch { $actions.Add("WARN could not revoke sign-in sessions: $($_.Exception.Message)") }
        }
    }

    # 3. Remove from all groups (evidence already captured). Only CLOUD, non-mail, non-dynamic groups
    # can be modified via Graph — route the rest instead of erroring on them:
    #   - on-prem-synced groups are AD-mastered -> the active-directory step removes them
    #   - mail-enabled groups / DLs are managed in Exchange (Graph can't change membership)
    #   - dynamic groups are rule-managed -> a member can't be removed at all
    if ((Get-CtgProp $Config 'removeAllGroups') -ne $false) {
        foreach ($g in $groupEvidence) {
            if ($g.OnPrem)      { $actions.Add("skipped on-prem-synced group: $($g.DisplayName) — removed by the AD step"); continue }
            if ($g.MailEnabled) { $actions.Add("skipped mail-enabled group/DL: $($g.DisplayName) — managed in Exchange"); continue }
            if ($g.Dynamic)     { $actions.Add("skipped dynamic group: $($g.DisplayName) — membership is rule-managed"); continue }
            if ($PSCmdlet.ShouldProcess($upn, "Remove from group $($g.DisplayName)")) {
                try {
                    Remove-MgGroupMemberByRef -GroupId $g.Id -DirectoryObjectId $userId -ErrorAction Stop
                    $actions.Add("removed from group: $($g.DisplayName)")
                }
                catch {
                    $m = "$($_.Exception.Message)"
                    # Idempotent end-state: the user is already not a member (Graph: "removed object
                    # references do not exist … 'members'") or the group is gone (ResourceNotFound/404).
                    # The desired state — not a member — already holds, so it's done, not a warning.
                    if ($m -match 'do(es)? not exist|ResourceNotFound|not present|\bNotFound\b|\b404\b') {
                        $actions.Add("already not a member of $($g.DisplayName) (skipped)")
                    } else {
                        $actions.Add("WARN could not remove from $($g.DisplayName): $m")
                    }
                }
            }
        }
    }

    # 3b. Disable the user's Entra-registered devices, and surface their names ----
    # The device name(s) are the single source for downstream endpoint steps (SentinelOne
    # isolate/shutdown, the AD computer-object disable) — captured as evidence either way so a
    # later step / operator can resolve the machine even when device-disable itself is off.
    $deviceEvidence = @()
    $disableDevices = Get-CtgProp $Config 'disableDevices'
    if ($disableDevices -or (Get-CtgProp $Config 'captureDevices')) {
        try {
            $deviceEvidence = @(Get-CtgM365UserDevices -UserId $userId)
            $actions.Add("captured $($deviceEvidence.Count) Entra device(s) as evidence: $((@($deviceEvidence | ForEach-Object { $_.DisplayName }) -join ', '))")
            if ($disableDevices) {
                foreach ($d in $deviceEvidence) {
                    if ($PSCmdlet.ShouldProcess($d.DisplayName, "Disable Entra device")) {
                        try {
                            Invoke-CtgM365Write { Update-MgDevice -DeviceId $d.Id -AccountEnabled:$false }
                            $actions.Add("disabled Entra device: $($d.DisplayName)")
                        }
                        catch { $actions.Add("WARN could not disable Entra device $($d.DisplayName): $($_.Exception.Message)") }
                    }
                }
            }
        }
        catch { $actions.Add("WARN could not enumerate Entra devices: $($_.Exception.Message)") }
    }

    # 4. OneDrive backup — flagged for the data-transfer step (not done inline) -
    $oneDrive = Get-CtgProp $Config 'oneDriveBackup'
    if ($oneDrive) { $actions.Add("OneDrive backup required -> $((Get-CtgProp $oneDrive 'target'))") }

    # 5. License removal — honor the mailbox size threshold. GROUP-BASED LICENSING: a license assigned
    # via a GROUP can't be removed directly ("User license is inherited from a group membership and it
    # cannot be removed directly from the user"). So remove only DIRECTLY-assigned licenses and REPORT
    # which group assigns the rest — those drop when the user leaves that group (an on-prem-synced
    # licensing group like "M365 E3 Users Group" is removed by the AD step, then AD Connect syncs it).
    $removeLicense = Get-CtgProp $Config 'removeLicense'
    $mailbox = Get-CtgProp $Config 'mailbox'
    $threshold = if ($mailbox) { [double]((Get-CtgProp $mailbox 'sizeThresholdGB') ?? 50) } else { 50 }
    if ($null -ne $removeLicense) {
        if ($MailboxSizeGB -gt $threshold) {
            $actions.Add("license kept — mailbox $MailboxSizeGB GB is over threshold ($threshold GB); remove after mailbox handling")
        }
        elseif ($PSCmdlet.ShouldProcess($upn, "Remove directly-assigned licenses")) {
            $userObj = Get-MgUser -UserId $userId -Property 'LicenseAssignmentStates' -ErrorAction SilentlyContinue
            $states = @(@(Get-CtgProp $userObj 'LicenseAssignmentStates') | Where-Object { $_ })
            $skuName = @{}; foreach ($d in @(Get-MgUserLicenseDetail -UserId $userId -ErrorAction SilentlyContinue)) { $skuName[[string](Get-CtgProp $d 'SkuId')] = [string](Get-CtgProp $d 'SkuPartNumber') }
            if ($states.Count) {
                $direct  = @($states | Where-Object { [string]::IsNullOrEmpty([string]$_.AssignedByGroup) } | ForEach-Object { [string]$_.SkuId } | Where-Object { $_ } | Select-Object -Unique)
                $byGroup = @($states | Where-Object { -not [string]::IsNullOrEmpty([string]$_.AssignedByGroup) })
            } else {
                # No assignment-state detail — fall back to removing whatever's directly assignable.
                $direct = @(Get-MgUserLicenseDetail -UserId $userId -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.SkuId }); $byGroup = @()
            }
            if ($direct.Count) {
                Invoke-CtgM365Write { Set-MgUserLicense -UserId $userId -AddLicenses @() -RemoveLicenses $direct } | Out-Null
                # Name the freed SKUs (from the pre-removal license detail) so the reclamation shows up in
                # the case notes + the ServiceNow work-note ("freed 2 license(s): SPE_E5, ENTERPRISEPACK").
                $freed = @($direct | ForEach-Object { if ($skuName.ContainsKey([string]$_)) { $skuName[[string]$_] } else { [string]$_ } })
                $actions.Add("freed $($direct.Count) directly-assigned license(s): $($freed -join ', ')")
            }
            $seen = @{}
            foreach ($s in $byGroup) {
                $key = "$([string]$s.SkuId)|$([string]$s.AssignedByGroup)"; if ($seen.ContainsKey($key)) { continue }; $seen[$key] = $true
                $gName = try { [string](Get-MgGroup -GroupId $s.AssignedByGroup -ErrorAction SilentlyContinue).DisplayName } catch { '' }
                if (-not $gName) { $gName = [string]$s.AssignedByGroup }
                $sName = if ($skuName.ContainsKey([string]$s.SkuId)) { $skuName[[string]$s.SkuId] } else { [string]$s.SkuId }
                $actions.Add("license '$sName' is GROUP-ASSIGNED by '$gName' — it drops when the user leaves that group (on-prem-synced licensing groups are removed by the AD step), not via direct removal")
            }
            if (-not $direct.Count -and -not $byGroup.Count) { $actions.Add("no licenses to remove") }
        }
    }

    [pscustomobject]@{
        System   = 'm365'
        Status   = 'ok'
        UserId   = $userId
        Upn      = $upn
        Evidence = @{ Groups = @($groupEvidence); Devices = @($deviceEvidence) }
        Actions  = $actions.ToArray()
    }
}

function Confirm-CtgM365 {
    <#
    .SYNOPSIS
        Post-action read-back for M365. Reads the user's current state (no mutations) and
        returns { ok; checks[] } so the runner/app can verify what actually happened.
    .PARAMETER Action
        'onboard' (user exists + enabled + licenses + groups) or 'offboard' (disabled + groups
        removed + license removed/kept per the mailbox threshold).
    .OUTPUTS
        [pscustomobject]@{ ok = [bool]; checks = @(@{ name; expected; actual; pass }) }
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )

    $checks = [System.Collections.Generic.List[object]]::new()
    $add = { param($name, $expected, $actual) $checks.Add(@{ name = $name; expected = $expected; actual = $actual; pass = ($expected -eq $actual) }) }
    # Resolve the SAME way the executor does (UPN, else by display name) — checking an empty identity
    # would always "miss" and re-run the offboard via the revalidate loop.
    $upn = [string](Resolve-CtgM365Upn $User)
    if ($Action -eq 'offboard' -and [string]::IsNullOrWhiteSpace($upn)) {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'no resolvable offboard target — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
    }

    # Transient-aware lookup: don't let a throttle/timeout false-report "user exists = false" (a MISS).
    $u = Resolve-CtgM365User -Upn $upn -Property @('Id', 'AccountEnabled', 'UserPrincipalName')
    $exists = [bool]$u

    if ($Action -eq 'onboard') {
        & $add 'user exists' $true $exists
        & $add 'AccountEnabled' $true ([bool]($exists -and (Get-CtgProp $u 'AccountEnabled') -eq $true))
        if ($exists) {
            $assigned = @(Get-MgUserLicenseDetail -UserId $u.Id -ErrorAction SilentlyContinue | ForEach-Object { $_.SkuId })
            $licenseSpecs = @(Get-CtgProp $Config 'licenses') + @(Get-CtgProp $Config 'defaultLicenses') | Where-Object { $_ }
            foreach ($lic in $licenseSpecs) {
                $name = if ($lic -is [string]) { $lic } else { (Get-CtgProp $lic 'name') ?? (Get-CtgProp $lic 'skuId') }
                $skuId = Resolve-CtgSkuId $lic
                & $add "license: $name" $true ([bool]($skuId -and $assigned -contains $skuId))
            }
            $myMemberships = @(Get-MgUserMemberOf -UserId $u.Id -All -ErrorAction SilentlyContinue)
            # Map each membership name -> its real type (so the verification names the type: a
            # distribution list, security, 365 Group, or mail-enabled security).
            $groupType = {
                param($ap)
                $gt = @(Get-CtgProp $ap 'groupTypes')
                $mail = [bool](Get-CtgProp $ap 'mailEnabled'); $sec = [bool](Get-CtgProp $ap 'securityEnabled')
                if ($gt -contains 'Unified') { '365 Group' }
                elseif ($mail -and $sec) { 'mail-enabled security' }
                elseif ($mail) { 'distribution list' }
                elseif ($sec) { 'security' }
                else { 'group' }
            }
            # Index the user's memberships by EVERY identifier a config value might use — display
            # name, alias (mailNickname) and mail (full + local part) — each NORMALIZED (lowercased,
            # punctuation/space stripped). Matching only on the exact displayName is why a correctly
            # added group read back as a MISS: config "TEAMDCG" never equals the real name "Team DCG".
            # Normalizing makes "TEAMDCG" == "Team DCG" == "TeamDCG" == "TeamDCG@dcg.co" all resolve.
            $norm = { param($s) (([string]$s) -replace '[^A-Za-z0-9]', '').ToLowerInvariant() }
            $memberIndex = @{}  # normalized identifier -> type label
            foreach ($m in $myMemberships) {
                $ap = $m.AdditionalProperties
                $type = & $groupType $ap
                $ids = @([string](Get-CtgProp $ap 'displayName'), [string](Get-CtgProp $ap 'mailNickname'))
                $mailAddr = [string](Get-CtgProp $ap 'mail')
                if ($mailAddr) { $ids += $mailAddr; $ids += ($mailAddr -split '@')[0] }
                foreach ($id in $ids) { $k = & $norm $id; if ($k -and -not $memberIndex.ContainsKey($k)) { $memberIndex[$k] = $type } }
            }
            foreach ($g in (@(Get-CtgProp $Config 'groups') + @(Get-CtgProp $Config 'defaultGroups') | Where-Object { $_ })) {
                # A group spec can be a plain name, an object { name, type }, or an email. Verify by
                # normalized identity (and an email's local part), so the read-back matches the add.
                $gn = if ($g -is [string]) { $g } else { [string](Get-CtgProp $g 'name') }
                if (-not $gn) { continue }
                $cands = @($gn); if ($gn -match '@') { $cands += ($gn -split '@')[0] }
                $type = $null
                foreach ($c in $cands) { $k = & $norm $c; if ($memberIndex.ContainsKey($k)) { $type = $memberIndex[$k]; break } }
                $present = [bool]$type
                if (-not $present) {
                    # Absent from the user's memberships — but a DYNAMIC group is rule-computed and can't
                    # be added manually, so its absence isn't an operator-fixable failure. If the configured
                    # group resolves to a dynamic group, report it as auto-managed (pass) rather than a MISS.
                    $gesc = $gn -replace "'", "''"
                    $grp = Get-MgGroup -Filter "mail eq '$gesc' or mailNickname eq '$gesc' or displayName eq '$gesc'" -Top 1 -Property "id,groupTypes" -ErrorAction SilentlyContinue
                    if ($grp -and (@(Get-CtgProp $grp 'GroupTypes') -contains 'DynamicMembership')) { $present = $true; $type = 'dynamic — auto-managed' }
                }
                $label = if ($present) { "group: $gn ($type)" } else { "group: $gn" }
                & $add $label $true $present
            }
            # Mirror coverage: compare the new user's membership to the reference user's, but ONLY over
            # the groups the m365 lane actually OWNS — cloud, assignable groups. We EXCLUDE the same two
            # classes the onboarding lane skips (see the "on-prem group (AD lane owns it)" / "dynamic
            # group (rule-based)" skips): on-prem-synced groups are added on-prem by the AD lane and flow
            # up via sync, and dynamic groups are rule-computed — neither is the m365 lane's to write, so
            # counting them here produced false "MISSING" failures. The check NAMES any real gap.
            $mirrorUser = Get-CtgProp $Config 'mirrorFromUser'
            if ($mirrorUser) {
                $ref = Resolve-CtgEntraUser -Identity ([string]$mirrorUser)
                if ($ref) {
                    $refGroups = @(Get-MgUserMemberOf -UserId $ref.Id -All -ErrorAction SilentlyContinue | Where-Object {
                        $ap = $_.AdditionalProperties
                        ([string](Get-CtgProp $ap '@odata.type')) -match 'microsoft\.graph\.group' -and
                        (@(Get-CtgProp $ap 'groupTypes') -notcontains 'DynamicMembership') -and
                        ((Get-CtgProp $ap 'onPremisesSyncEnabled') -ne $true)
                    })
                    $myIds = @($myMemberships | ForEach-Object { $_.Id })
                    $missing = @($refGroups | Where-Object { $myIds -notcontains $_.Id })
                    $missingNames = @($missing | ForEach-Object { [string](Get-CtgProp $_.AdditionalProperties 'displayName') }) | Where-Object { $_ }
                    $label = if ($missing.Count -eq 0) {
                        "mirror coverage — all $($refGroups.Count) of $($ref.DisplayName)'s groups present"
                    } else {
                        "mirror coverage — MISSING $($missing.Count) of $($refGroups.Count): $($missingNames -join ', ')"
                    }
                    & $add $label 0 $missing.Count
                }
            }
        }
    }
    else {
        # Offboard: a removed user trivially satisfies the teardown checks.
        & $add 'sign-in blocked' $true ([bool](-not $exists -or (Get-CtgProp $u 'AccountEnabled') -eq $false))
        if ($exists -and (Get-CtgProp $Config 'removeAllGroups') -ne $false) {
            # Count only CLOUD, non-mail, non-dynamic groups — the ones Graph can actually remove.
            # On-prem-synced (removed by the AD step), mail-enabled/DLs (Exchange), and dynamic
            # (rule-managed) legitimately remain in Entra, so they must NOT count as a failed removal.
            $remaining = @(Get-MgUserMemberOf -UserId $u.Id -All -ErrorAction SilentlyContinue |
                Where-Object {
                    (Get-CtgProp $_.AdditionalProperties '@odata.type') -eq '#microsoft.graph.group' -and
                    -not [bool](Get-CtgProp $_.AdditionalProperties 'onPremisesSyncEnabled') -and
                    -not [bool](Get-CtgProp $_.AdditionalProperties 'mailEnabled') -and
                    -not (@(Get-CtgProp $_.AdditionalProperties 'groupTypes') -contains 'DynamicMembership')
                }).Count
            & $add 'cloud groups removed' $true ([bool]($remaining -eq 0))
        }
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

# Temporary Access Pass (TAP): issue a time-boxed passcode for the new hire's first sign-in /
# passwordless registration. Default window = the START DATE at 08:00 for 240 min; both are
# config-overridable (startHour, lifetimeMinutes). The TAP value is returned so the run report can show
# it (short-lived, single onboarding use). A user may hold only ONE TAP — an existing one is replaced so
# re-runs refresh cleanly. Prereqs: TAP enabled + user-targeted in the Entra Authentication methods
# policy, and Graph UserAuthenticationMethod.ReadWrite.All consented.
function Invoke-CtgEntraTap {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()
    $upn = [string]$User.UserPrincipalName
    if (-not $upn) { throw "no UPN to issue a TAP for" }
    # TAP cmdlets ship in Microsoft.Graph.Identity.SignIns — load on demand (best-effort) so it isn't a
    # hard load-dependency of the whole M365 module; the call below errors clearly if it's truly absent.
    Import-Module Microsoft.Graph.Identity.SignIns -ErrorAction SilentlyContinue
    $u = Resolve-CtgEntraUser -Identity $upn
    if (-not $u) { throw "user not found in Entra for TAP: $upn" }

    $startHour = [int]((Get-CtgProp $Config 'startHour') ?? 8)
    $lifetime = [int]((Get-CtgProp $Config 'lifetimeMinutes') ?? 240)

    # Activation = the start date at startHour (runner-local), converted to UTC for Graph. If there's no
    # start date, or it's already in the past, omit startDateTime so the TAP is usable immediately.
    $body = @{ lifetimeInMinutes = $lifetime; isUsableOnce = $false }
    $startDate = [string](Get-CtgProp $User 'StartDate')
    if ($startDate) {
        try {
            $d = [datetime]::Parse($startDate)
            $local = Get-Date -Year $d.Year -Month $d.Month -Day $d.Day -Hour $startHour -Minute 0 -Second 0
            if ($local -gt (Get-Date)) { $body.startDateTime = $local.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
        } catch { }
    }

    # One TAP per user — clear an existing one first so a re-run reissues rather than erroring.
    try {
        $existing = @(Get-MgUserAuthenticationTemporaryAccessPassMethod -UserId $u.Id -ErrorAction SilentlyContinue)
        foreach ($e in $existing) { Invoke-CtgM365Write { Remove-MgUserAuthenticationTemporaryAccessPassMethod -UserId $u.Id -TemporaryAccessPassAuthenticationMethodId $e.Id -ErrorAction Stop } }
        if ($existing.Count) { $actions.Add("replaced an existing TAP") }
    } catch { }

    if ($PSCmdlet.ShouldProcess($upn, "issue Temporary Access Pass")) {
        try {
            $tap = Invoke-CtgM365Write { New-MgUserAuthenticationTemporaryAccessPassMethod -UserId $u.Id -BodyParameter $body -ErrorAction Stop }
            $startTxt = if ($body.ContainsKey('startDateTime')) { "activates $($body.startDateTime)" } else { "active now" }
            $code = [string](Get-CtgProp $tap 'TemporaryAccessPass')
            $actions.Add("TAP for ${upn}: $code — $startTxt, valid $lifetime min")
            Write-CtgM365Step "✓ TAP issued for $upn ($startTxt, $lifetime min)"
            return [pscustomobject]@{ System = 'tap'; Status = 'ok'; Upn = $upn; Actions = $actions.ToArray(); Tap = $code; TapStart = [string](Get-CtgProp $tap 'StartDateTime'); TapLifetimeMinutes = $lifetime }
        }
        catch {
            $m = [string]$_.Exception.Message
            # accessDenied / "Request Authorization failed" / Forbidden = the app lacks the Graph
            # PERMISSION; "not enabled"/policy = TAP isn't turned on. Both map to the same fix list, so
            # give one actionable message instead of a bare Graph error.
            if ($m -match 'accessDenied|Authorization failed|Forbidden|Insufficient privileges|not enabled|authenticationMethodsPolicy|not allowed|disabled') {
                throw "TAP could not be issued — check BOTH: (1) the Graph app has the APPLICATION permission 'UserAuthenticationMethod.ReadWrite.All' with admin consent granted in this tenant, and (2) Temporary Access Pass is ENABLED and targets this user in Entra → Authentication methods policy. Graph said: $m"
            }
            throw
        }
    }
    return [pscustomobject]@{ System = 'tap'; Status = 'ok'; Upn = $upn; Actions = $actions.ToArray() }
}

# ── Ad-hoc password reset (INC0855142) ───────────────────────────────────────────────────────────
# Operator-dispatched "Generate random password" from a case's M365/Entra line. The APP generates the
# value (revealed once to the operator, then wiped) and injects it as config.newPassword at claim;
# this executor only sets it — the plaintext must NEVER appear in the result, actions, or an error.
function Invoke-CtgM365PasswordReset {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $newPassword = [string](Get-CtgProp $Config 'newPassword')
    if ([string]::IsNullOrWhiteSpace($newPassword)) {
        throw "no newPassword in the job config — the app injects it at claim and wipes it after its one-time reveal; dispatch a fresh reset from the account line instead of re-running this job"
    }
    # Resolve the SAME way the other executors do (UPN, else unique display name).
    $upn = [string](Resolve-CtgM365Upn $User)
    if ([string]::IsNullOrWhiteSpace($upn)) { throw "no resolvable user (no UPN or unique display-name match on the case) — password not reset" }
    $u = Resolve-CtgM365User -Upn $upn -Property @('Id', 'UserPrincipalName', 'OnPremisesSyncEnabled')
    if (-not $u) { throw "M365 user '$upn' not found — password not reset" }
    if ((Get-CtgProp $u 'OnPremisesSyncEnabled') -eq $true) {
        throw "'$upn' is AD-synced (directory-synced) — reset the password on the Active Directory line instead; Entra rejects cloud resets for synced users unless password write-back is enabled"
    }
    $actions = [System.Collections.Generic.List[string]]::new()
    if ($PSCmdlet.ShouldProcess($upn, "Reset password")) {
        try {
            Update-MgUser -UserId $u.Id -PasswordProfile @{ Password = $newPassword; ForceChangePasswordNextSignIn = $true } -ErrorAction Stop
        } catch { throw "resetting the password for '$upn': $($_.Exception.Message)" }
        $actions.Add("reset password for $upn (must change at next sign-in; shown once to the operator, never stored)")
    }
    [pscustomobject]@{ System = 'm365-password-reset'; Status = 'ok'; Upn = $upn; Actions = $actions.ToArray() }
}

Export-ModuleMember -Function Connect-CtgM365, New-CtgCompliantPassword, Resolve-CtgSkuId, Set-CtgSeatAwareLicense, Invoke-CtgM365CloudMirror, Resolve-CtgM365Upn, Get-CtgM365UserDevices, Invoke-CtgM365Onboarding, Invoke-CtgM365Offboarding, Confirm-CtgM365, Invoke-CtgEntraTap, Invoke-CtgM365PasswordReset
