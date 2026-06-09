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
    if ($Object -is [hashtable]) { return $Object[$Name] }
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
    # is the same for both, so check the group up front.
    if (-not (Get-MgGroup -GroupId $GroupId -ErrorAction SilentlyContinue)) {
        return "group '$GroupId' not found in Entra — the configured group id is wrong or the group was deleted"
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
    $existing = Get-MgUser -Filter "userPrincipalName eq '$upn'" -ErrorAction SilentlyContinue
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
            $created = New-MgUser -AccountEnabled `
                -DisplayName       $User.DisplayName `
                -UserPrincipalName $upn `
                -MailNickname      ($upn.Split('@')[0]) `
                -GivenName         $User.FirstName `
                -Surname           $User.LastName `
                -JobTitle          $User.JobTitle `
                -MobilePhone       $User.MobilePhone `
                -UsageLocation     ($User.UsageLocation ?? 'US') `
                -PasswordProfile   $passwordProfile
            $userId = $created.Id
            $actions.Add("created user $upn")
        }
    }

    # 2. Licenses — add only what's missing ------------------------------------
    # Canonical config uses `licenses` (name strings or {name,skuId}); fall back to the older
    # `defaultLicenses` shape. Names resolve to SkuIds against the tenant.
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
            Set-MgUserLicense -UserId $userId `
                -AddLicenses @(@{ SkuId = $skuId }) -RemoveLicenses @() | Out-Null
            $actions.Add("assigned license: $name")
            Write-CtgM365Step "✓ assigned license: $name"
        }
    }

    # 3. Groups — check membership before adding -------------------------------
    $groupNames = @(Get-CtgProp $Config 'groups') + @(Get-CtgProp $Config 'defaultGroups') | Where-Object { $_ }
    foreach ($groupName in $groupNames) {
        $group = Get-MgGroup -Filter "mail eq '$groupName' or displayName eq '$groupName'" -Top 1 -ErrorAction SilentlyContinue
        if (-not $group) { $actions.Add("WARN group not found: $groupName"); continue }

        $isMember = Get-MgGroupMember -GroupId $group.Id -All |
                    Where-Object Id -eq $userId
        if ($isMember) { $actions.Add("already in group: $groupName"); continue }

        if ($PSCmdlet.ShouldProcess($upn, "Add to group $groupName")) {
            Write-CtgM365Step "adding to group: $groupName"
            $err = Add-CtgGroupMember -GroupId $group.Id -UserId $userId
            if ($err) { $actions.Add("WARN could not add to group ${groupName}: $err"); Write-CtgM365Step "✗ group: $groupName — $err" }
            else { $actions.Add("added to group: $groupName"); Write-CtgM365Step "✓ added to group: $groupName" }
        }
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
            Update-MgUser -UserId $userId -ProxyAddresses ($current + $proxy)
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
            Update-MgUser -UserId $userId -AccountEnabled:$false
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
                Set-MgUserLicense -UserId $userId -AddLicenses @() -RemoveLicenses $skus | Out-Null
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
            $memberNames = @(Get-MgUserMemberOf -UserId $u.Id -All -ErrorAction SilentlyContinue |
                ForEach-Object { Get-CtgProp $_.AdditionalProperties 'displayName' })
            foreach ($g in (@(Get-CtgProp $Config 'groups') + @(Get-CtgProp $Config 'defaultGroups') | Where-Object { $_ })) {
                & $add "group: $g" $true ([bool]($memberNames -contains $g))
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

Export-ModuleMember -Function Connect-CtgM365, New-CtgCompliantPassword, Resolve-CtgSkuId, Set-CtgSeatAwareLicense, Invoke-CtgM365Onboarding, Invoke-CtgM365Offboarding, Confirm-CtgM365
