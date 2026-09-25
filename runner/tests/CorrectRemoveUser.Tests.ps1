# FR #0000088: correct (names / username / email) or hard-remove a user THIS engine created.
#
# WHICH account: config.target is what that system's onboard (or its latest succeeded correction)
# reported — with an immutable id when the result had one. The payload's username alone is never
# enough: the onboard may have used a fallback username because the primary belonged to someone else.
BeforeAll {
    # Thin stubs for cmdlets that aren't on a test host, so Pester can Mock them in module scope.
    function global:Get-ADUser { [CmdletBinding()] param($Identity, $Filter, $Properties, $Server, $Credential) }
    function global:Set-ADUser { [CmdletBinding()] param($Identity, $GivenName, $Surname, $DisplayName, $UserPrincipalName, $SamAccountName, $Replace, $Server, $Credential) }
    function global:Rename-ADObject { [CmdletBinding()] param($Identity, $NewName, $Server, $Credential) }
    function global:Remove-ADObject { [CmdletBinding()] param($Identity, [switch]$Recursive, [switch]$Confirm, $Server, $Credential) }
    function global:Get-MgUser { param($UserId, $Property) }
    function global:Remove-MgUser { param($UserId) }
    function global:Remove-MgDirectoryDeletedItem { param($DirectoryObjectId) }
    function global:Update-MgUser { param($UserId, $BodyParameter) }
    function global:Get-Mailbox { param($Identity) }
    function global:Set-Mailbox { param($Identity, $WindowsEmailAddress) }
    foreach ($m in 'ActiveDirectory', 'M365', 'Exchange', 'GoogleWorkspace') {
        Import-Module "$PSScriptRoot/../modules/Coretelligent.$m/Coretelligent.$m.psm1" -Force -DisableNameChecking
    }
    # The case says jsmyth; the case was created 2026-09-01 12:00Z.
    $script:Case = [pscustomobject]@{ SamAccountName = 'jsmyth'; UserPrincipalName = 'jsmyth@acme.com'; DisplayName = 'John Smyth' }
    $script:CaseAt = '2026-09-01T12:00:00.000Z'
    $script:After = [datetime]::new(2026, 9, 2, 9, 0, 0, [DateTimeKind]::Utc)
    $script:Before = [datetime]::new(2024, 3, 1, 0, 0, 0, [DateTimeKind]::Utc)
    function script:Cfg([hashtable]$h = @{}) { $b = @{ caseCreatedAt = $script:CaseAt }; foreach ($k in $h.Keys) { $b[$k] = $h[$k] }; [pscustomobject]$b }
}
AfterAll { foreach ($m in 'ActiveDirectory', 'M365', 'Exchange', 'GoogleWorkspace') { Remove-Module "Coretelligent.$m" -Force -ErrorAction SilentlyContinue } }

