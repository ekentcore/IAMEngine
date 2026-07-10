#Requires -Version 7.0

# Coretelligent.ActiveDirectory
# On-prem AD user lifecycle. Runs on the client-network agent against the local DC (the
# ActiveDirectory PowerShell module), never centrally. Identity origin for ad-synced /
# ad-standalone clients. Everything is idempotent: safe to re-run after a partial failure.
#
# Public surface:
#   Invoke-CtgADOnboarding   - create user in the OU, attributes, home drive, groups
#   Invoke-CtgADOffboarding  - reset, evidence + remove groups, hide-GAL, disable, (maybe) move
#
# The do-not-move-ou guardrail is load-bearing: for some clients moving the user's OU deletes
# the synced 365 account, so the move is skipped when the guardrail is present.

Set-StrictMode -Version Latest

#region helpers ---------------------------------------------------------------

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [hashtable]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

# Narrate into the live run-report progress (Send-CtgProgress is the runner's global poster; absent
# under Pester, so guard it). Narration must never change behaviour.
function Write-CtgADStep([string]$Message) {
    if (Get-Command Send-CtgProgress -ErrorAction SilentlyContinue) { Send-CtgProgress $Message }
}

# Domain FQDN -> distinguished name: "61commodities.com" -> "DC=61commodities,DC=com".
function ConvertTo-CtgDomainDn {
    param([string]$Domain)
    if ([string]::IsNullOrWhiteSpace($Domain)) { return '' }
    ($Domain.Split('.') | ForEach-Object { "DC=$_" }) -join ','
}

# Resolve an OU config value to a full DN. Accepts a full DN, or a bare OU name to be placed
# under the client's domain root.
function Resolve-CtgOuPath {
    param([string]$Ou, [string]$Domain)
    if ([string]::IsNullOrWhiteSpace($Ou)) { return (ConvertTo-CtgDomainDn $Domain) }
    if ($Ou -match 'DC=') { return $Ou }                     # already a full DN
    if ($Ou -match '^OU=') { return "$Ou,$(ConvertTo-CtgDomainDn $Domain)" }
    "OU=$Ou,$(ConvertTo-CtgDomainDn $Domain)"
}

# The base for AD DNs must be the ACTUAL AD domain (from the connected DC), NOT the user's email/UPN
# PrimaryDomain. They differ whenever the AD domain is a subdomain of the mail domain (AD
# corp.example.com vs mail example.com) — and building a DN from the mail domain targets a naming
# context the DC isn't authoritative for, so New-ADUser fails "The server is unwilling to process the
# request". Query the connected domain (honouring the -Server/-Credential splat); fall back to the
# supplied email domain only if the query fails, so read-only/offline callers still get *a* value.
function Resolve-CtgAdDomain {
    param([hashtable]$AdConnection = @{}, [string]$Fallback)
    try {
        $root = (Get-ADDomain @AdConnection -ErrorAction Stop).DNSRoot
        if ($root) { return [string]$root }
    } catch { }
    return $Fallback
}

# Space/punctuation-insensitive AD group lookup. A profile often has a group name that's off only by
# spacing ("Perimeter81 Users" vs the real "Perimeter 81 Users") or punctuation. Try the exact identity
# first; if that misses, search a small candidate set (by the first alphabetic token) and match on a
# NORMALIZED name (letters+digits only, lowercased). Returns the AD group object on a SINGLE confident
# match, else $null (0 or ambiguous -> caller keeps the original name + warns). Read-only.
function Resolve-CtgAdGroup {
    param([Parameter(Mandatory)][string]$Name, [hashtable]$AdConnection = @{})
    if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
    $exact = Get-ADGroup -Identity $Name -ErrorAction SilentlyContinue @AdConnection
    if ($exact) { return $exact }
    $norm = { param($s) ([string]$s -replace '[^A-Za-z0-9]', '').ToLowerInvariant() }
    $target = & $norm $Name
    if (-not $target) { return $null }
    $token = ([regex]::Match($Name, '[A-Za-z]{3,}')).Value   # keep the AD query narrow
    if (-not $token) { return $null }
    $cands = @(Get-ADGroup -Filter "Name -like '*$token*'" -ErrorAction SilentlyContinue @AdConnection)
    $hits = @($cands | Where-Object { (& $norm $_.Name) -eq $target })
    if (@($hits).Count -eq 1) { return $hits[0] }
    return $null
}

# Evaluate a conditional-group rule like "avd == true" against the user object.
function Test-CtgCondition {
    param([string]$When, $User)
    if ([string]::IsNullOrWhiteSpace($When)) { return $true }
    if ($When -match '^\s*(\w+)\s*==\s*(true|false)\s*$') {
        $field = $Matches[1]; $want = [bool]::Parse($Matches[2])
        $have = [bool](Get-CtgProp $User $field)
        return ($have -eq $want)
    }
    return $false   # unrecognized condition -> don't add (reviewer can widen later)
}

#endregion

