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
    param([Parameter(Mandatory)][string]$Identity)
    $u = Get-MgUser -Filter "userPrincipalName eq '$Identity'" -ErrorAction SilentlyContinue
    if (-not $u) { $u = Get-MgUser -Filter "displayName eq '$Identity'" -Top 1 -ErrorAction SilentlyContinue }
    $u
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

    # 1. Ensure the user exists -------------------------------------------------
    # Direct GET by UPN first (strongly consistent); the filter query is the fallback — right
    # after a create the filter index can lag and a throttle is silently swallowed, both of
    # which made a re-run think the user was missing.
    $existing = Get-MgUser -UserId $upn -ErrorAction SilentlyContinue
    if (-not $existing) { $existing = Get-MgUser -Filter "userPrincipalName eq '$upn'" -ErrorAction SilentlyContinue }
    if ($existing) {
        $userId = $existing.Id
        $actions.Add("user exists ($upn) — skipped create")
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

    # 2. Licenses — add only what's missing ------------------------------------
    # Canonical config uses `licenses` (name strings or {name,skuId}); fall back to the older
    # `defaultLicenses` shape. Names resolve to SkuIds against the tenant.
    $seatShortage = $false  # set when an assignment fails for no seats -> return the SKU inventory so the operator can pick another
    $licenseSpecs = @(Get-CtgProp $Config 'licenses') + @(Get-CtgProp $Config 'defaultLicenses') | Where-Object { $_ }
    $assigned = @(Get-MgUserLicenseDetail -UserId $userId -ErrorAction SilentlyContinue | ForEach-Object { $_.SkuId })
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
                # No seats left in the tenant: don't fail the onboard — the account is already created,
                # it just needs a license ordered. Surface a clear procurement action; the step is a
                # warning, not a failure.
                if ($_.Exception.Message -match 'does not have any available licenses|no available licenses|not have any available') {
                    $seatShortage = $true
                    $actions.Add("WARN no available '$name' license seats — user CREATED UNLICENSED. Pick another license below (owned SKUs + free seats shown), or open a Procurement Case to order a $name license, then re-run.")
                    Write-CtgM365Step "⚠ $name — no seats available; user left unlicensed. Pick another license or order one."
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
    foreach ($gspec in $groupSpecs) {
        $gname = if ($gspec -is [string]) { $gspec } else { [string](Get-CtgProp $gspec 'name') }
        $hint  = if ($gspec -is [string]) { $null } else { [string](Get-CtgProp $gspec 'type') }
        if ([string]::IsNullOrWhiteSpace($gname)) { continue }
        Write-CtgM365Step "checking group: $gname$(if ($hint) { " (documented as $hint)" })"
        $group = Get-MgGroup -Filter "mail eq '$gname' or displayName eq '$gname'" -Top 1 -ErrorAction SilentlyContinue
        if (-not $group) {
            $actions.Add("group '$gname' not a Graph group (security/365) — the Exchange step will check it as a distribution list")
            Write-CtgM365Step "↷ $gname — not a security/365 group; Exchange step tries it as a distribution list"
            continue
        }
        $isUnified   = @(Get-CtgProp $group 'GroupTypes') -contains 'Unified'
        $mailEnabled = (Get-CtgProp $group 'MailEnabled') -eq $true
        $secEnabled  = (Get-CtgProp $group 'SecurityEnabled') -eq $true
        $kind = if ($isUnified) { 'Microsoft 365 group' } elseif ($mailEnabled) { 'distribution/mail-enabled group' } elseif ($secEnabled) { 'Security group' } else { 'group' }
        Write-CtgM365Step "→ $gname is a $kind"
        if ($mailEnabled -and -not $isUnified) {
            # Graph cannot add DLs / mail-enabled security groups — the Exchange lane does.
            $actions.Add("$gname → $kind — added by the Exchange step (Graph can't write distribution/mail-enabled groups)")
            Write-CtgM365Step "↷ $gname — $kind, handled by the Exchange step"
            continue
        }
        $isMember = @(Get-MgGroupMember -GroupId $group.Id -All -ErrorAction SilentlyContinue | ForEach-Object Id) -contains $userId
        if ($isMember) { $actions.Add("already in $kind`: $gname"); Write-CtgM365Step "✓ already in $gname"; continue }
        if ($PSCmdlet.ShouldProcess($upn, "Add to $kind $gname")) {
            Write-CtgM365Step "adding to $kind`: $gname"
            $err = Add-CtgGroupMember -GroupId $group.Id -UserId $userId
            if ($err) { $actions.Add("WARN could not add to $kind ${gname}: $err"); Write-CtgM365Step "✗ $gname — $err" }
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
    [pscustomobject]@{
        System  = 'm365'
        Status  = 'ok'
        UserId  = $userId
        Upn     = $upn
        LicenseFallbackAdGroup = $licenseFallbackAdGroup  # AD group the runner must add (E3 fallback), or $null
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
    $upn = $User.UserPrincipalName

    $existing = Get-MgUser -Filter "userPrincipalName eq '$upn'" -ErrorAction SilentlyContinue
    if (-not $existing) {
        return [pscustomobject]@{ System = 'm365'; Status = 'ok'; Upn = $upn; Actions = @("user not found ($upn) — nothing to offboard"); Evidence = @{ Groups = @() } }
    }
    $userId = $existing.Id

    # 1. Evidence FIRST — snapshot group memberships before we remove anything ----
    $memberships = @(Get-MgUserMemberOf -UserId $userId -All -ErrorAction SilentlyContinue) |
        Where-Object { (Get-CtgProp $_.AdditionalProperties '@odata.type') -eq '#microsoft.graph.group' }
    $groupEvidence = foreach ($g in $memberships) {
        [pscustomobject]@{ Id = $g.Id; DisplayName = (Get-CtgProp $g.AdditionalProperties 'displayName') }
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

    # 3. Remove from all groups (evidence already captured) --------------------
    if ((Get-CtgProp $Config 'removeAllGroups') -ne $false) {
        foreach ($g in $groupEvidence) {
            if ($PSCmdlet.ShouldProcess($upn, "Remove from group $($g.DisplayName)")) {
                try {
                    Remove-MgGroupMemberByRef -GroupId $g.Id -DirectoryObjectId $userId -ErrorAction Stop
                    $actions.Add("removed from group: $($g.DisplayName)")
                }
                catch { $actions.Add("WARN could not remove from $($g.DisplayName): $($_.Exception.Message)") }
            }
        }
    }

    # 4. OneDrive backup — flagged for the data-transfer step (not done inline) -
    $oneDrive = Get-CtgProp $Config 'oneDriveBackup'
    if ($oneDrive) { $actions.Add("OneDrive backup required -> $((Get-CtgProp $oneDrive 'target'))") }

    # 5. License removal — honor the mailbox size threshold --------------------
    $removeLicense = Get-CtgProp $Config 'removeLicense'
    $mailbox = Get-CtgProp $Config 'mailbox'
    $threshold = if ($mailbox) { [double]((Get-CtgProp $mailbox 'sizeThresholdGB') ?? 50) } else { 50 }
    if ($null -ne $removeLicense) {
        if ($MailboxSizeGB -gt $threshold) {
            $actions.Add("license kept — mailbox $MailboxSizeGB GB is over threshold ($threshold GB); remove after mailbox handling")
        }
        elseif ($PSCmdlet.ShouldProcess($upn, "Remove licenses")) {
            $skus = @(Get-MgUserLicenseDetail -UserId $userId -ErrorAction SilentlyContinue | ForEach-Object { $_.SkuId })
            if ($skus.Count) {
                Invoke-CtgM365Write { Set-MgUserLicense -UserId $userId -AddLicenses @() -RemoveLicenses $skus } | Out-Null
                $actions.Add("removed $($skus.Count) license(s)")
            } else {
                $actions.Add("no licenses to remove")
            }
        }
    }

    [pscustomobject]@{
        System   = 'm365'
        Status   = 'ok'
        UserId   = $userId
        Upn      = $upn
        Evidence = @{ Groups = @($groupEvidence) }
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
    $upn = $User.UserPrincipalName

    $u = Get-MgUser -Filter "userPrincipalName eq '$upn'" -Property Id, AccountEnabled, UserPrincipalName -ErrorAction SilentlyContinue
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
            $memberNames = @($myMemberships | ForEach-Object { Get-CtgProp $_.AdditionalProperties 'displayName' })
            foreach ($g in (@(Get-CtgProp $Config 'groups') + @(Get-CtgProp $Config 'defaultGroups') | Where-Object { $_ })) {
                & $add "group: $g" $true ([bool]($memberNames -contains $g))
            }
            # Comprehensive mirror coverage: compare the new user's ENTIRE membership to the reference
            # user's — across ALL group types (cloud security/M365, distribution + mail-enabled added
            # by the exchange lane, AD-synced added by the AD lane), since Graph reads them all even the
            # ones it can't write. Excludes dynamic groups (rule-computed, not assignable). The check
            # NAMES any of the reference user's groups the new user is missing, so a real gap is obvious.
            $mirrorUser = Get-CtgProp $Config 'mirrorFromUser'
            if ($mirrorUser) {
                $ref = Resolve-CtgEntraUser -Identity ([string]$mirrorUser)
                if ($ref) {
                    $refGroups = @(Get-MgUserMemberOf -UserId $ref.Id -All -ErrorAction SilentlyContinue | Where-Object {
                        $ap = $_.AdditionalProperties
                        ([string](Get-CtgProp $ap '@odata.type')) -match 'microsoft\.graph\.group' -and
                        (@(Get-CtgProp $ap 'groupTypes') -notcontains 'DynamicMembership')
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
            $memberCount = @(Get-MgUserMemberOf -UserId $u.Id -All -ErrorAction SilentlyContinue |
                Where-Object { (Get-CtgProp $_.AdditionalProperties '@odata.type') -eq '#microsoft.graph.group' }).Count
            & $add 'groups removed' $true ([bool]($memberCount -eq 0))
        }
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

Export-ModuleMember -Function Connect-CtgM365, New-CtgCompliantPassword, Resolve-CtgSkuId, Set-CtgSeatAwareLicense, Invoke-CtgM365CloudMirror, Invoke-CtgM365Onboarding, Invoke-CtgM365Offboarding, Confirm-CtgM365