Describe 'Invoke-CtgADRemoveUser' {
    It 'deletes the account found by the objectGUID the onboard recorded, keeping its groups as evidence' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { $null }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'guid-jane' } { [pscustomobject]@{ SamAccountName = 'jmsmith'; DistinguishedName = 'CN=Jane Smith,OU=Staff,DC=acme,DC=com'; MemberOf = @('CN=Finance,DC=acme,DC=com'); ObjectGUID = 'guid-jane'; whenCreated = $script:Before } }
        Mock Remove-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ sam = 'jmsmith'; objectGuid = 'guid-jane'; adopted = $false } })
        $r.Deleted | Should -BeTrue
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $Identity -eq 'CN=Jane Smith,OU=Staff,DC=acme,DC=com' -and $Recursive }
        Should -Invoke Get-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly -ParameterFilter { $Identity -eq 'jsmyth' }
        $r.Evidence.Groups | Should -Contain 'CN=Finance,DC=acme,DC=com'
    }
    It 'H1: deletes the FALLBACK account the onboard created (jmsmith), never the payload name''s owner (jsmyth)' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'jsmyth' } { [pscustomobject]@{ SamAccountName = 'jsmyth'; DistinguishedName = 'CN=John Smyth,DC=acme,DC=com'; MemberOf = @(); whenCreated = $script:Before } }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'jmsmith' } { [pscustomobject]@{ SamAccountName = 'jmsmith'; DistinguishedName = 'CN=Jane Smyth,DC=acme,DC=com'; MemberOf = @(); whenCreated = $script:After } }
        Mock Remove-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $null = Invoke-CtgADRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ sam = 'jmsmith' } })
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter { $Identity -eq 'CN=Jane Smyth,DC=acme,DC=com' }
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly -ParameterFilter { $Identity -eq 'CN=John Smyth,DC=acme,DC=com' }
    }
    It 'H1: with no id, even the case''s own username is deleted only if the account post-dates the case' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmyth'; DistinguishedName = 'CN=John Smyth,DC=acme,DC=com'; MemberOf = @(); whenCreated = $script:Before } }
        Mock Remove-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADRemoveUser -User $script:Case -Config (Cfg)
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match '^WARN AD user jsmyth \(CN=John Smyth,DC=acme,DC=com\) was created .* Nothing deleted'
    }
    It 'with an id on record, a missing account is a WARN — no fallback to names' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmyth'; DistinguishedName = 'CN=John Smyth,DC=acme,DC=com'; MemberOf = @(); whenCreated = $script:After } }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'guid-gone' } { $null }
        Mock Remove-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ objectGuid = 'guid-gone' } })
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match '^WARN AD user not found \(objectGUID guid-gone\)'
    }
    It 'refuses to find the user by display name alone' {
        { Invoke-CtgADRemoveUser -User ([pscustomobject]@{ DisplayName = 'John Smyth' }) -Config (Cfg) } | Should -Throw '*refusing to look the user up by display name*'
    }
}

