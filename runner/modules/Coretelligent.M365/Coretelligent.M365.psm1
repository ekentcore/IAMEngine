#Requires -Version 7.0

# Coretelligent.M365
# Shared system module — written once, reused by every client.
# Depends on the Microsoft.Graph SDK. Required delegated/app scopes:
#   User.ReadWrite.All, Group.ReadWrite.All, Organization.Read.All
#
# Public surface:
#   Connect-CtgM365            - establish a Graph session from a credential
#   New-CtgCompliantPassword   - generate a policy-compliant initial password
#   Invoke-CtgM365Onboarding   - idempotent: user + licenses + groups + alias
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

#endregion

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
    $assigned = @((Get-MgUserLicenseDetail -UserId $userId -ErrorAction SilentlyContinue).SkuId)
    foreach ($lic in $Config.defaultLicenses) {
        if ($assigned -contains $lic.skuId) {
            $actions.Add("license present: $($lic.name)")
            continue
        }
        if ($PSCmdlet.ShouldProcess($upn, "Assign license $($lic.name)")) {
            Set-MgUserLicense -UserId $userId `
                -AddLicenses @(@{ SkuId = $lic.skuId }) -RemoveLicenses @() | Out-Null
            $actions.Add("assigned license: $($lic.name)")
        }
    }

    # 3. Groups — check membership before adding -------------------------------
    foreach ($groupName in $Config.defaultGroups) {
        $group = Get-MgGroup -Filter "mail eq '$groupName' or displayName eq '$groupName'" -Top 1 -ErrorAction SilentlyContinue
        if (-not $group) { $actions.Add("WARN group not found: $groupName"); continue }

        $isMember = Get-MgGroupMember -GroupId $group.Id -All |
                    Where-Object Id -eq $userId
        if ($isMember) { $actions.Add("already in group: $groupName"); continue }

        if ($PSCmdlet.ShouldProcess($upn, "Add to group $groupName")) {
            New-MgGroupMember -GroupId $group.Id -DirectoryObjectId $userId
            $actions.Add("added to group: $groupName")
        }
    }

    # 4. Alias — only if requested ---------------------------------------------
    if ($Config.alias -and $Config.alias.enabled) {
        $alias = "smtp:$($Config.alias.address)"
        $current = @((Get-MgUser -UserId $userId -Property ProxyAddresses).ProxyAddresses)
        if ($current -contains $alias) {
            $actions.Add("alias present: $($Config.alias.address)")
        }
        elseif ($PSCmdlet.ShouldProcess($upn, "Add alias $($Config.alias.address)")) {
            Update-MgUser -UserId $userId -ProxyAddresses ($current + $alias)
            $actions.Add("added alias: $($Config.alias.address)")
        }
    }

    [pscustomobject]@{
        System  = 'm365'
        Status  = 'ok'
        UserId  = $userId
        Upn     = $upn
        Actions = $actions.ToArray()
    }
}

Export-ModuleMember -Function Connect-CtgM365, New-CtgCompliantPassword, Invoke-CtgM365Onboarding
