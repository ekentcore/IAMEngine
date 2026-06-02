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

function Invoke-CtgADOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $sam = $User.SamAccountName
    $domain = Get-CtgProp $User 'PrimaryDomain'
    $ouPath = Resolve-CtgOuPath (Get-CtgProp $Config 'ou') $domain

    # 1. Ensure the user exists in the OU --------------------------------------
    $existing = Get-ADUser -Filter "SamAccountName -eq '$sam'" -ErrorAction SilentlyContinue
    if ($existing) {
        $actions.Add("user exists ($sam) — skipped create")
    }
    elseif ($PSCmdlet.ShouldProcess($sam, "Create AD user in $ouPath")) {
        # A DC won't enable an account without an initial password. Caller may override later /
        # set the same upstream password for mirror clients; this is a compliant placeholder.
        $initial = ConvertTo-SecureString ([System.Guid]::NewGuid().ToString() + '!Aa9') -AsPlainText -Force
        New-ADUser -Name $User.DisplayName -SamAccountName $sam -UserPrincipalName $User.UserPrincipalName `
            -GivenName $User.FirstName -Surname $User.LastName -DisplayName $User.DisplayName `
            -Path $ouPath -Enabled $true -AccountPassword $initial `
            -OtherAttributes @{ proxyAddresses = "SMTP:$($User.UserPrincipalName)" }
        $actions.Add("created user $sam in $ouPath")
    }

    # 2. Home drive ------------------------------------------------------------
    $home = Get-CtgProp $Config 'homeDrive'
    if ($home) {
        $unc = ((Get-CtgProp $home 'unc') -replace '<username>', $sam)
        $letter = (Get-CtgProp $home 'letter')
        if ($PSCmdlet.ShouldProcess($sam, "Map home drive ${letter}: -> $unc")) {
            Set-ADUser -Identity $sam -HomeDrive "${letter}:" -HomeDirectory $unc
            $actions.Add("mapped home drive ${letter}: -> $unc")
        }
    }

    # 3. Groups: base + conditional --------------------------------------------
    $groups = [System.Collections.Generic.List[string]]::new()
    foreach ($g in @(Get-CtgProp $Config 'groups')) { if ($g) { $groups.Add([string]$g) } }
    foreach ($cg in @(Get-CtgProp $Config 'conditionalGroups')) {
        if (Test-CtgCondition (Get-CtgProp $cg 'when') $User) {
            foreach ($g in @(Get-CtgProp $cg 'groups')) { if ($g) { $groups.Add([string]$g) } }
        }
    }
    foreach ($group in $groups) {
        if ($PSCmdlet.ShouldProcess($sam, "Add to group $group")) {
            Add-ADGroupMember -Identity $group -Members $sam -ErrorAction SilentlyContinue
            $actions.Add("added to group: $group")
        }
    }

    [pscustomobject]@{ System = 'active-directory'; Status = 'ok'; Sam = $sam; Ou = $ouPath; Actions = $actions.ToArray() }
}

function Invoke-CtgADOffboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config
    )
    $actions = [System.Collections.Generic.List[string]]::new()
    $sam = $User.SamAccountName

    $existing = Get-ADUser -Identity $sam -Properties MemberOf, DistinguishedName -ErrorAction SilentlyContinue
    if (-not $existing) {
        return [pscustomobject]@{ System='active-directory'; Status='ok'; Sam=$sam; Actions=@("user not found ($sam)"); Evidence=@{ Groups=@() } }
    }
    $guardrails = @(Get-CtgProp $Config 'guardrails')

    # 1. Reset password --------------------------------------------------------
    if ((Get-CtgProp $Config 'resetPassword')) {
        if ($PSCmdlet.ShouldProcess($sam, "Reset password")) {
            $new = ConvertTo-SecureString ([System.Guid]::NewGuid().ToString() + '!Aa9') -AsPlainText -Force
            Set-ADAccountPassword -Identity $sam -Reset -NewPassword $new
            $actions.Add("reset password")
        }
    }

    # 2. Evidence FIRST, then remove groups (primary group can't be removed) ----
    $memberships = @(Get-ADPrincipalGroupMembership -Identity $sam -ErrorAction SilentlyContinue)
    $groupNames = @($memberships | ForEach-Object { $_.Name })
    $actions.Add("captured $($groupNames.Count) group membership(s) as evidence")
    if ((Get-CtgProp $Config 'removeAllGroups')) {
        foreach ($g in $memberships) {
            if ($g.Name -eq 'Domain Users') { continue }   # primary group — not removable this way
            if ($PSCmdlet.ShouldProcess($sam, "Remove from group $($g.Name)")) {
                Remove-ADGroupMember -Identity $g.Name -Members $sam -Confirm:$false -ErrorAction SilentlyContinue
                $actions.Add("removed from group: $($g.Name)")
            }
        }
    }

    # 3. Hide from GAL ---------------------------------------------------------
    $hide = Get-CtgProp $Config 'hideFromGal'
    if ($hide) {
        $attr = Get-CtgProp $hide 'attribute'; $val = Get-CtgProp $hide 'value'
        if ($attr -and $PSCmdlet.ShouldProcess($sam, "Hide from GAL ($attr=$val)")) {
            Set-ADUser -Identity $sam -Replace @{ $attr = $val }
            $actions.Add("hid from GAL: $attr=$val")
        }
    }

    # 4. Remove manager --------------------------------------------------------
    if ($PSCmdlet.ShouldProcess($sam, "Clear manager")) {
        Set-ADUser -Identity $sam -Clear manager
        $actions.Add("cleared manager")
    }

    # 5. Disable ----------------------------------------------------------------
    if ((Get-CtgProp $Config 'disableAccount') -ne $false) {
        if ($PSCmdlet.ShouldProcess($sam, "Disable account")) {
            Disable-ADAccount -Identity $sam
            $actions.Add("disabled account")
        }
    }

    # 6. Move to Disabled Users OU — UNLESS the guardrail forbids it ------------
    $disabledOu = Get-CtgProp $Config 'disabledUsersOu'
    if ($guardrails -contains 'do-not-move-ou') {
        $actions.Add("did not move OU (do-not-move-ou guardrail — moving would delete the synced 365 account)")
    }
    elseif ($disabledOu -and $PSCmdlet.ShouldProcess($sam, "Move to $disabledOu")) {
        Move-ADObject -Identity $existing.DistinguishedName -TargetPath $disabledOu
        $actions.Add("moved to $disabledOu")
    }

    [pscustomobject]@{
        System='active-directory'; Status='ok'; Sam=$sam
        Evidence=@{ Groups = $groupNames }
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
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )

    $checks = [System.Collections.Generic.List[object]]::new()
    $add = { param($name, $expected, $actual) $checks.Add(@{ name = $name; expected = $expected; actual = $actual; pass = ($expected -eq $actual) }) }
    $sam = $User.SamAccountName
    $domain = Get-CtgProp $User 'PrimaryDomain'

    $u = Get-ADUser -Identity $sam -Properties MemberOf, DistinguishedName, Enabled, HomeDirectory, msExchHideFromAddressLists -ErrorAction SilentlyContinue
    $exists = [bool]$u
    $groupNames = if ($exists) { @(Get-ADPrincipalGroupMembership -Identity $sam -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }) } else { @() }

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
            $remaining = @($groupNames | Where-Object { $_ -ne 'Domain Users' }).Count
            & $add 'groups removed' $true ([bool]($remaining -eq 0))
        }
        $hide = Get-CtgProp $Config 'hideFromGal'
        if ($exists -and $hide -and (Get-CtgProp $hide 'attribute')) {
            & $add 'hidden from GAL' $true ([bool]((Get-CtgProp $u 'msExchHideFromAddressLists')))
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

Export-ModuleMember -Function Invoke-CtgADOnboarding, Invoke-CtgADOffboarding, Test-CtgCondition, Resolve-CtgOuPath, Confirm-CtgAD