Describe 'Invoke-CtgADCorrectUser' {
    BeforeAll {
        $script:AdSmyth = { [pscustomobject]@{ SamAccountName = 'jsmyth'; DistinguishedName = 'CN=John Smyth,OU=Staff,DC=acme,DC=com'; GivenName = 'John'; Surname = 'Smyth'; DisplayName = 'John Smyth'; Name = 'John Smyth'
                UserPrincipalName = 'jsmyth@acme.com'; mail = 'jsmyth@acme.com'; proxyAddresses = @('SMTP:jsmyth@acme.com', 'smtp:jsmyth@acme.onmicrosoft.com'); ObjectGUID = 'g1'; whenCreated = $script:After } }
    }
    It 'fixes the names, renames the object, moves the UPN keeping the old address as an alias, and reports the new identity + id' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory $script:AdSmyth
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory { }
        Mock Rename-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADCorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ objectGuid = 'g1' }; lastName = 'Smith'; displayName = 'John Smith'; newUpn = 'jsmith@acme.com' })
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Surname -eq 'Smith' -and $DisplayName -eq 'John Smith' } -Times 1 -Exactly
        Should -Invoke Rename-ADObject -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $NewName -eq 'John Smith' } -Times 1 -Exactly
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter {
            $UserPrincipalName -eq 'jsmith@acme.com' -and $SamAccountName -eq 'jsmith' -and $Replace.mail -eq 'jsmith@acme.com' -and
            $Replace.proxyAddresses[0] -ceq 'SMTP:jsmith@acme.com' -and ($Replace.proxyAddresses -ccontains 'smtp:jsmyth@acme.com')
        }
        ($r.Actions -join ' ') | Should -Match 'old address stays as an alias'
        $r.Sam | Should -Be 'jsmith'; $r.Upn | Should -Be 'jsmith@acme.com'; $r.ObjectGuid | Should -Be 'g1'
    }
    It 'says so when there is nothing to change' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmyth'; DistinguishedName = 'CN=John Smyth,DC=acme,DC=com'; GivenName = 'John'; Surname = 'Smyth'; DisplayName = 'John Smyth'; Name = 'John Smyth'; UserPrincipalName = 'jsmyth@acme.com'; mail = $null; proxyAddresses = @(); ObjectGUID = 'g1'; whenCreated = $script:After } }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADCorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ objectGuid = 'g1' }; firstName = 'John' })
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already correct'
    }
    It 'M2: a re-run finds the renamed account by its objectGUID and it is already correct' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmith'; DistinguishedName = 'CN=John Smith,DC=acme,DC=com'; GivenName = 'John'; Surname = 'Smith'; DisplayName = 'John Smith'; Name = 'John Smith'
                UserPrincipalName = 'jsmith@acme.com'; mail = 'jsmith@acme.com'; proxyAddresses = @('SMTP:jsmith@acme.com'); ObjectGUID = 'g1'; whenCreated = $script:After } }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory { }
        Mock Rename-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADCorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ objectGuid = 'g1' }; lastName = 'Smith'; displayName = 'John Smith'; newUpn = 'jsmith@acme.com'; newSam = 'jsmith' })
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already correct'
    }
    It 'M2: without an id, a match found only under the NEW name is refused (it may be someone else)' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { $null }
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory -ParameterFilter { $Identity -eq 'jsmith' } { [pscustomobject]@{ SamAccountName = 'jsmith'; DistinguishedName = 'CN=Jim Smith,DC=acme,DC=com'; GivenName = 'Jim'; Surname = 'Smith'; DisplayName = 'Jim Smith'; Name = 'Jim Smith'; UserPrincipalName = 'jsmith@acme.com'; mail = $null; proxyAddresses = @(); whenCreated = $script:After } }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory { }
        { Invoke-CtgADCorrectUser -User $script:Case -Config (Cfg @{ lastName = 'Smith'; newUpn = 'jsmith@acme.com'; newSam = 'jsmith' }) } | Should -Throw '*refused: AD user jsmith (CN=Jim Smith*found only under the CORRECTED name*'
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
    }
    It 'M2: without an id, an account older than the case is refused, not renamed' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmyth'; DistinguishedName = 'CN=John Smyth,DC=acme,DC=com'; GivenName = 'John'; Surname = 'Smyth'; DisplayName = 'John Smyth'; Name = 'John Smyth'; UserPrincipalName = 'jsmyth@acme.com'; mail = $null; proxyAddresses = @(); whenCreated = $script:Before } }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory { }
        { Invoke-CtgADCorrectUser -User $script:Case -Config (Cfg @{ lastName = 'Smith' }) } | Should -Throw '*refused: AD user jsmyth*was created*'
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
    }
    It 'ad-standalone: the AD-suffix UPN never becomes the mail address — mail/proxy take the cloud email' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'johnsmyth'; DistinguishedName = 'CN=John Smyth,DC=syee,DC=local'; GivenName = 'John'; Surname = 'Smyth'; DisplayName = 'John Smyth'; Name = 'John Smyth'
                UserPrincipalName = 'johnsmyth@syee.local'; mail = 'johnsmyth@olympus.com'; proxyAddresses = @('SMTP:johnsmyth@olympus.com'); ObjectGUID = 'g2'; whenCreated = $script:After } }
        Mock Set-ADUser -ModuleName Coretelligent.ActiveDirectory { }
        Mock Rename-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $null = Invoke-CtgADCorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ objectGuid = 'g2' }; newUpn = 'johnsmith@syee.local'; mailAddress = 'johnsmith@olympus.com' })
        Should -Invoke Set-ADUser -ModuleName Coretelligent.ActiveDirectory -Times 1 -Exactly -ParameterFilter {
            $UserPrincipalName -eq 'johnsmith@syee.local' -and $Replace.mail -eq 'johnsmith@olympus.com' -and $Replace.proxyAddresses[0] -ceq 'SMTP:johnsmith@olympus.com' -and
            -not ($Replace.proxyAddresses -match 'syee\.local')
        }
    }
}