# Apply a directory-attribute map (the planner's resolved $Config.attributes) generically: each
# attribute is Set-ADUser -Replace'd, so a new attribute is a profile edit with NO module change.
# `manager` is special — it's a DN-valued attribute, so a readable name is resolved to a DN first.
# Returns the list of applied "name=value" pairs (for the actions log).
function Set-CtgADAttributes {
    # $AdConnection is splatted onto every AD cmdlet: @{ Server=<dc>; Credential=<pscred> } when the
    # brokered ad-dc secret drives auth (Option 2), or empty @{} to use the runner's ambient context.
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$Identity, $Attributes, [hashtable]$AdConnection = @{})
    $applied = [System.Collections.Generic.List[string]]::new()
    if (-not $Attributes) { return $applied.ToArray() }
    # Works for a JSON-deserialized pscustomobject (production) or a hashtable (tests).
    $names = if ($Attributes -is [hashtable]) { @($Attributes.Keys) } else { @($Attributes.PSObject.Properties.Name) }
    foreach ($name in $names) {
        $value = if ($Attributes -is [hashtable]) { $Attributes[$name] } else { $Attributes.$name }
        if ($null -eq $value -or "$value" -eq '') { continue }
        if ($name -ieq 'manager') {
            # already a DN? else resolve by name — escape quotes, and refuse to guess on ambiguity.
            $dn = if ("$value" -match '^(CN|OU)=') {
                "$value"
            }
            else {
                $safe = "$value" -replace "'", "''"
                $found = @(Get-ADUser -Filter "Name -eq '$safe'" -ErrorAction SilentlyContinue @AdConnection)
                if ($found.Count -gt 1) { Write-Warning "manager '$value' is ambiguous ($($found.Count) matches) — skipped"; $null }
                elseif ($found.Count -eq 1) { $found[0].DistinguishedName }
                else { $null }
            }
            if ($dn -and $PSCmdlet.ShouldProcess($Identity, "Set manager = $dn")) {
                Set-ADUser -Identity $Identity -Manager $dn -ErrorAction Continue @AdConnection
                $applied.Add("manager=$dn")
            }
            continue
        }
        # countryCode is an Integer-syntax AD attribute; cast so a templated "840" doesn't fail.
        $replaceVal = if ($name -ieq 'countryCode') { [int]$value } else { $value }
        if ($PSCmdlet.ShouldProcess($Identity, "Set $name = $value")) {
            Set-ADUser -Identity $Identity -Replace @{ $name = $replaceVal } -ErrorAction Continue @AdConnection
            $applied.Add("$name=$value")
        }
    }
    return $applied.ToArray()
}

# Resolve the "mirror <user>" directive to that reference user's live group memberships (DNs).
# Tries DisplayName, then Name, then SamAccountName. Returns the group-DN array (possibly empty)
# when the user is found, or $null when no such user — so the caller can flag a miss vs. an
# intentionally-empty membership.
function Get-CtgMirrorGroups {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$ReferenceUser, [hashtable]$AdConnection = @{})
    $esc = $ReferenceUser -replace "'", "''"
    foreach ($filter in @("DisplayName -eq '$esc'", "Name -eq '$esc'", "SamAccountName -eq '$esc'")) {
        $ref = Get-ADUser -Filter $filter -Properties MemberOf -ErrorAction SilentlyContinue @AdConnection | Select-Object -First 1
        if ($ref) { return ,@($ref.MemberOf) }
    }
    return $null
}