Describe 'M365 correct / remove' {
    It 'removes and permanently purges the cloud user found by the Entra id the onboard recorded' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'id-jane' } { [pscustomobject]@{ Id = 'id-jane'; UserPrincipalName = 'jmsmith@acme.com'; OnPremisesSyncEnabled = $null; CreatedDateTime = $script:Before } }
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        Mock Remove-MgDirectoryDeletedItem -ModuleName Coretelligent.M365 { }
        $r = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-jane'; upn = 'jmsmith@acme.com'; adopted = $false } })
        $r.Deleted | Should -BeTrue
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $UserId -eq 'id-jane' }
        Should -Invoke Remove-MgDirectoryDeletedItem -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $DirectoryObjectId -eq 'id-jane' }
        Should -Invoke Get-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $UserId -eq 'jsmyth@acme.com' }
        ($r.Actions -join ' ') | Should -Match 'permanently purged'
    }
    It 'H1: without an id, deletes the fallback UPN the onboard reported, never the payload UPN''s owner' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'jsmyth@acme.com' } { [pscustomobject]@{ Id = 'id-john'; UserPrincipalName = 'jsmyth@acme.com'; OnPremisesSyncEnabled = $null; CreatedDateTime = $script:Before } }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'jmsmith@acme.com' } { [pscustomobject]@{ Id = 'id-jane'; UserPrincipalName = 'jmsmith@acme.com'; OnPremisesSyncEnabled = $null; CreatedDateTime = $script:After } }
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        Mock Remove-MgDirectoryDeletedItem -ModuleName Coretelligent.M365 { }
        $null = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ upn = 'jmsmith@acme.com' } })
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $UserId -eq 'id-jane' }
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly -ParameterFilter { $UserId -eq 'id-john' }
    }
    It 'H1: without an id, the payload UPN''s account older than the case is refused with a WARN naming it' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'id-john'; UserPrincipalName = 'jsmyth@acme.com'; OnPremisesSyncEnabled = $null; CreatedDateTime = $script:Before } }
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        $r = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg)
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match '^WARN Entra user jsmyth@acme\.com \(id id-john\) was created'
    }
    It 'with an id on record, a missing user is a WARN — no fallback to the payload UPN' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'id-john'; UserPrincipalName = 'jsmyth@acme.com'; OnPremisesSyncEnabled = $null; CreatedDateTime = $script:After } }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'id-gone' } { $null }
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        $r = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-gone' } })
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match '^WARN Entra user not found \(object id id-gone\)'
    }
    It 'leaves an AD-synced user to the AD step, for both remove and correct' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jsmyth@acme.com'; OnPremisesSyncEnabled = $true } }
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        Mock Update-MgUser -ModuleName Coretelligent.M365 { }
        $cfg = Cfg @{ target = [pscustomobject]@{ id = 'u1' }; newUpn = 'jsmith@acme.com' }
        $null = Invoke-CtgM365RemoveUser -User $script:Case -Config $cfg
        $null = Invoke-CtgM365CorrectUser -User $script:Case -Config $cfg
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }
    It 'updates only what differs on a cloud user, and reports the new UPN + id' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'jsmyth@acme.com'; GivenName = 'John'; Surname = 'Smyth'; DisplayName = 'John Smyth'; OnPremisesSyncEnabled = $null } }
        Mock Update-MgUser -ModuleName Coretelligent.M365 { }
        $r = Invoke-CtgM365CorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'u1' }; firstName = 'John'; lastName = 'Smith'; newUpn = 'jsmith@acme.com' })
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly -ParameterFilter { $BodyParameter.surname -eq 'Smith' -and $BodyParameter.userPrincipalName -eq 'jsmith@acme.com' -and -not $BodyParameter.ContainsKey('givenName') }
        $r.UserId | Should -Be 'u1'; $r.Upn | Should -Be 'jsmith@acme.com'
    }
    It 'M2: a re-run finds the renamed user by its id and it is already correct (UPN compared case-insensitively)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'u1'; UserPrincipalName = 'JSmith@acme.com'; GivenName = 'John'; Surname = 'Smith'; DisplayName = 'John Smyth'; OnPremisesSyncEnabled = $null } }
        Mock Update-MgUser -ModuleName Coretelligent.M365 { }
        $r = Invoke-CtgM365CorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'u1' }; lastName = 'Smith'; newUpn = 'jsmith@acme.com' })
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already correct'
    }
    It 'M2: without an id, a user found only under the NEW UPN is refused' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { $null }
        Mock Get-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $UserId -eq 'jsmith@acme.com' } { [pscustomobject]@{ Id = 'id-jim'; UserPrincipalName = 'jsmith@acme.com'; OnPremisesSyncEnabled = $null; CreatedDateTime = $script:After } }
        Mock Update-MgUser -ModuleName Coretelligent.M365 { }
        { Invoke-CtgM365CorrectUser -User $script:Case -Config (Cfg @{ newUpn = 'jsmith@acme.com' }) } | Should -Throw '*refused: Entra user jsmith@acme.com (id id-jim) was found only under the CORRECTED UPN*'
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
    }
}

Describe 'Invoke-CtgExchangeCorrectAddress' {
    It 'moves the primary address on a cloud mailbox' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange { [pscustomobject]@{ Identity = 'jsmyth'; PrimarySmtpAddress = 'jsmyth@acme.com'; IsDirSynced = $false; ExternalDirectoryObjectId = 'u1' } }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange { }
        $null = Invoke-CtgExchangeCorrectAddress -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'u1'; upn = 'jsmyth@acme.com' }; newUpn = 'jsmith@acme.com' })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 1 -Exactly -ParameterFilter { $WindowsEmailAddress -eq 'jsmith@acme.com' }
    }
    It 'leaves a synced mailbox to AD' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange { [pscustomobject]@{ Identity = 'jsmyth'; PrimarySmtpAddress = 'jsmyth@acme.com'; IsDirSynced = $true } }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange { }
        $null = Invoke-CtgExchangeCorrectAddress -User $script:Case -Config (Cfg @{ newUpn = 'jsmith@acme.com' })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly
    }
    It 'H1: refuses a mailbox that belongs to a different Entra object than the onboard created' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange { [pscustomobject]@{ Identity = 'jsmyth'; PrimarySmtpAddress = 'jsmyth@acme.com'; IsDirSynced = $false; ExternalDirectoryObjectId = 'id-john' } }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange { }
        { Invoke-CtgExchangeCorrectAddress -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-jane' }; newUpn = 'jsmith@acme.com' }) } | Should -Throw '*refused: mailbox jsmyth@acme.com belongs to Entra object id-john*'
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly
    }
    It 'M2: without an Entra id, a mailbox found only under the corrected address is refused' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange { $null }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'jsmith@acme.com' } { [pscustomobject]@{ Identity = 'jsmith'; PrimarySmtpAddress = 'jsmith@acme.com'; IsDirSynced = $false } }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange { }
        { Invoke-CtgExchangeCorrectAddress -User $script:Case -Config (Cfg @{ newUpn = 'jsmith@acme.com' }) } | Should -Throw '*refused: mailbox jsmith@acme.com was found only under the corrected address*'
    }
    It 'a mailbox-optional job (queued off the M365 line) warns when the user has no mailbox' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange { $null }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange { }
        $r = Invoke-CtgExchangeCorrectAddress -User $script:Case -Config (Cfg @{ newUpn = 'jsmith@acme.com'; mailboxOptional = $true })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match '^WARN no Exchange Online mailbox'
    }
    It 'a planned exchange line with no mailbox still fails' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange { $null }
        { Invoke-CtgExchangeCorrectAddress -User $script:Case -Config (Cfg @{ newUpn = 'jsmith@acme.com' }) } | Should -Throw '*mailbox not found*'
    }
}

Describe 'Google correct / remove' {
    It 'deletes the user found by the Google id the onboard recorded, and says Google keeps it 20 days' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace { $null }
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Email -eq 'gid-jane' } { [pscustomobject]@{ id = 'gid-jane'; primaryEmail = 'jmsmith@acme.com'; creationTime = '2024-03-01T00:00:00.000Z' } }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace { }
        $r = Invoke-CtgGoogleRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'gid-jane'; email = 'jmsmith@acme.com'; adopted = $false } })
        $r.Deleted | Should -BeTrue
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/gid-jane' }
        ($r.Actions -join ' ') | Should -Match 'deleted Google user jmsmith@acme\.com.*20 days'
    }
    It 'H1: without an id, the payload address''s account older than the case is refused with a WARN' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace { [pscustomobject]@{ primaryEmail = 'jsmyth@acme.com'; creationTime = '2024-03-01T00:00:00.000Z' } }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace { }
        $r = Invoke-CtgGoogleRemoveUser -User $script:Case -Config (Cfg)
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match '^WARN Google user jsmyth@acme\.com was created'
    }
    It 'renames the primary email and fixes the surname in one update, reporting the new address + id' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace { [pscustomobject]@{ id = 'gid-1'; primaryEmail = 'jsmyth@acme.com'; name = [pscustomobject]@{ givenName = 'John'; familyName = 'Smyth' } } }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace { }
        $r = Invoke-CtgGoogleCorrectUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'gid-1' }; firstName = 'John'; lastName = 'Smith'; newUpn = 'jsmith@acme.com' })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'PUT' -and $Path -eq '/users/jsmyth@acme.com' -and $Body.primaryEmail -eq 'jsmith@acme.com' -and $Body.name.familyName -eq 'Smith' -and -not $Body.name.ContainsKey('givenName') }
        $r.Email | Should -Be 'jsmith@acme.com'; $r.Id | Should -Be 'gid-1'
    }
    It 'M2: without an id, a user found only under the NEW address is refused' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace { $null }
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Email -eq 'jsmith@acme.com' } { [pscustomobject]@{ primaryEmail = 'jsmith@acme.com'; creationTime = '2026-09-02T00:00:00.000Z'; name = [pscustomobject]@{ givenName = 'Jim'; familyName = 'Smith' } } }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace { }
        { Invoke-CtgGoogleCorrectUser -User $script:Case -Config (Cfg @{ newUpn = 'jsmith@acme.com' }) } | Should -Throw '*refused: Google user jsmith@acme.com was found only under the CORRECTED address*'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly
    }
}