function Invoke-CtgADOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        # Brokered AD auth (Option 2): @{ Server=<dc>; Credential=<pscred> } — splatted onto every AD
        # cmdlet so the runner authenticates as the ad-dc account rather than its own process identity.
        [hashtable]$AdConnection = @{}
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $primarySam = Get-CtgProp $User 'SamAccountName'   # StrictMode-safe
    $primaryUpn = [string]$User.UserPrincipalName
    $domain = Resolve-CtgAdDomain -AdConnection $AdConnection -Fallback (Get-CtgProp $User 'PrimaryDomain')
    $ouPath = Resolve-CtgOuPath (Get-CtgProp $Config 'ou') $domain

    # 1. Decide WHICH account to use before creating one: check existence, confirm it's the same
    # person (name match), else fall back to an alternate username (or pause for a decision); if it
    # is, adopt it and reconcile the rest below. Mirrors Invoke-CtgM365Onboarding / Google. Candidate
    # (sam, upn) pairs = the primary plus each UPN fallback (its local part is the SamAccountName).
    $candPairs = [System.Collections.Generic.List[object]]::new()
    $candPairs.Add(@($primarySam, $primaryUpn))
    foreach ($fu in @(Get-CtgProp $User 'UserPrincipalNameFallbacks')) {
        if ($fu) { $candPairs.Add(@((($fu -split '@')[0]), [string]$fu)) }
    }
    # drop malformed locals (leading/trailing/double separator — a DC rejects them)
    $candPairs = @($candPairs | Where-Object { $_[0] -and ($_[0] -notmatch '(^[._-]|[._-]$|[._-]{2,})') })
    $wantFirst = ([string]$User.FirstName).Trim()
    $wantLast  = ([string]$User.LastName).Trim()
    $wantName  = ([string]$User.DisplayName).Trim()
    # 'adopt' = it's ours, unset = pause for a decision; a different name auto-falls-back regardless.
    $collisionPolicy = [string](Get-CtgProp $Config 'usernameCollisionPolicy')

    $sam = $null; $chosenUpn = $null; $existing = $null
    foreach ($pair in $candPairs) {
        $cand = $pair[0]; $candUpn = $pair[1]
        $found = Get-ADUser -Filter "SamAccountName -eq '$cand'" -Properties GivenName, Surname, DisplayName -ErrorAction SilentlyContinue @AdConnection
        if (-not $found) { $sam = $cand; $chosenUpn = $candUpn; break }
        $fGiven = ([string](Get-CtgProp $found 'GivenName')).Trim()
        $fSur   = ([string](Get-CtgProp $found 'Surname')).Trim()
        $fDisp  = ([string](Get-CtgProp $found 'DisplayName')).Trim()
        $sameName = ($wantFirst -and $wantLast -and $fGiven -ieq $wantFirst -and $fSur -ieq $wantLast) -or ($wantName -and $fDisp -ieq $wantName)
        if ($sameName) {
            $sam = $cand; $chosenUpn = $candUpn; $existing = $found
            $actions.Add("user exists ($cand) and matches '$(if ($fDisp) { $fDisp } else { "$fGiven $fSur" })' — same person (re-run), skipped create"); break
        }
        if (-not ($fGiven -or $fSur -or $fDisp)) {
            $sam = $cand; $chosenUpn = $candUpn; $existing = $found
            $actions.Add("user exists ($cand) — adopted (no name on the account to confirm), skipped create"); break
        }
        if ($collisionPolicy -ieq 'adopt') {
            $sam = $cand; $chosenUpn = $candUpn; $existing = $found
            $actions.Add("user exists ($cand) as '$fDisp' — operator chose ADOPT, skipped create"); break
        }
        $actions.Add("SamAccountName '$cand' is taken by a different user ($fDisp) — trying the next pattern")
    }
    if (-not $sam) {
        throw "DECISION_NEEDED:username_collision | Every candidate SamAccountName is taken by a different person: $(@($candPairs | ForEach-Object { $_[0] }) -join ', '). Add a username fallback pattern, or set usernameCollisionPolicy=adopt to reuse the existing account. | upn=$primaryUpn | name=$wantName"
    }
    if ($sam -ne $primarySam) { $actions.Add("using fallback username: $sam (primary $primarySam taken)") }

    if (-not $existing -and $PSCmdlet.ShouldProcess($sam, "Create AD user in $ouPath")) {
        # A DC won't enable an account without an initial password. Caller may override later /
        # set the same upstream password for mirror clients; this is a compliant placeholder.
        $initial = ConvertTo-SecureString ([System.Guid]::NewGuid().ToString() + '!Aa9') -AsPlainText -Force
        # Wrap so a create failure names the resolved target DN — a bare "unwilling to process the
        # request" hides WHERE it tried to write (the #1 cause is a wrong/nonexistent OU DN).
        try {
            New-ADUser -Name $User.DisplayName -SamAccountName $sam -UserPrincipalName $chosenUpn `
                -GivenName $User.FirstName -Surname $User.LastName -DisplayName $User.DisplayName `
                -Path $ouPath -Enabled $true -AccountPassword $initial `
                -OtherAttributes @{ proxyAddresses = "SMTP:$chosenUpn" } @AdConnection
        } catch {
            throw "creating user '$sam' at '$ouPath' (domain $domain): $($_.Exception.Message)"
        }
        $actions.Add("created user $sam in $ouPath")
    }

    # 2. Home drive ------------------------------------------------------------
    $home = Get-CtgProp $Config 'homeDrive'
    if ($home) {
        $unc = ((Get-CtgProp $home 'unc') -replace '<username>', $sam)
        $letter = (Get-CtgProp $home 'letter')
        if ($PSCmdlet.ShouldProcess($sam, "Map home drive ${letter}: -> $unc")) {
            Set-ADUser -Identity $sam -HomeDrive "${letter}:" -HomeDirectory $unc @AdConnection
            $actions.Add("mapped home drive ${letter}: -> $unc")
        }
    }

    # 3. Directory attributes (resolved by the planner) ------------------------
    foreach ($a in (Set-CtgADAttributes -Identity $sam -Attributes (Get-CtgProp $Config 'attributes') -AdConnection $AdConnection)) {
        $actions.Add("set attribute: $a")
    }

    # 4. Groups: base + conditional --------------------------------------------
    $groups = [System.Collections.Generic.List[string]]::new()
    foreach ($g in @(Get-CtgProp $Config 'groups')) { if ($g) { $groups.Add([string]$g) } }
    foreach ($cg in @(Get-CtgProp $Config 'conditionalGroups')) {
        if (Test-CtgCondition (Get-CtgProp $cg 'when') $User) {
            foreach ($g in @(Get-CtgProp $cg 'groups')) { if ($g) { $groups.Add([string]$g) } }
        }
    }
    # Mirror: union the reference user's live memberships (the "make them like <X>" request). Deduped
    # against the groups already chosen; Add-ADGroupMember below is idempotent, and DNs add fine.
    $mirrorUser = Get-CtgProp $Config 'mirrorFromUser'
    if ($mirrorUser) {
        $mirrorGroups = Get-CtgMirrorGroups -ReferenceUser ([string]$mirrorUser) -AdConnection $AdConnection
        if ($null -eq $mirrorGroups) {
            $actions.Add("mirror user '$mirrorUser' not found — mirror groups not applied")
        }
        else {
            $seen = [System.Collections.Generic.HashSet[string]]::new([string[]]$groups, [System.StringComparer]::OrdinalIgnoreCase)
            $added = 0
            foreach ($dn in $mirrorGroups) { if ($dn -and $seen.Add([string]$dn)) { $groups.Add([string]$dn); $added++ } }
            $actions.Add("mirrored $added group(s) from '$mirrorUser'")
        }
    }
    foreach ($group in $groups) {
        if ($PSCmdlet.ShouldProcess($sam, "Add to group $group")) {
            # -ErrorAction Stop so a real failure is visible (was SilentlyContinue, which claimed
            # success even when the add failed). "Already a member" is success. ✓/✗ to the live status.
            try {
                Add-ADGroupMember -Identity $group -Members $sam -ErrorAction Stop @AdConnection
                $actions.Add("added to group: $group")
                Write-CtgADStep "✓ added to group: $group"
            } catch {
                $msg = $_.Exception.Message
                if ($msg -match 'already a member') {
                    $actions.Add("already in group: $group")
                    Write-CtgADStep "✓ already in group: $group"
                } elseif ($msg -match '[Cc]annot find|does not exist|No such object|not.*found|identity') {
                    # Group name is likely off by spacing/punctuation ("Perimeter81 Users" vs the real
                    # "Perimeter 81 Users"). Resolve it to a real AD group by a normalized match and retry.
                    $resolved = Resolve-CtgAdGroup -Name $group -AdConnection $AdConnection
                    if ($resolved) {
                        try {
                            Add-ADGroupMember -Identity $resolved.DistinguishedName -Members $sam -ErrorAction Stop @AdConnection
                            $actions.Add("added to group: $($resolved.Name) (matched config '$group')")
                            Write-CtgADStep "✓ group: $($resolved.Name) — matched '$group'"
                        } catch {
                            if ($_.Exception.Message -match 'already a member') { $actions.Add("already in group: $($resolved.Name) (matched '$group')") }
                            else { $actions.Add("WARN could not add to group '$($resolved.Name)' (matched '$group'): $($_.Exception.Message)") ; Write-CtgADStep "✗ group: $($resolved.Name) — $($_.Exception.Message)" }
                        }
                    } else {
                        $actions.Add("WARN group not found in AD: '$group' (no unique space/punctuation match — check the name in the rules editor)")
                        Write-CtgADStep "✗ group not found: $group"
                    }
                } else {
                    $actions.Add("WARN could not add to group ${group}: $msg")
                    Write-CtgADStep "✗ group: $group — $msg"
                }
            }
        }
    }

    [pscustomobject]@{ System = 'active-directory'; Status = 'ok'; Sam = $sam; Ou = $ouPath; Actions = $actions.ToArray() }
}

function Test-CtgADProtectedGroup {
    # Is this group a privileged group to NEVER strip on offboard? Used by BOTH the executor (skip
    # removal) and the validator (don't count as a miss):
    #   - well-known privileged group NAMES (the add-on),
    #   - an "*Privileged* OU" DN pattern (matches Offboarding_User.ps1's protected-group detection),
    #   - an explicit config list (protectedGroups).
    # protectPrivilegedGroups:false disables it. Config: protectedGroupPattern, protectedGroups.
    param($Group, $Config)
    if ((Get-CtgProp $Config 'protectPrivilegedGroups') -eq $false) { return $false }
    $wellKnown = @('Domain Admins', 'Enterprise Admins', 'Schema Admins', 'Administrators',
        'Account Operators', 'Backup Operators', 'Server Operators', 'Print Operators',
        'Group Policy Creator Owners', 'DnsAdmins', 'Key Admins', 'Enterprise Key Admins')
    $names = @($wellKnown + @(Get-CtgProp $Config 'protectedGroups' | Where-Object { $_ }) | ForEach-Object { "$_".ToLower() })
    if ($names -contains "$(Get-CtgProp $Group 'Name')".ToLower()) { return $true }
    $pattern = [string]((Get-CtgProp $Config 'protectedGroupPattern') ?? '*,OU=*Privileged,*')
    $dn = [string](Get-CtgProp $Group 'DistinguishedName')
    return ($pattern -and $dn -and ($dn -like $pattern))
}

function Invoke-CtgADOffboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [hashtable]$AdConnection = @{}
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    # StrictMode-safe: the incident offboard payload may have no SamAccountName property at all.
    $sam = [string](Get-CtgProp $User 'SamAccountName')
    $displayName = [string](Get-CtgProp $User 'DisplayName')

    # Resolve by SamAccountName when present, else by DISPLAY NAME against AD (offboard intakes often
    # carry only the name). Exactly-one match is authoritative; 0/many -> stop with a clear note.
    $existing = $null
    if (-not [string]::IsNullOrWhiteSpace($sam)) {
        $existing = Get-ADUser -Identity $sam -Properties MemberOf, DistinguishedName -ErrorAction SilentlyContinue @AdConnection
    }
    if (-not $existing -and $displayName) {
        $dnEsc = $displayName -replace "'", "''"   # escape quotes so "Sean O'Brien" can't break the AD filter
        $byName = @(Get-ADUser -Filter "DisplayName -eq '$dnEsc'" -Properties MemberOf, DistinguishedName -ErrorAction SilentlyContinue @AdConnection)
        if ($byName.Count -eq 1) {
            $existing = $byName[0]; $sam = [string](Get-CtgProp $existing 'SamAccountName')
            $actions.Add("resolved offboard target by display name '$displayName' -> $sam")
        }
        elseif ($byName.Count -gt 1) {
            return [pscustomobject]@{ System='active-directory'; Status='ok'; Sam=$sam; Actions=@("WARN $($byName.Count) AD users match display name '$displayName' — set the exact account on the case. Nothing done."); Evidence=@{ Groups=@() } }
        }
    }
    if ([string]::IsNullOrWhiteSpace($sam) -and -not $existing) {
        return [pscustomobject]@{ System='active-directory'; Status='ok'; Sam=$sam; Actions=@("WARN no user identity on the case (no SamAccountName, and no display-name match) — set the offboard target on the case, then re-run. Nothing done."); Evidence=@{ Groups=@() } }
    }
    if (-not $existing) {
        return [pscustomobject]@{ System='active-directory'; Status='ok'; Sam=$sam; Actions=@("user not found ($(if($sam){$sam}else{$displayName}))"); Evidence=@{ Groups=@() } }
    }
    $guardrails = @(Get-CtgProp $Config 'guardrails')

    # 1. Reset password --------------------------------------------------------
    if ((Get-CtgProp $Config 'resetPassword')) {
        if ($PSCmdlet.ShouldProcess($sam, "Reset password")) {
            $new = ConvertTo-SecureString ([System.Guid]::NewGuid().ToString() + '!Aa9') -AsPlainText -Force
            Set-ADAccountPassword -Identity $sam -Reset -NewPassword $new @AdConnection
            $actions.Add("reset password")
        }
    }

    # 2. Evidence FIRST, then remove groups (primary group can't be removed) ----
    $memberships = @(Get-ADPrincipalGroupMembership -Identity $sam -ErrorAction SilentlyContinue @AdConnection)
    $groupNames = @($memberships | ForEach-Object { $_.Name })
    $actions.Add("captured $($groupNames.Count) group membership(s) as evidence")

    # 2a. Set "Disabled Users" as the PRIMARY group BEFORE stripping groups. A primary group can't be
    # removed while it's primary, and every user must have one — so make the Disabled Users group
    # primary first, which then lets remove-all-groups strip the original primary (e.g. Domain Users).
    $primaryGroup = [string]((Get-CtgProp $Config 'disabledUsersPrimaryGroup') ?? (Get-CtgProp $Config 'disabledUsersGroup'))
    if ($primaryGroup) {
        if ($PSCmdlet.ShouldProcess($sam, "Set '$primaryGroup' as primary group")) {
            try {
                $grp = Get-ADGroup -Identity $primaryGroup -Properties primaryGroupToken @AdConnection
                if (-not ($memberships | Where-Object { $_.Name -eq $grp.Name })) {
                    Add-ADGroupMember -Identity $grp -Members $sam -ErrorAction Stop @AdConnection
                    $actions.Add("added to $primaryGroup (for primary-group assignment)")
                }
                $current = (Get-ADUser -Identity $sam -Properties primaryGroupID @AdConnection).primaryGroupID
                if ($current -eq $grp.primaryGroupToken) {
                    $actions.Add("'$primaryGroup' is already the primary group — no change")
                }
                else {
                    Set-ADUser -Identity $sam -Replace @{ primaryGroupID = $grp.primaryGroupToken } @AdConnection
                    $actions.Add("set '$primaryGroup' as the primary group")
                }
            }
            catch { $actions.Add("WARN could not set '$primaryGroup' as primary group: $($_.Exception.Message)") }
        }
    }

    # 2b. Privileged-group protection. Offboarding_User.ps1 detects groups under an "*Privileged*" OU
    # and prints "please manually remove" — but then strips them anyway (warn-but-remove). Here we
    # detect them the same way AND actually SKIP them, recording each as a manual-removal item so a
    # privileged membership is never silently torn down (and never left without a paper trail).
    $protectedFound = @()

    if ((Get-CtgProp $Config 'removeAllGroups')) {
        foreach ($g in $memberships) {
            if ($g.Name -eq 'Domain Users') { continue }   # the OLD default primary — not removable this way
            # The "Disabled Users" group is now the user's PRIMARY group (set in step 2a) — a primary
            # group can't be removed and isn't supposed to be. Skip it cleanly (it's intentionally kept),
            # not a warning.
            if ($primaryGroup -and "$($g.Name)" -ieq $primaryGroup) {
                $actions.Add("kept '$($g.Name)' — the user's primary group (set in this offboard); intentionally not removed")
                continue
            }
            if (Test-CtgADProtectedGroup -Group $g -Config $Config) {
                $protectedFound += $g.Name
                $actions.Add("WARN protected/privileged group NOT removed — remove manually: $($g.Name)")
                Write-CtgADStep "⚠ protected group — manual removal required: $($g.Name)"
                continue
            }
            if ($PSCmdlet.ShouldProcess($sam, "Remove from group $($g.Name)")) {
                # Remove by DistinguishedName, NOT Name. Remove-ADGroupMember -Identity resolves a group
                # by DN / objectGUID / SID / sAMAccountName — never the CN/Name. For groups whose
                # sAMAccountName differs from their display name (Teams/M365-provisioned "<name>_<hex>"
                # groups, or names with spaces), passing $g.Name fails "cannot find an object with
                # identity" even though the group plainly exists — which also left the user still in the
                # groups, so the "groups removed" validation missed. The DN always resolves.
                $gid = if ($g.DistinguishedName) { $g.DistinguishedName } else { $g.Name }
                # -ErrorAction Stop so a failed removal is surfaced, not silently logged as success.
                try {
                    Remove-ADGroupMember -Identity $gid -Members $sam -Confirm:$false -ErrorAction Stop @AdConnection
                    $actions.Add("removed from group: $($g.Name)")
                    Write-CtgADStep "✓ removed from group: $($g.Name)"
                } catch {
                    $actions.Add("WARN could not remove from group $($g.Name): $($_.Exception.Message)")
                    Write-CtgADStep "✗ group: $($g.Name) — $($_.Exception.Message)"
                }
            }
        }
    }

    # 2b. Remove the SPECIFIC groups named by the offboard rules (config.removeGroups), if the user
    # is actually a member. Independent of removeAllGroups (and a no-op once that already stripped all).
    $removeGroups = @(Get-CtgProp $Config 'removeGroups' | Where-Object { $_ })
    if ($removeGroups.Count) {
        $memberByLower = @{}; foreach ($g in $memberships) { $memberByLower["$($g.Name)".ToLower()] = $g }
        foreach ($name in $removeGroups) {
            if ("$name" -ieq 'Domain Users') { continue }
            $grpObj = $memberByLower["$name".ToLower()]   # the real group object the user belongs to
            if (-not $grpObj) { $actions.Add("not a member of $name (skip)"); continue }
            # Resolve by DN (see the removeAllGroups note above) — a Name-based identity fails for
            # groups whose sAMAccountName differs from their display name.
            $gid = if ($grpObj.DistinguishedName) { $grpObj.DistinguishedName } else { $grpObj.Name }
            if ($PSCmdlet.ShouldProcess($sam, "Remove from group $($grpObj.Name)")) {
                Remove-ADGroupMember -Identity $gid -Members $sam -Confirm:$false -ErrorAction SilentlyContinue @AdConnection
                $actions.Add("removed from group: $($grpObj.Name)")
            }
        }
    }

    # 3. Hide from GAL ---------------------------------------------------------
    $hide = Get-CtgProp $Config 'hideFromGal'
    if ($hide) {
        $attr = Get-CtgProp $hide 'attribute'; $val = Get-CtgProp $hide 'value'
        if ($attr -and $PSCmdlet.ShouldProcess($sam, "Hide from GAL ($attr=$val)")) {
            Set-ADUser -Identity $sam -Replace @{ $attr = $val } @AdConnection
            $actions.Add("hid from GAL: $attr=$val")
        }
    }

    # 4. Remove manager --------------------------------------------------------
    if ($PSCmdlet.ShouldProcess($sam, "Clear manager")) {
        Set-ADUser -Identity $sam -Clear manager @AdConnection
        $actions.Add("cleared manager")
    }

    # 4b. Offboard attributes from the rules (config.offboardAttributes) — e.g. description. AFTER the
    # manager clear so a rule that intentionally re-points 'manager' on offboard isn't undone.
    foreach ($a in (Set-CtgADAttributes -Identity $sam -Attributes (Get-CtgProp $Config 'offboardAttributes') -AdConnection $AdConnection)) {
        $actions.Add("set $a")
    }

    # 5. Disable ----------------------------------------------------------------
    if ((Get-CtgProp $Config 'disableAccount') -ne $false) {
        if ($PSCmdlet.ShouldProcess($sam, "Disable account")) {
            Disable-ADAccount -Identity $sam @AdConnection
            $actions.Add("disabled account")
        }
    }

    # 6. Move OU — UNLESS the guardrail forbids it. A rule-driven moveToOu (offboard rules) wins over
    # the system default disabledUsersOu.
    $targetOu = Get-CtgProp $Config 'moveToOu'
    if (-not $targetOu) { $targetOu = Get-CtgProp $Config 'disabledUsersOu' }
    if ($guardrails -contains 'do-not-move-ou') {
        $actions.Add("did not move OU (do-not-move-ou guardrail — moving would delete the synced 365 account)")
    }
    elseif ($targetOu) {
        # Move-ADObject needs a full DN; a bare/typo'd OU value would throw and abort the offboard.
        # Skip with a clear note instead (group removal + disable still completed above).
        if ("$targetOu" -notmatch '(?i)dc=') {
            $actions.Add("skipped move: '$targetOu' is not a full OU DN (expected OU=…,DC=…)")
        }
        elseif ($PSCmdlet.ShouldProcess($sam, "Move to $targetOu")) {
            Move-ADObject -Identity $existing.DistinguishedName -TargetPath $targetOu @AdConnection
            $actions.Add("moved to $targetOu")
        }
    }

    # 7. Disable + move the user's COMPUTER object. The machine name comes from the case (the Entra
    # device resolved by the M365 step, or config.computerName) — never guessed. Disable, then move to
    # the Disabled Computers OU when configured. Idempotent; a clean note when the computer isn't found.
    $computerInfo = $null
    $computerName = [string]((Get-CtgProp $Config 'computerName') ?? (Get-CtgProp $User 'computerName') ?? (Get-CtgProp $User 'deviceName') ?? (Get-CtgProp $User 'EntraDeviceName'))
    if ((Get-CtgProp $Config 'disableComputer') -and $computerName) {
        try {
            $comp = Get-ADComputer -Identity $computerName -Properties DistinguishedName, Enabled -ErrorAction SilentlyContinue @AdConnection
            if (-not $comp) {
                $actions.Add("computer '$computerName' not found in AD — nothing to disable")
            }
            else {
                $computerInfo = @{ Name = $comp.Name; DistinguishedName = $comp.DistinguishedName }
                if ($comp.Enabled -eq $false) {
                    $actions.Add("computer '$computerName' already disabled")
                }
                elseif ($PSCmdlet.ShouldProcess($computerName, "Disable computer")) {
                    Disable-ADAccount -Identity $comp.DistinguishedName @AdConnection
                    $actions.Add("disabled computer: $computerName")
                }
                $compOu = Get-CtgProp $Config 'disabledComputersOu'
                if ($compOu -and "$compOu" -match '(?i)dc=' -and $PSCmdlet.ShouldProcess($computerName, "Move computer to $compOu")) {
                    Move-ADObject -Identity $comp.DistinguishedName -TargetPath $compOu @AdConnection
                    $actions.Add("moved computer '$computerName' to $compOu")
                }
            }
        }
        catch { $actions.Add("WARN could not disable computer '$computerName': $($_.Exception.Message)") }
    }

    [pscustomobject]@{
        System='active-directory'; Status='ok'; Sam=$sam
        Evidence=@{ Groups = $groupNames; Computer = $computerInfo; ProtectedGroups = @($protectedFound) }
        Actions=$actions.ToArray()
    }
}

function Confirm-CtgAD {
    <#
    .SYNOPSIS
        Post-action read-back for on-prem AD. No mutations; returns { ok; checks[] }.
    .PARAMETER Action
        'onboard' (user in the OU + groups + home drive) or 'offboard' (disabled + groups
        removed + hidden from GAL + NOT moved when the do-not-move-ou guardrail is present).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action,
        [hashtable]$AdConnection = @{}
    )

    $checks = [System.Collections.Generic.List[object]]::new()
    $add = { param($name, $expected, $actual) $checks.Add(@{ name = $name; expected = $expected; actual = $actual; pass = ($expected -eq $actual) }) }
    $sam = [string](Get-CtgProp $User 'SamAccountName')   # StrictMode-safe (payload may lack the property)
    $domain = Resolve-CtgAdDomain -AdConnection $AdConnection -Fallback (Get-CtgProp $User 'PrimaryDomain')

    # Resolve the SAME way the executor does — by display name when the case has no SamAccountName —
    # so the read-back doesn't pass an empty -Identity (a hard bind error) and doesn't check the wrong
    # account (which would "miss" and re-run the offboard via the revalidate loop).
    if ([string]::IsNullOrWhiteSpace($sam)) {
        $dn = [string](Get-CtgProp $User 'DisplayName')
        if ($Action -eq 'offboard' -and $dn) {
            $dnEsc = $dn -replace "'", "''"   # escape quotes so "Sean O'Brien" can't break the AD filter
            $byName = @(Get-ADUser -Filter "DisplayName -eq '$dnEsc'" -Properties SamAccountName -ErrorAction SilentlyContinue @AdConnection)
            if ($byName.Count -eq 1) { $sam = [string](Get-CtgProp $byName[0] 'SamAccountName') }
        }
        if ([string]::IsNullOrWhiteSpace($sam)) {
            return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'no resolvable offboard target — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
        }
    }

    # Request ONLY schema-guaranteed properties here. msExchHideFromAddressLists exists only where the
    # on-prem Exchange schema is installed — an AD without it (M365/EXO-only tenants like Six One) makes
    # Get-ADUser -Properties <that> throw for the WHOLE call, so -EA SilentlyContinue would null $u and a
    # fully-onboarded user would look absent → every check "fails". The Exchange attr is fetched
    # best-effort below, only for the offboard hide-from-GAL check that actually needs it.
    $u = Get-ADUser -Identity $sam -Properties MemberOf, DistinguishedName, Enabled, HomeDirectory -ErrorAction SilentlyContinue @AdConnection
    $exists = [bool]$u
    $memberObjs = if ($exists) { @(Get-ADPrincipalGroupMembership -Identity $sam -ErrorAction SilentlyContinue @AdConnection) } else { @() }
    $groupNames = @($memberObjs | ForEach-Object { $_.Name })

    if ($Action -eq 'onboard') {
        $ouPath = Resolve-CtgOuPath (Get-CtgProp $Config 'ou') $domain
        & $add 'user exists' $true $exists
        & $add "in OU $ouPath" $true ([bool]($exists -and (Get-CtgProp $u 'DistinguishedName') -like "*$ouPath"))

        $want = [System.Collections.Generic.List[string]]::new()
        foreach ($g in @(Get-CtgProp $Config 'groups')) { if ($g) { $want.Add([string]$g) } }
        foreach ($cg in @(Get-CtgProp $Config 'conditionalGroups')) {
            if (Test-CtgCondition (Get-CtgProp $cg 'when') $User) { foreach ($g in @(Get-CtgProp $cg 'groups')) { if ($g) { $want.Add([string]$g) } } }
        }
        foreach ($g in $want) { & $add "group: $g" $true ([bool]($groupNames -contains $g)) }

        $home = Get-CtgProp $Config 'homeDrive'
        if ($home) { & $add 'home drive mapped' $true ([bool]($exists -and (Get-CtgProp $u 'HomeDirectory'))) }
    }
    else {
        & $add 'account disabled' $true ([bool](-not $exists -or (Get-CtgProp $u 'Enabled') -eq $false))
        if ($exists -and (Get-CtgProp $Config 'removeAllGroups')) {
            # Exclude the same groups the executor intentionally keeps: the primary group (Domain Users,
            # and the "Disabled Users" group we set as primary) — a primary group can't be removed — and
            # protected/privileged groups. None of these count as a failed removal.
            $primaryGroup = [string]((Get-CtgProp $Config 'disabledUsersPrimaryGroup') ?? (Get-CtgProp $Config 'disabledUsersGroup'))
            $remaining = @($memberObjs | Where-Object {
                    $_.Name -ne 'Domain Users' -and
                    -not ($primaryGroup -and "$($_.Name)" -ieq $primaryGroup) -and
                    -not (Test-CtgADProtectedGroup -Group $_ -Config $Config)
                }).Count
            & $add 'groups removed' $true ([bool]($remaining -eq 0))
        }
        $hide = Get-CtgProp $Config 'hideFromGal'
        if ($exists -and $hide -and (Get-CtgProp $hide 'attribute')) {
            # Fetch the Exchange attr best-effort (see the read-back note) so a missing schema can't fail
            # the whole validation — if it isn't queryable, treat "hidden" as not-yet-confirmed (false).
            $hidden = $false
            try { $hidden = [bool]((Get-ADUser -Identity $sam -Properties msExchHideFromAddressLists -ErrorAction Stop @AdConnection).msExchHideFromAddressLists) } catch { }
            & $add 'hidden from GAL' $true $hidden
        }
        # do-not-move-ou guardrail: the DN must NOT sit under the Disabled Users OU.
        $disabledOu = Get-CtgProp $Config 'disabledUsersOu'
        if ($exists -and (@(Get-CtgProp $Config 'guardrails') -contains 'do-not-move-ou') -and $disabledOu) {
            & $add 'not moved (do-not-move-ou)' $true ([bool]((Get-CtgProp $u 'DistinguishedName') -notlike "*$disabledOu"))
        }
    }

    $all = @($checks)
    [pscustomobject]@{ ok = (@($all | Where-Object { -not $_.pass }).Count -eq 0); checks = $all }
}

# ── AD email write-back ─────────────────────────────────────────────────────────────────────────
# After the cloud mailbox exists, record the user's email in AD's `mail` attribute. Runs on the
# client-network agent (rides the ActiveDirectory capability — no cloud creds). The app injects
# `writebackEmail` (the mailbox's ASSIGNED primary SMTP, resolved from the m365/exchange result) into
# the payload at dispatch; we fall back to the deterministic work email / UPN when it isn't present
# (older runner / no result) — the same value AD's proxyAddresses was already set to at create time.
# Idempotent: only writes when `mail` differs. Onboard-only.
function Resolve-CtgWritebackEmail($User) {
    foreach ($k in 'writebackEmail', 'workEmail', 'userPrincipalName') {
        $v = [string](Get-CtgProp $User $k)
        if (-not [string]::IsNullOrWhiteSpace($v) -and ($v -match '@')) { return $v }
    }
    return $null
}

function Invoke-CtgADEmailWriteback {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [hashtable]$AdConnection = @{}
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $email = Resolve-CtgWritebackEmail $User
    if (-not $email) {
        return [pscustomobject]@{ System = 'ad-email-writeback'; Status = 'ok'; Actions = @('no email to write back (no writebackEmail/workEmail/UPN on the case) — nothing done') }
    }

    # Resolve the just-created user: SamAccountName, else UPN, else DisplayName (exactly one).
    $sam = [string](Get-CtgProp $User 'SamAccountName')
    $upn = [string](Get-CtgProp $User 'UserPrincipalName')
    $displayName = [string](Get-CtgProp $User 'DisplayName')
    $existing = $null
    if (-not [string]::IsNullOrWhiteSpace($sam)) {
        $existing = Get-ADUser -Identity $sam -Properties mail -ErrorAction SilentlyContinue @AdConnection
    }
    if (-not $existing -and $upn) {
        $upnEsc = $upn -replace "'", "''"
        $existing = @(Get-ADUser -Filter "UserPrincipalName -eq '$upnEsc'" -Properties mail -ErrorAction SilentlyContinue @AdConnection)[0]
        if ($existing) { $sam = [string](Get-CtgProp $existing 'SamAccountName') }
    }
    if (-not $existing -and $displayName) {
        $dnEsc = $displayName -replace "'", "''"
        $byName = @(Get-ADUser -Filter "DisplayName -eq '$dnEsc'" -Properties mail -ErrorAction SilentlyContinue @AdConnection)
        if ($byName.Count -eq 1) { $existing = $byName[0]; $sam = [string](Get-CtgProp $existing 'SamAccountName') }
        elseif ($byName.Count -gt 1) {
            return [pscustomobject]@{ System = 'ad-email-writeback'; Status = 'ok'; Actions = @("WARN $($byName.Count) AD users match display name '$displayName' — can't pick one; nothing written") }
        }
    }
    if (-not $existing) {
        return [pscustomobject]@{ System = 'ad-email-writeback'; Status = 'ok'; Actions = @("user not found ($(if ($sam) { $sam } elseif ($upn) { $upn } else { $displayName })) — nothing written") }
    }

    # Idempotent: only write when the mail attribute differs from the target.
    $current = [string](Get-CtgProp $existing 'mail')
    if ($current -ieq $email) {
        $actions.Add("AD mail already '$email' — no change")
    }
    elseif ($PSCmdlet.ShouldProcess($sam, "Set AD mail = $email")) {
        try {
            Set-ADUser -Identity $sam -EmailAddress $email -ErrorAction Stop @AdConnection
            $actions.Add("set AD mail: '$(if ($current) { $current } else { '(unset)' })' -> '$email'")
        } catch {
            throw "setting AD mail for '$sam' to '$email': $($_.Exception.Message)"
        }
    }

    [pscustomobject]@{ System = 'ad-email-writeback'; Status = 'ok'; Sam = $sam; Mail = $email; Actions = $actions.ToArray() }
}

function Confirm-CtgADEmailWriteback {
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [hashtable]$AdConnection = @{}
    )
    $email = Resolve-CtgWritebackEmail $User
    $sam = [string](Get-CtgProp $User 'SamAccountName')
    $u = if ($sam) { Get-ADUser -Identity $sam -Properties mail -ErrorAction SilentlyContinue @AdConnection } else { $null }
    $actual = [string](Get-CtgProp $u 'mail')
    $pass = [bool]($email -and $actual -and ($actual -ieq $email))
    [pscustomobject]@{ ok = $pass; checks = @(@{ name = "AD mail = $email"; expected = $email; actual = $actual; pass = $pass }) }
}

# ── Hybrid identity-link CHECK (Design D, DETECT-ONLY) ────────────────────────────────────────────
# Verify that the on-prem AD object will LINK to its Entra object rather than spawn a duplicate: the
# Entra source anchor (immutableId) must equal base64(objectGUID) OR base64(mS-DS-ConsistencyGuid).
# The app injects the Entra object's { immutableId, syncEnabled, userId } (from the m365 result) into
# the payload as `cloudObject`. We only READ + FLAG here — no write (that's a later level). Onboard-only.
function Get-CtgAdCaseUser {
    param([pscustomobject]$User, [string[]]$Properties, [hashtable]$AdConnection = @{})
    $sam = [string](Get-CtgProp $User 'SamAccountName')
    $upn = [string](Get-CtgProp $User 'UserPrincipalName')
    $displayName = [string](Get-CtgProp $User 'DisplayName')
    $u = $null
    if (-not [string]::IsNullOrWhiteSpace($sam)) { $u = Get-ADUser -Identity $sam -Properties $Properties -ErrorAction SilentlyContinue @AdConnection }
    if (-not $u -and $upn) { $u = @(Get-ADUser -Filter "UserPrincipalName -eq '$($upn -replace "'", "''")'" -Properties $Properties -ErrorAction SilentlyContinue @AdConnection)[0] }
    if (-not $u -and $displayName) {
        $byName = @(Get-ADUser -Filter "DisplayName -eq '$($displayName -replace "'", "''")'" -Properties $Properties -ErrorAction SilentlyContinue @AdConnection)
        if ($byName.Count -eq 1) { $u = $byName[0] }
    }
    return $u
}

function Invoke-CtgADConsistencyCheck {
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [hashtable]$AdConnection = @{}
    )
    $u = Get-CtgAdCaseUser -User $User -Properties @('objectGUID', 'mS-DS-ConsistencyGuid') -AdConnection $AdConnection
    if (-not $u) {
        return [pscustomobject]@{ System = 'ad-consistency-check'; Status = 'ok'; Actions = @('on-prem user not found — nothing to check') }
    }
    # Both possible source anchors, as the base64 immutableId form AAD Connect uses.
    $anchors = [System.Collections.Generic.List[string]]::new()
    $og = Get-CtgProp $u 'objectGUID'
    if ($og) { try { $anchors.Add([System.Convert]::ToBase64String(([guid]$og).ToByteArray())) } catch {} }
    $cg = Get-CtgProp $u 'mS-DS-ConsistencyGuid'
    if ($cg) { try { $anchors.Add([System.Convert]::ToBase64String([byte[]]$cg)) } catch {} }

    $cloud = Get-CtgProp $User 'cloudObject'
    $immutableId = [string](Get-CtgProp $cloud 'immutableId')
    $syncEnabled = Get-CtgProp $cloud 'syncEnabled'
    $userId = [string](Get-CtgProp $cloud 'userId')

    $actions = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($userId)) {
        $actions.Add('no matching Entra object reported — a fresh sync will create + anchor it (ok)')
    }
    elseif ($syncEnabled -eq $false) {
        # A cloud-ONLY object exists (not synced from AD) — the on-prem user will NOT hard-match it and
        # AAD Connect will create a second object. This is the duplicate risk the operator must resolve.
        $actions.Add("WARN a CLOUD-ONLY Entra object exists for this user (id $userId) — the on-prem account won't link to it; AAD Connect will create a DUPLICATE. Hard-match it (set mS-DS-ConsistencyGuid to the cloud immutableId) or soft-match by primary SMTP before syncing.")
    }
    elseif ([string]::IsNullOrWhiteSpace($immutableId)) {
        $actions.Add("Entra object $userId is sync-enabled but reported no immutableId — can't confirm the anchor from here; treat as linked")
    }
    elseif ($anchors -contains $immutableId) {
        $actions.Add("linked: Entra immutableId matches the on-prem source anchor (objectGUID / mS-DS-ConsistencyGuid)")
    }
    else {
        $actions.Add("WARN Entra immutableId ($immutableId) does NOT match the on-prem source anchor ($($anchors -join ' / ')) — the objects may be UNLINKED (possible duplicate). Verify the AAD Connect source anchor.")
    }

    $warned = @($actions | Where-Object { $_ -like 'WARN*' }).Count
    [pscustomobject]@{ System = 'ad-consistency-check'; Status = 'ok'; Sam = [string](Get-CtgProp $u 'SamAccountName'); Flagged = ($warned -gt 0); Actions = $actions.ToArray() }
}

Export-ModuleMember -Function Invoke-CtgADOnboarding, Invoke-CtgADOffboarding, Invoke-CtgADEmailWriteback, Confirm-CtgADEmailWriteback, Invoke-CtgADConsistencyCheck, Set-CtgADAttributes, Get-CtgMirrorGroups, Test-CtgCondition, Resolve-CtgOuPath, Confirm-CtgAD