# Start-IamRunner.ps1 isn't dot-sourceable: lift the exchange-correct-user handler literal out of it
# via the AST and exercise it against a stub exchange lane.
Describe 'the exchange-correct-user runner lane' {
    BeforeAll {
        $path = Join-Path (Split-Path $PSScriptRoot -Parent) 'Start-IamRunner.ps1'
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$null)
        $assign = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq "`$DISPATCH['exchange-correct-user']" }, $true) | Select-Object -First 1
        $assign | Should -Not -BeNullOrEmpty
        $getProp = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-CtgProp' }, $true) | Select-Object -First 1
        . ([scriptblock]::Create($getProp.Extent.Text.Replace('function Get-CtgProp', 'function global:Get-CtgProp')))
        $global:CtgTestSeenCreds = $null
        $global:CtgTestConnectThrows = $false
        $global:DISPATCH = @{ exchange = @{ Connect = { param($job, $creds) $global:CtgTestSeenCreds = $creds; if ($global:CtgTestConnectThrows) { throw 'the m365-admin secret has no Exchange Online cert' } } } }
        $script:Handler = & ([scriptblock]::Create($assign.Right.Extent.Text))
    }
    AfterAll { Remove-Variable -Name DISPATCH, CtgTestSeenCreds, CtgTestConnectThrows -Scope Global -ErrorAction SilentlyContinue }
    It 'connects to Exchange Online only — never the on-prem Exchange session (hybrid)' {
        $global:CtgTestSeenCreds = $null; $global:CtgTestConnectThrows = $false
        $creds = @{ 'm365-admin' = 'exo'; 'exchange-onprem' = 'onprem' }
        & $script:Handler.Connect ([pscustomobject]@{ id = 'j'; config = [pscustomobject]@{} }) $creds
        $global:CtgTestSeenCreds | Should -Not -BeNullOrEmpty
        $global:CtgTestSeenCreds.ContainsKey('m365-admin') | Should -BeTrue
        $global:CtgTestSeenCreds.ContainsKey('exchange-onprem') | Should -BeFalse
        $creds.ContainsKey('exchange-onprem') | Should -BeTrue -Because 'the job''s own brokered creds are not mutated'
    }
    It 'closes its Exchange Online session when the job ends' {
        $script:Handler.ContainsKey('Disconnect') | Should -BeTrue
        $script:Handler.Disconnect.ToString() | Should -Match 'Disconnect-CtgExchange'
    }
    It 'M1: a mailbox-optional job whose EXO connect fails is a WARN manual follow-up, not a failure' {
        $global:CtgTestSeenCreds = $null; $global:CtgTestConnectThrows = $true
        $job = [pscustomobject]@{ id = 'j'; payload = $script:Case; config = [pscustomobject]@{ mailboxOptional = $true; newUpn = 'jsmith@acme.com' } }
        { & $script:Handler.Connect $job @{ 'm365-admin' = 'exo' } } | Should -Not -Throw
        $global:CtgTestSeenCreds | Should -BeNullOrEmpty -Because 'the optional job connects best-effort inside Onboard, not in Connect'
        $r = & $script:Handler.Onboard $job @{ 'm365-admin' = 'exo' }
        ($r.Actions -join ' ') | Should -Match '^WARN manual follow-up: .*NOT changed to jsmith@acme\.com'
    }
}

# Round 3 (N1/N2): an account that existed before this case (a rehire, an operator Adopt) is never
# deleted by Remove — it needs an offboard — and every remove says whether it deleted anything.
Describe 'Remove never deletes a pre-existing account' {
    It 'AD: refuses an adopted account by its objectGUID, deleting nothing (Deleted = false)' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmith'; DistinguishedName = 'CN=Jane Smith,DC=acme,DC=com'; ObjectGUID = 'guid-old'; whenCreated = $script:Before } }
        Mock Remove-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ sam = 'jsmith'; objectGuid = 'guid-old'; adopted = $true } })
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        $r.Deleted | Should -BeFalse
        ($r.Actions -join ' ') | Should -Match 'existed before this case.*offboard'
    }
    It 'AD: an id with no Adopted flag (older onboard) is refused when the account is older than the case' {
        Mock Get-ADUser -ModuleName Coretelligent.ActiveDirectory { [pscustomobject]@{ SamAccountName = 'jsmith'; DistinguishedName = 'CN=Jane Smith,DC=acme,DC=com'; ObjectGUID = 'guid-old'; whenCreated = $script:Before } }
        Mock Remove-ADObject -ModuleName Coretelligent.ActiveDirectory { }
        $r = Invoke-CtgADRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ sam = 'jsmith'; objectGuid = 'guid-old' } })
        Should -Invoke Remove-ADObject -ModuleName Coretelligent.ActiveDirectory -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'may be a pre-existing account'
    }
    It 'M365: refuses an adopted Entra user, never calling Remove-MgUser or the purge' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'id-old'; UserPrincipalName = 'jsmith@acme.com'; CreatedDateTime = $script:Before } }
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        Mock Remove-MgDirectoryDeletedItem -ModuleName Coretelligent.M365 { }
        $r = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-old'; upn = 'jsmith@acme.com'; adopted = $true } })
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 0 -Exactly
        Should -Invoke Remove-MgDirectoryDeletedItem -ModuleName Coretelligent.M365 -Times 0 -Exactly
        $r.Deleted | Should -BeFalse
    }
    It 'M365: an id with no Adopted flag is refused when the user is older than the case, deleted when newer' {
        Mock Remove-MgUser -ModuleName Coretelligent.M365 { }
        Mock Remove-MgDirectoryDeletedItem -ModuleName Coretelligent.M365 { }
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'id-x'; UserPrincipalName = 'jsmith@acme.com'; CreatedDateTime = $script:Before } }
        $old = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-x' } })
        $old.Deleted | Should -BeFalse
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'id-x'; UserPrincipalName = 'jsmith@acme.com'; CreatedDateTime = $script:After } }
        $new = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-x' } })
        $new.Deleted | Should -BeTrue
        Should -Invoke Remove-MgUser -ModuleName Coretelligent.M365 -Times 1 -Exactly
    }
    It 'M365: a synced user left to AD reports Deleted = false (the AD step reports its own delete)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 { [pscustomobject]@{ Id = 'id-s'; UserPrincipalName = 'jmsmith@acme.com'; OnPremisesSyncEnabled = $true; CreatedDateTime = $script:After } }
        $r = Invoke-CtgM365RemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'id-s'; adopted = $false } })
        $r.Deleted | Should -BeFalse
    }
    It 'Google: refuses an adopted user, never sending the DELETE' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace { [pscustomobject]@{ id = 'gid-old'; primaryEmail = 'jsmith@acme.com'; creationTime = '2019-03-01T00:00:00.000Z' } }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace { }
        $r = Invoke-CtgGoogleRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'gid-old'; email = 'jsmith@acme.com'; adopted = $true } })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly
        $r.Deleted | Should -BeFalse
        ($r.Actions -join ' ') | Should -Match 'existed before this case'
    }
    It 'a not-found remove reports Deleted = false' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace { $null }
        $r = Invoke-CtgGoogleRemoveUser -User $script:Case -Config (Cfg @{ target = [pscustomobject]@{ id = 'gid-gone'; adopted = $false } })
        $r.Deleted | Should -BeFalse
    }
}
