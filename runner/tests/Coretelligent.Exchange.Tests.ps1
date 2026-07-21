#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Exchange. The Exchange Online (EXO V3) cmdlets aren't installed
# here, so we stub + mock them. Focus: convert-to-shared honoring the >50 GB skip, CAS disable,
# and the on-request OOO message.

BeforeAll {
    function global:Connect-ExchangeOnline { [CmdletBinding()] param($AppId, $Organization, $CertificateThumbprint, $CertificateFilePath, $CertificatePassword, [switch]$ShowBanner) }
    function global:Get-MailboxStatistics { [CmdletBinding()] param($Identity) }
    function global:Set-Mailbox { [CmdletBinding()] param($Identity, $Type, $ForwardingSmtpAddress, [switch]$DeliverToMailboxAndForward, $GrantSendOnBehalfTo, [switch]$Confirm) }
    # shared-mailbox permission mirror (EXO)
    function global:Get-MailboxPermission { [CmdletBinding()] param($Identity) }
    function global:Add-MailboxPermission { [CmdletBinding()] param($Identity, $User, $AccessRights, $InheritanceType, [switch]$AutoMapping, [switch]$Confirm) }
    function global:Get-RecipientPermission { [CmdletBinding()] param($Identity) }
    function global:Add-RecipientPermission { [CmdletBinding()] param($Identity, $Trustee, $AccessRights, [switch]$Confirm) }
    function global:Set-CASMailbox { [CmdletBinding()] param($Identity, $ActiveSyncEnabled, $OWAEnabled) }
    function global:Set-MailboxAutoReplyConfiguration { [CmdletBinding()] param($Identity, $AutoReplyState, $InternalMessage, $ExternalMessage) }
    # on-prem hybrid remote-mailbox + post-sync EXO finishing
    function global:Get-RemoteMailbox { [CmdletBinding()] param($Identity) }
    function global:Enable-RemoteMailbox { [CmdletBinding()] param($Identity, $RemoteRoutingAddress, $Alias, $DisplayName, $PrimarySmtpAddress) }
    function global:Set-RemoteMailbox { [CmdletBinding()] param($Identity, $EmailAddressPolicyEnabled, $Type) }
    function global:Set-MailboxRegionalConfiguration { [CmdletBinding()] param($Identity, $Language, $TimeZone) }
    function global:Add-MailboxFolderPermission { [CmdletBinding()] param($Identity, $User, $AccessRights, [switch]$Confirm) }
    function global:Get-Mailbox { [CmdletBinding()] param($Identity, $RecipientTypeDetails, $ResultSize) }
    # distribution-list mirror (EXO)
    function global:Get-Recipient { [CmdletBinding()] param($Identity, $Filter, $ResultSize) }
    function global:Get-User { [CmdletBinding()] param($Identity) }
    function global:Get-MgUserManager { [CmdletBinding()] param($UserId) } # Entra manager link (Graph)
    function global:Add-DistributionGroupMember { [CmdletBinding()] param($Identity, $Member, [switch]$BypassSecurityGroupManagerCheck) }
    function global:Get-DistributionGroup { [CmdletBinding()] param($Identity, $ResultSize, $Filter) }
    function global:Get-DistributionGroupMember { [CmdletBinding()] param($Identity, $ResultSize) }
    function global:Remove-DistributionGroupMember { [CmdletBinding()] param($Identity, $Member, [switch]$BypassSecurityGroupManagerCheck, [switch]$Confirm) }
    function global:Add-UnifiedGroupLinks { [CmdletBinding()] param($Identity, $LinkType, $Links) }

    Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Force
}

Describe 'Invoke-CtgExchangeSharedMailboxMirror' {
    It 'grants the new user the FullAccess / SendAs / SendOnBehalf the mirror user has' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'mirror@x.com' } -MockWith { [pscustomobject]@{ DisplayName='Mirror User'; PrimarySmtpAddress='mirror@x.com'; UserPrincipalName='mirror@x.com'; Name='Mirror User'; DistinguishedName='CN=Mirror,DC=x' } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'new@x.com' } -MockWith { [pscustomobject]@{ DisplayName='New User'; PrimarySmtpAddress='new@x.com'; UserPrincipalName='new@x.com'; Name='New User'; DistinguishedName='CN=New,DC=x' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $RecipientTypeDetails -eq 'SharedMailbox' } -MockWith {
            @(
                [pscustomobject]@{ DisplayName='Sales'; Identity='sales@x.com'; GrantSendOnBehalfTo=@('mirror@x.com') }
                [pscustomobject]@{ DisplayName='IT';    Identity='it@x.com';    GrantSendOnBehalfTo=@() }
            )
        }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { param($Identity) if ($Identity -eq 'sales@x.com') { @([pscustomobject]@{ User='mirror@x.com'; AccessRights=@('FullAccess'); IsInherited=$false }) } else { @() } }
        Mock Get-RecipientPermission -ModuleName Coretelligent.Exchange -MockWith { param($Identity) if ($Identity -eq 'sales@x.com') { @([pscustomobject]@{ Trustee='mirror@x.com'; AccessRights=@('SendAs') }) } else { @() } }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Add-RecipientPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange -MockWith { }

        $acts = Invoke-CtgExchangeSharedMailboxMirror -MirrorUser 'mirror@x.com' -NewUser 'new@x.com'

        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'sales@x.com' -and $User -eq 'new@x.com' -and ($AccessRights -contains 'FullAccess') } -Times 1
        Should -Invoke Add-RecipientPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'sales@x.com' -and $Trustee -eq 'new@x.com' } -Times 1
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'sales@x.com' -and $GrantSendOnBehalfTo['Add'] -eq 'new@x.com' } -Times 1
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'it@x.com' } -Times 0 -Exactly  # mirror had nothing on IT
        ($acts -join ' ') | Should -Match 'granted FullAccess on shared mailbox sales@x.com \(Sales\) — mirrored from mirror@x.com'
    }

    It 'is idempotent — skips a permission the target already holds' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'mirror@x.com' } -MockWith { [pscustomobject]@{ DisplayName='Mirror'; PrimarySmtpAddress='mirror@x.com'; UserPrincipalName='mirror@x.com' } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'new@x.com' } -MockWith { [pscustomobject]@{ DisplayName='New'; PrimarySmtpAddress='new@x.com'; UserPrincipalName='new@x.com' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $RecipientTypeDetails -eq 'SharedMailbox' } -MockWith { @([pscustomobject]@{ DisplayName='Sales'; Identity='sales@x.com'; GrantSendOnBehalfTo=@() }) }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @(
            [pscustomobject]@{ User='mirror@x.com'; AccessRights=@('FullAccess'); IsInherited=$false }
            [pscustomobject]@{ User='new@x.com';    AccessRights=@('FullAccess'); IsInherited=$false }
        ) }
        Mock Get-RecipientPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }

        $acts = Invoke-CtgExchangeSharedMailboxMirror -MirrorUser 'mirror@x.com' -NewUser 'new@x.com'
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($acts -join ' ') | Should -Match 'already FullAccess: Sales'
    }
}

Describe 'Invoke-CtgExchangeDefaultMailboxAccess' {
    BeforeEach {
        # Target user (the new hire) — one Get-Recipient lookup by NewUser.
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'new@x.com' } -MockWith { [pscustomobject]@{ DisplayName='New User'; PrimarySmtpAddress='new@x.com'; UserPrincipalName='new@x.com' } }
        # Named-mailbox lookups by -Identity (address).
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'finance@x.com' } -MockWith { [pscustomobject]@{ DisplayName='Finance'; PrimarySmtpAddress='finance@x.com'; ExchangeGuid='11111111-1111-1111-1111-111111111111'; Identity='finance@x.com'; GrantSendOnBehalfTo=@() } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'vacation@x.com' } -MockWith { [pscustomobject]@{ DisplayName='Global Vacation Calendar'; PrimarySmtpAddress='vacation@x.com'; ExchangeGuid='22222222-2222-2222-2222-222222222222'; Identity='vacation@x.com'; GrantSendOnBehalfTo=@() } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'missing@x.com' } -MockWith { $null }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Get-RecipientPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Add-RecipientPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange -MockWith { }
    }

    It 'grants FullAccess by default and routes SendAs / SendOnBehalf by the access field' {
        $acts = Invoke-CtgExchangeDefaultMailboxAccess -NewUser 'new@x.com' -Mailboxes @(
            @{ address='finance@x.com'; access='FullAccess' }
            @{ address='vacation@x.com'; access='SendAs' }
            'plainstring@x.com'  # a bare string defaults to FullAccess
        )
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq '11111111-1111-1111-1111-111111111111' -and $User -eq 'new@x.com' -and ($AccessRights -contains 'FullAccess') } -Times 1
        Should -Invoke Add-RecipientPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq '22222222-2222-2222-2222-222222222222' -and $Trustee -eq 'new@x.com' } -Times 1
        ($acts -join ' ') | Should -Match 'default shared mailbox FullAccess: Finance'
        ($acts -join ' ') | Should -Match 'default shared mailbox SendAs: Global Vacation Calendar'
    }

    It 'grants SendOnBehalf via Set-Mailbox' {
        $acts = Invoke-CtgExchangeDefaultMailboxAccess -NewUser 'new@x.com' -Mailboxes @(@{ address='finance@x.com'; access='SendOnBehalf' })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $GrantSendOnBehalfTo['Add'] -eq 'new@x.com' } -Times 1
        ($acts -join ' ') | Should -Match 'default shared mailbox SendOnBehalf: Finance'
    }

    It 'is idempotent — skips a mailbox the target already has FullAccess on' {
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @([pscustomobject]@{ User='new@x.com'; AccessRights=@('FullAccess'); IsInherited=$false }) }
        $acts = Invoke-CtgExchangeDefaultMailboxAccess -NewUser 'new@x.com' -Mailboxes @(@{ address='finance@x.com'; access='FullAccess' })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($acts -join ' ') | Should -Match 'already FullAccess: Finance'
    }

    It 'warns (does not throw) when a named mailbox is not found' {
        $acts = Invoke-CtgExchangeDefaultMailboxAccess -NewUser 'new@x.com' -Mailboxes @(@{ address='missing@x.com'; access='FullAccess' })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($acts -join ' ') | Should -Match 'WARN default shared mailbox not found in Exchange Online: missing@x.com'
    }

    It 'returns nothing for an empty list' {
        $acts = Invoke-CtgExchangeDefaultMailboxAccess -NewUser 'new@x.com' -Mailboxes @()
        @($acts).Count | Should -Be 0
    }
}

Describe 'Invoke-CtgExchangeDistListMirror' {
    It 'adds the new user to the reference user''s distribution + mail-enabled security groups (static only)' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'Christine Holleran' } -MockWith { [pscustomobject]@{ DisplayName = 'Christine Holleran'; DistinguishedName = 'CN=Christine,DC=x' } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Filter -like '*Members*' } -MockWith {
            @(
                [pscustomobject]@{ DisplayName = 'Billing Team'; Identity = 'Billing Team'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; IsDirSynced = $false }
                [pscustomobject]@{ DisplayName = 'Sec Mail';     Identity = 'Sec Mail';     RecipientTypeDetails = 'MailUniversalSecurityGroup'; IsDirSynced = $false }
                [pscustomobject]@{ DisplayName = 'Dynamic DL';   Identity = 'Dynamic DL';   RecipientTypeDetails = 'DynamicDistributionGroup'; IsDirSynced = $false }
                [pscustomobject]@{ DisplayName = 'Core-ALL';     Identity = 'Core-ALL';     RecipientTypeDetails = 'MailUniversalDistributionGroup'; IsDirSynced = $true }
            )
        }
        Mock Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        $acts = Invoke-CtgExchangeDistListMirror -MirrorUser 'Christine Holleran' -NewUser 'aanand@core.tech'
        # 2 cloud-only static groups added; the dynamic one is filtered, the dir-synced one is the AD lane's.
        Should -Invoke Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 2 -Exactly
        ($acts -join ' ') | Should -Match 'mirrored group: Billing Team'
        ($acts -join ' ') | Should -Not -Match 'Core-ALL'
        ($acts -join ' ') | Should -Match '2 added,'
    }

    It 'warns when the mirror user is not found in Exchange' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { $null }
        $acts = Invoke-CtgExchangeDistListMirror -MirrorUser 'Ghost' -NewUser 'aanand@core.tech'
        ($acts -join ' ') | Should -Match 'mirror user not found in Exchange'
    }
}

Describe 'Invoke-CtgExchangeOffboarding' {
    BeforeEach {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-MailboxAutoReplyConfiguration -ModuleName Coretelligent.Exchange -MockWith { }
        # Default: the target HAS an EXO mailbox (so the EXO-only steps run). A MailUser test overrides this.
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
    }

    It 'converts the mailbox to shared when under the size threshold' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '10 GB (10,737,418,240 bytes)' } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        $r.MailboxSizeGB | Should -Be 10
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 1 -Exactly -ParameterFilter { $Type -eq 'Shared' }
        Should -Invoke Set-CASMailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $ActiveSyncEnabled -eq $false }
    }

    It 'MailUser (on-prem mailbox): converts on-prem, SKIPS the EXO-only steps, does not crash' {
        # EXO sees a MailUser (no mailbox) — the EXO cmdlets would throw "does not support this recipient
        # type". Convert runs on-prem (Set-RemoteMailbox); CAS/autoreply/delegate are skipped with a note.
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { $null }   # MailUser -> no EXO mailbox
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '0 GB (0 bytes)' } }
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Identity = 'jdoe@61commodities.com' } }
        Mock Set-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true; delegateManagerFullAccess = $true; removeDistributionGroups = $false }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke Set-RemoteMailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $Type -eq 'Shared' }
        Should -Invoke Set-CASMailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly   # EXO-only, skipped
        ($r.Actions -join ' ') | Should -Match 'MailUser'
    }

    # This used to return Status='ok' — a GREEN offboard step for a mailbox nobody touched. An offboard
    # that cannot even identify whose mailbox to convert must fail loudly, and must still touch nothing.
    It 'fails loudly (touching nothing) when the case has no user identity' {
        { Invoke-CtgExchangeOffboarding -User ([pscustomobject]@{ UserPrincipalName = '' }) -Config ([pscustomobject]@{ convertToShared = [pscustomobject]@{} }) } |
            Should -Throw -ExpectedMessage '*no UPN, email or name*'
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly
    }

    It 'resolves the offboard target by display name (Get-Recipient) when the case has no UPN' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ PrimarySmtpAddress = 'jpark@61commodities.com'; DisplayName = 'Jordan Park' } }
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '5 GB (5,368,709,120 bytes)' } }
        $r = Invoke-CtgExchangeOffboarding -User ([pscustomobject]@{ UserPrincipalName = ''; DisplayName = 'Jordan Park' }) -Config ([pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 } })
        ($r.Actions -join ' ') | Should -Match "resolved offboard target by display name 'Jordan Park'"
        $r.Upn | Should -Be 'jpark@61commodities.com'
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $Type -eq 'Shared' }
    }

    It 'converts a HYBRID (on-prem-mastered) mailbox via Set-RemoteMailbox + triggers a delta sync' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '10 GB (10,737,418,240 bytes)' } }
        # On-prem session present: Get-RemoteMailbox returns the object -> the on-prem path.
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Identity = 'jdoe@61commodities.com' } }
        Mock Set-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { }
        $state = @{ synced = $false }                              # mutated by the trigger (a closure)
        $trigger = { $state.synced = $true }.GetNewClosure()
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 } }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config $config -TriggerSync $trigger
        Should -Invoke Set-RemoteMailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $Type -eq 'Shared' }
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly -ParameterFilter { $Type -eq 'Shared' }
        $state.synced | Should -BeTrue
        ($r.Actions -join ' ') | Should -Match 'on-prem'
    }

    It 'does NOT convert when the mailbox is over the threshold (keeps it + license)' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '75 GB (80,530,636,800 bytes)' } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 } }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config $config
        $r.MailboxSizeGB | Should -Be 75
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly -ParameterFilter { $Type -eq 'Shared' }
        ($r.Actions -join ' ') | Should -Match 'over threshold'
    }

    It 'sets an out-of-office message when one is provided (on request)' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        $config = [pscustomobject]@{ autoReply = [pscustomobject]@{ message = 'No longer with the company.' } }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config $config
        Should -Invoke Set-MailboxAutoReplyConfiguration -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $AutoReplyState -eq 'Enabled' }
    }

    It 'grants the case manager Full Access (AutoMapping) when delegateManagerFullAccess is set' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @() }   # not yet delegated
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com'; ManagerEmail = 'boss@61commodities.com' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $User -eq 'boss@61commodities.com' -and @($AccessRights) -contains 'FullAccess' -and $AutoMapping }
        ($r.Actions -join ' ') | Should -Match 'granted manager boss@61commodities.com Full Access'
    }

    # FR #7: the intake names a delegate ("provide mailbox access to Peter Hegland") — planned onto
    # the config as grantFullAccessTo. The NAME is resolved to a mailbox before anything is granted.
    It 'grants the case-requested delegate Full Access, resolving a display name' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Resolve-CtgAddressByDisplayName -ModuleName Coretelligent.Exchange -MockWith { 'phegland@61commodities.com' }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config ([pscustomobject]@{ grantFullAccessTo = 'Peter Hegland' })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $User -eq 'phegland@61commodities.com' -and @($AccessRights) -contains 'FullAccess' -and $AutoMapping }
        ($r.Actions -join ' ') | Should -Match "resolved case-requested delegate 'Peter Hegland'"
    }

    It 'warns (and grants nothing) when the case-requested delegate name matches no single mailbox' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Resolve-CtgAddressByDisplayName -ModuleName Coretelligent.Exchange -MockWith { $null }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config ([pscustomobject]@{ grantFullAccessTo = 'Pete Hegland' })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'WARN the case asks for mailbox access'
    }

    It 'is idempotent — no re-grant when the manager already has Full Access' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @([pscustomobject]@{ User = 'boss@61commodities.com'; AccessRights = @('FullAccess') }) }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com'; ManagerEmail = 'boss@61commodities.com' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already has Full Access'
    }

    It 'removes the user from CLOUD distribution lists, skipping on-prem-synced ones' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-DistributionGroup -ModuleName Coretelligent.Exchange -MockWith {
            @(
                [pscustomobject]@{ Identity = 'cloud-dl'; DisplayName = 'Notifications'; IsDirSynced = $false }
                [pscustomobject]@{ Identity = 'synced-dl'; DisplayName = 'TechStaff'; IsDirSynced = $true }   # on-prem -> AD removes it
            )
        }
        Mock Get-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { @([pscustomobject]@{ PrimarySmtpAddress = 'jdoe@61commodities.com' }) }
        Mock Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config ([pscustomobject]@{ removeDistributionGroups = $true })
        # only the cloud DL is touched; the synced one is skipped (filtered out before the member check)
        Should -Invoke Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'cloud-dl' } -Times 1 -Exactly
        Should -Invoke Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'removed from cloud distribution list: Notifications'
    }

    It 'looks the manager up from the DIRECTORY when the case has none, and grants Full Access' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Get-User -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Manager = 'Patrick Breitner' } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ PrimarySmtpAddress = 'pbreitner@core.tech' } }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $User -eq 'pbreitner@core.tech' -and @($AccessRights) -contains 'FullAccess' }
        ($r.Actions -join ' ') | Should -Match 'resolved manager from the directory: pbreitner@core.tech'
    }

    It 'resolves the manager from Entra (Graph) when Exchange Get-User.Manager is blank' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        # Exchange's own view has no manager, but Entra (Graph) does — the real-world INC0841839 case.
        Mock Get-User -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Manager = '' } }
        # AdditionalProperties as a generic Dictionary — exactly what Graph returns (NOT a [hashtable]),
        # so this also guards Get-CtgProp's IDictionary handling.
        $mgrDict = [System.Collections.Generic.Dictionary[string, object]]::new()
        $mgrDict['mail'] = 'boss@core.tech'; $mgrDict['userPrincipalName'] = 'boss@core.tech'
        Mock Get-MgUserManager -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ AdditionalProperties = $mgrDict } }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $User -eq 'boss@core.tech' -and @($AccessRights) -contains 'FullAccess' }
        ($r.Actions -join ' ') | Should -Match 'resolved manager from the directory: boss@core.tech'
    }

    It 'warns (does not fail) when delegateManagerFullAccess is set but no manager on the case OR directory' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Get-User -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Manager = '' } }
        $r = Invoke-CtgExchangeOffboarding -User $user -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'no manager on the case'
    }

    It "uses the intake's managerName (a NAME, not an address) when the directory link is gone — INC0859438" {
        # The real failure: the AD offboard step had already CLEARED the manager link, so every
        # directory lookup came back empty — while the case form named the manager all along.
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Get-User -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Manager = '' } }   # link cleared
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Filter -match 'Elizabeth McPhillips' } -MockWith {
            [pscustomobject]@{ PrimarySmtpAddress = 'emcphillips@core.tech' }
        }
        $u = [pscustomobject]@{ UserPrincipalName = 'ahoule@core.tech'; managerName = 'Elizabeth McPhillips' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $User -eq 'emcphillips@core.tech' -and @($AccessRights) -contains 'FullAccess' }
        ($r.Actions -join ' ') | Should -Match "resolved manager 'Elizabeth McPhillips' from the case -> emcphillips@core.tech"
    }

    It 'never guesses when a manager NAME matches several mailboxes' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Get-User -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Manager = '' } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -MockWith {
            @([pscustomobject]@{ PrimarySmtpAddress = 'jsmith@core.tech' }, [pscustomobject]@{ PrimarySmtpAddress = 'jsmith2@core.tech' })
        }
        $u = [pscustomobject]@{ UserPrincipalName = 'ahoule@core.tech'; managerName = 'John Smith' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ delegateManagerFullAccess = $true })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match "names manager 'John Smith' but no single matching mailbox"
    }
}

Describe 'Connect-CtgExchange' {
    It 'connects app-only with a thumbprint on a Windows runner' {
        InModuleScope Coretelligent.Exchange {
            $IsWindows = $true   # simulate Windows so the cert-store path is allowed
            Mock Connect-ExchangeOnline -MockWith { }
            Connect-CtgExchange -AppId 'app-1' -Organization '61commodities.com' -CertificateThumbprint 'ABC123'
            Should -Invoke Connect-ExchangeOnline -Times 1 -ParameterFilter { $Organization -eq '61commodities.com' -and $CertificateThumbprint -eq 'ABC123' }
        }
    }

    It 'refuses a thumbprint on a non-Windows runner — points to CertificateBase64' {
        InModuleScope Coretelligent.Exchange {
            $IsWindows = $false   # the central macOS/Linux runner: no Windows cert store
            Mock Connect-ExchangeOnline -MockWith { }
            { Connect-CtgExchange -AppId 'app-1' -Organization 'x.com' -CertificateThumbprint 'ABC123' } | Should -Throw -ExpectedMessage '*Windows runner*'
            Should -Invoke Connect-ExchangeOnline -Times 0 -Exactly
        }
    }

    It 'connects cross-platform with a CertificateBase64 (.pfx written to a temp file, then deleted)' {
        Mock Connect-ExchangeOnline -ModuleName Coretelligent.Exchange -MockWith { }
        Connect-CtgExchange -AppId 'app-1' -Organization 'x.com' -CertificateBase64 'AAAA'
        Should -Invoke Connect-ExchangeOnline -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $CertificateFilePath -like '*.pfx' }
    }
}

Describe 'Connect-CtgExchangeOnPrem' {
    BeforeAll {
        function global:New-PSSession { [CmdletBinding()] param($ConfigurationName, $ConnectionUri, $Authentication, $Credential) }
        function global:Import-PSSession { [CmdletBinding()] param($Session, $CommandName, [switch]$AllowClobber, [switch]$DisableNameChecking) }
        Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Force
    }

    It 'opens a Kerberos Exchange remote session and imports only the *RemoteMailbox cmdlets' {
        $cred = [pscredential]::new('CORE\svc-ex', (ConvertTo-SecureString 'p' -AsPlainText -Force))
        Mock New-PSSession    -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Id = 7; Name = 'exch' } }
        Mock Import-PSSession -ModuleName Coretelligent.Exchange -MockWith { }
        $s = Connect-CtgExchangeOnPrem -ConnectionUri 'http://core-cce1-ex01.coretelligent.local/PowerShell/' -Credential $cred
        $s.Id | Should -Be 7
        Should -Invoke New-PSSession -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter {
            $ConfigurationName -eq 'Microsoft.Exchange' -and $ConnectionUri -eq 'http://core-cce1-ex01.coretelligent.local/PowerShell/' -and $Authentication -eq 'Kerberos'
        }
        # selective import avoids clobbering EXO's Get-Mailbox / Set-MailboxRegionalConfiguration
        Should -Invoke Import-PSSession -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $CommandName -contains '*RemoteMailbox' -and $AllowClobber }
    }
}

Describe 'Confirm-CtgExchange' {
    BeforeEach {
        function global:Get-Mailbox { [CmdletBinding()] param($Identity) }
        function global:Get-CASMailbox { [CmdletBinding()] param($Identity) }
        Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Force
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
    }

    It 'offboard: passes when the mailbox is shared and ActiveSync/OWA are off' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '10 GB (10,737,418,240 bytes)' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'SharedMailbox' } }
        Mock Get-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ ActiveSyncEnabled = $false; OWAEnabled = $false } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }
        $r = Confirm-CtgExchange -User $user -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when EXO still shows UserMailbox but the on-prem remote mailbox is shared (pending sync)' {
        # Hybrid: Set-RemoteMailbox -Type Shared converts on-prem immediately; EXO catches up on the next
        # sync. The read-back must accept the on-prem RemoteSharedMailbox instead of false-failing + looping.
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '0 GB (0 bytes)' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'RemoteSharedMailbox' } }
        Mock Get-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ ActiveSyncEnabled = $false; OWAEnabled = $false } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }
        $r = Confirm-CtgExchange -User $user -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'mailbox is shared' }).pass | Should -BeTrue
    }

    It 'offboard: MailUser (no EXO mailbox) — shared via on-prem remote, ActiveSync/OWA checks skipped' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '0 GB (0 bytes)' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { $null }   # MailUser: no EXO mailbox
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'RemoteSharedMailbox' } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }
        $r = Confirm-CtgExchange -User $user -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
        ($r.checks | Where-Object { $_.name -eq 'mailbox is shared' }).pass | Should -BeTrue
        @($r.checks | Where-Object { $_.name -like '*ActiveSync*' }).Count | Should -Be 0   # no EXO mailbox -> not checked
    }

    It 'offboard: still fails when NEITHER EXO nor the on-prem remote mailbox is shared' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '0 GB (0 bytes)' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'RemoteUserMailbox' } }
        Mock Get-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ ActiveSyncEnabled = $false; OWAEnabled = $false } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }
        $r = Confirm-CtgExchange -User $user -Config $config -Action 'offboard'
        ($r.checks | Where-Object { $_.name -eq 'mailbox is shared' }).pass | Should -BeFalse
    }

    It 'offboard: resolves by display name (same as the executor) so it checks the RIGHT mailbox' {
        # No UPN on the case — the validator must resolve via Get-Recipient, not check an empty identity
        # (which would always "miss" and trigger the offboard re-run loop).
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ PrimarySmtpAddress = 'esack@61commodities.com'; DisplayName = 'Evan Sacksner' } }
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '3 GB (3,221,225,472 bytes)' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'SharedMailbox' } }
        Mock Get-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ ActiveSyncEnabled = $false; OWAEnabled = $false } }
        $u = [pscustomobject]@{ UserPrincipalName = ''; DisplayName = 'Evan Sacksner' }
        $r = Confirm-CtgExchange -User $u -Config ([pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }) -Action 'offboard'
        $r.ok | Should -BeTrue
        Should -Invoke Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'esack@61commodities.com' } -Times 1
    }

    It 'offboard: passes (nothing to verify) when the target cannot be resolved — no re-run loop' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { @() }
        $u = [pscustomobject]@{ UserPrincipalName = ''; DisplayName = 'Nobody Here' }
        $r = Confirm-CtgExchange -User $u -Config ([pscustomobject]@{ convertToShared = [pscustomobject]@{} }) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: an over-threshold mailbox is allowed to stay a user mailbox' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '75 GB (80,530,636,800 bytes)' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
        Mock Get-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ ActiveSyncEnabled = $false; OWAEnabled = $false } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 }; blockMobileDevices = $true }
        $r = Confirm-CtgExchange -User $user -Config $config -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard has no lane: returns ok with no checks' {
        $r = Confirm-CtgExchange -User $user -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
        @($r.checks).Count | Should -Be 0
    }
}

Describe 'Invoke-CtgExchangeOnboarding' {
    BeforeEach {
        $script:user = [pscustomobject]@{ SamAccountName='jdoe'; MailNickname='jdoe'; DisplayName='John Doe'; UserPrincipalName='jdoe@core.tech'; WorkEmail='jdoe@core.tech' }
        $script:config = [pscustomobject]@{ enableRemoteMailbox = [pscustomobject]@{ routingDomain='coretell.mail.onmicrosoft.com'; emailAddressPolicyEnabled=$true } }
    }

    It 'enables the remote mailbox with the routing address and sets the policy flag' {
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { $null }
        Mock Enable-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith {}
        Mock Set-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith {}
        $r = Invoke-CtgExchangeOnboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke Enable-RemoteMailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $RemoteRoutingAddress -eq 'jdoe@coretell.mail.onmicrosoft.com' -and $PrimarySmtpAddress -eq 'jdoe@core.tech' } -Times 1
        Should -Invoke Set-RemoteMailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $EmailAddressPolicyEnabled -eq $true } -Times 1
    }

    It 'is idempotent — skips enable when already remote-enabled' {
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Identity='jdoe' } }
        Mock Enable-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith {}
        Mock Set-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith {}
        $r = Invoke-CtgExchangeOnboarding -User $user -Config $config
        Should -Invoke Enable-RemoteMailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already enabled'
    }
}

Describe 'Invoke-CtgExchangeHybridOnboard' {
    # Regression: a lane with NO enableRemoteMailbox config makes Invoke-CtgExchangeOnboarding return an
    # object with no Email property — the caller must read it defensively, not crash with
    # "The property 'Email' cannot be found on this object".
    It 'does not crash when the onboard lane has no enableRemoteMailbox config' {
        Mock Set-CtgMailboxRegional -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Actions=@() } }
        Mock Get-CtgRequestedGroupNames -ModuleName Coretelligent.Exchange -MockWith { @() }
        $user = [pscustomobject]@{ SamAccountName='ddirienzo'; UserPrincipalName='ddirienzo@core.tech'; DisplayName='Drew Dirienzo' }
        $cfg = [pscustomobject]@{ waitForSync=$false }  # no enableRemoteMailbox, no mirror
        $r = Invoke-CtgExchangeHybridOnboard -User $user -Config $cfg
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no remote-mailbox config'
    }
}

Describe 'Invoke-CtgExchangeHybridOnboard' {
    BeforeEach {
        $script:user = [pscustomobject]@{ SamAccountName='jdoe'; ManagerEmail='boss@core.tech' }
        Mock Invoke-CtgExchangeOnboarding -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ System='exchange'; Status='ok'; Email='jdoe@core.tech'; Routing='jdoe@coretell.mail.onmicrosoft.com'; Actions=@('enabled remote mailbox') } }
        Mock Set-CtgMailboxRegional   -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ System='exchange'; Status='ok'; Actions=@('regional set') } }
    }

    It 'runs enable -> wait -> regional and carries the manager email through' {
        Mock Wait-CtgMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Status='ok'; Found=$true; Identity='jdoe' } }
        $r = Invoke-CtgExchangeHybridOnboard -User $user -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        $r.Email  | Should -Be 'jdoe@core.tech'
        Should -Invoke Invoke-CtgExchangeOnboarding -ModuleName Coretelligent.Exchange -Times 1 -Exactly
        Should -Invoke Wait-CtgMailbox -ModuleName Coretelligent.Exchange -Times 1 -Exactly
        Should -Invoke Set-CtgMailboxRegional -ModuleName Coretelligent.Exchange -Times 1 -Exactly -ParameterFilter { $ManagerEmail -eq 'boss@core.tech' }
        ($r.Actions -join ' ') | Should -Match 'regional set'
    }

    It 'skips the sync-wait when waitForSync is false' {
        Mock Wait-CtgMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Status='ok'; Found=$true } }
        $r = Invoke-CtgExchangeHybridOnboard -User $user -Config ([pscustomobject]@{ waitForSync=$false })
        Should -Invoke Wait-CtgMailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        Should -Invoke Set-CtgMailboxRegional -ModuleName Coretelligent.Exchange -Times 1 -Exactly
    }

    It 'defers regional/calendar when the mailbox never syncs (no error)' {
        Mock Wait-CtgMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Status='timeout'; Found=$false } }
        $r = Invoke-CtgExchangeHybridOnboard -User $user -Config ([pscustomobject]@{})
        $r.Status  | Should -Be 'ok'
        $r.Warning | Should -Match 'not synced'
        Should -Invoke Set-CtgMailboxRegional -ModuleName Coretelligent.Exchange -Times 0 -Exactly
    }
}

Describe 'Set-CtgMailboxRegional' {
    It 'sets language/timezone and grants the manager Reviewer on the calendar' {
        Mock Set-MailboxRegionalConfiguration -ModuleName Coretelligent.Exchange -MockWith {}
        Mock Add-MailboxFolderPermission -ModuleName Coretelligent.Exchange -MockWith {}
        $config = [pscustomobject]@{ regional=[pscustomobject]@{ language='en-us'; timezone='Pacific Standard Time'; defaultTimezone='Eastern Standard Time' }; calendar=[pscustomobject]@{ grantManagerReviewer=$true } }
        Set-CtgMailboxRegional -Identity 'jdoe@core.tech' -Config $config -ManagerEmail 'boss@core.tech'
        Should -Invoke Set-MailboxRegionalConfiguration -ModuleName Coretelligent.Exchange -ParameterFilter { $TimeZone -eq 'Pacific Standard Time' } -Times 1
        Should -Invoke Add-MailboxFolderPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $User -eq 'boss@core.tech' -and $AccessRights -eq 'Reviewer' } -Times 1
    }

    It 'falls back to the default timezone when the location had none (literal {token})' {
        Mock Set-MailboxRegionalConfiguration -ModuleName Coretelligent.Exchange -MockWith {}
        $config = [pscustomobject]@{ regional=[pscustomobject]@{ language='en-us'; timezone='{location.timezone}'; defaultTimezone='Eastern Standard Time' } }
        Set-CtgMailboxRegional -Identity 'jdoe@core.tech' -Config $config
        Should -Invoke Set-MailboxRegionalConfiguration -ModuleName Coretelligent.Exchange -ParameterFilter { $TimeZone -eq 'Eastern Standard Time' } -Times 1
    }
}

Describe 'Wait-CtgMailbox' {
    It 'returns Found as soon as the mailbox appears in EXO' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Identity='jdoe' } }
        $r = Wait-CtgMailbox -Identity 'jdoe@core.tech' -TimeoutSeconds 5 -IntervalSeconds 0
        $r.Found | Should -BeTrue
        $r.Status | Should -Be 'ok'
    }

    It 'returns timeout when the mailbox never lands within the window' {
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { $null }
        $r = Wait-CtgMailbox -Identity 'jdoe@core.tech' -TimeoutSeconds 0 -IntervalSeconds 0
        $r.Found | Should -BeFalse
        $r.Status | Should -Be 'timeout'
    }

    It 'keeps polling until the mailbox appears (no open-ended sleep)' {
        $script:n = 0
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { $script:n++; if ($script:n -ge 3) { [pscustomobject]@{ Identity='jdoe' } } else { $null } }
        $r = Wait-CtgMailbox -Identity 'jdoe@core.tech' -TimeoutSeconds 10 -IntervalSeconds 0
        $r.Found | Should -BeTrue
        Should -Invoke Get-Mailbox -ModuleName Coretelligent.Exchange -Times 3
    }
}

Describe 'Invoke-CtgExchangeNamedGroups' {
    It 'adds a DL via Add-DistributionGroupMember, a 365 group via Add-UnifiedGroupLinks, and warns on an unknown name' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'DCG' } -MockWith { [pscustomobject]@{ DisplayName = 'DCG'; Identity = 'DCG'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; IsDirSynced = $false } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'Team365' } -MockWith { [pscustomobject]@{ DisplayName = 'Team365'; Identity = 'Team365'; RecipientTypeDetails = 'GroupMailbox'; IsDirSynced = $false } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'Ghost' } -MockWith { $null }
        Mock Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Add-UnifiedGroupLinks -ModuleName Coretelligent.Exchange -MockWith { }
        $acts = Invoke-CtgExchangeNamedGroups -NewUser 'laura@dcg.co' -Groups @('DCG', 'Team365', 'Ghost')
        Should -Invoke Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 1 -Exactly
        Should -Invoke Add-UnifiedGroupLinks -ModuleName Coretelligent.Exchange -Times 1 -Exactly
        ($acts -join ' ') | Should -Match 'added to distribution group: DCG'
        ($acts -join ' ') | Should -Match 'added to 365 group: Team365'
        ($acts -join ' ') | Should -Match 'not found in Exchange Online'
    }

    It 'skips a dir-synced distribution list (AD lane owns it)' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'Synced DL' } -MockWith { [pscustomobject]@{ DisplayName = 'Synced DL'; Identity = 'Synced DL'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; IsDirSynced = $true } }
        Mock Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        $acts = Invoke-CtgExchangeNamedGroups -NewUser 'laura@dcg.co' -Groups @('Synced DL')
        Should -Invoke Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 0 -Exactly
        ($acts -join ' ') | Should -Match 'on-prem-synced group'
    }
}

# --- convert-to-shared safety: unknown size, config intent, and the cloud read-back ---------------
# Regression guards for the offboard licence path. The licence gate downstream keys off the action
# lines these tests assert on, and removing a licence from a mailbox that is NOT really shared in the
# cloud lets Exchange purge the mail after its 30-day grace.

Describe 'Test-CtgConvertToShared' {
    It 'reads the INTENT out of every profile shape, not the object''s existence' {
        Test-CtgConvertToShared $null | Should -BeFalse
        Test-CtgConvertToShared $true | Should -BeTrue
        Test-CtgConvertToShared $false | Should -BeFalse
        # a settings bag: its presence is the opt-in
        Test-CtgConvertToShared ([pscustomobject]@{ skipIfMailboxOverGB = 50 }) | Should -BeTrue
        # marketscience's shape — the one that exists specifically to say "don't"
        Test-CtgConvertToShared ([pscustomobject]@{ value = $true; unless = 'instructed not to' }) | Should -BeTrue
        Test-CtgConvertToShared ([pscustomobject]@{ value = $false; unless = 'instructed not to' }) | Should -BeFalse
    }
}

Describe 'Get-CtgMailboxSizeGB' {
    It 'returns $null (unknown) — never 0 — when the size cannot be read or parsed' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { $null }
        Get-CtgMailboxSizeGB -Identity 'x@y.com' | Should -BeNullOrEmpty
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = 'Unlimited' } }
        Get-CtgMailboxSizeGB -Identity 'x@y.com' | Should -BeNullOrEmpty
        Get-CtgMailboxSizeGB -Identity '' | Should -BeNullOrEmpty
    }
}

Describe 'ConvertFrom-CtgMailboxSize' {
    # FR #20: a 33 MB mailbox once read as "size unknown" because its TotalItemSize deserialized with
    # no "(…,… bytes)" suffix. The parser must recover a real size from every shape it arrives in, and
    # still return $null (never 0) for a genuinely unreadable one.
    It 'reads exact bytes from the parenthetical string form' {
        ConvertFrom-CtgMailboxSize '10 GB (10,737,418,240 bytes)' | Should -Be 10
        ConvertFrom-CtgMailboxSize '0 GB (0 bytes)' | Should -Be 0
    }
    It 'reads the structured .Value.ToBytes() (a live EXO session)' {
        $size = [pscustomobject]@{ Value = [pscustomobject]@{ } }
        $size.Value | Add-Member -MemberType ScriptMethod -Name ToBytes -Value { 35127296 } # 33.5 MB
        ConvertFrom-CtgMailboxSize $size | Should -Be 0.03
    }
    It 'recovers a unit-suffixed string with NO byte count — the UM0029906 shape' {
        ConvertFrom-CtgMailboxSize '33.5 MB' | Should -Be 0.03
        ConvertFrom-CtgMailboxSize '1.2 GB'  | Should -Be 1.2
        ConvertFrom-CtgMailboxSize '512 KB'  | Should -Be 0
        ConvertFrom-CtgMailboxSize '2 TB'    | Should -Be 2048
    }
    It 'a 33 MB mailbox is UNDER the 50 GB cap (the whole point — convert must be offered)' {
        (ConvertFrom-CtgMailboxSize '33.5 MB') -lt 50 | Should -BeTrue
    }
    It 'returns $null for unparseable / empty input — an unknown size is not zero' {
        ConvertFrom-CtgMailboxSize 'Unlimited' | Should -BeNullOrEmpty
        ConvertFrom-CtgMailboxSize ''          | Should -BeNullOrEmpty
        ConvertFrom-CtgMailboxSize $null       | Should -BeNullOrEmpty
    }
}

Describe 'Invoke-CtgExchangeOffboarding convert safety' {
    BeforeEach {
        $script:user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com'; DisplayName = 'J Doe' }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-CASMailbox -ModuleName Coretelligent.Exchange -MockWith { }
    }

    It 'does NOT convert when the mailbox size is unknown — an unreadable size is not a small one' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { $null }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ skipIfMailboxOverGB = 50 } }
        $r = Invoke-CtgExchangeOffboarding -User $script:user -Config $config
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly -ParameterFilter { $Type -eq 'Shared' }
        ($r.Actions -join ' ') | Should -Match 'WARN mailbox size UNKNOWN'
        ($r.Actions -join ' ') | Should -Match 'WARN mailbox NOT converted'
    }

    It 'does NOT convert when the profile says value:false' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        $config = [pscustomobject]@{ convertToShared = [pscustomobject]@{ value = $false; unless = 'instructed not to' } }
        $r = Invoke-CtgExchangeOffboarding -User $script:user -Config $config
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly -ParameterFilter { $Type -eq 'Shared' }
        ($r.Actions -join ' ') | Should -Not -Match 'converted mailbox to shared'
    }

    It 'hybrid: claims the convert only once the CLOUD reads SharedMailbox' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Identity = 'jdoe' } }
        # cloud has caught up
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'SharedMailbox' } }
        $r = Invoke-CtgExchangeOffboarding -User $script:user -Config ([pscustomobject]@{ convertToShared = $true })
        ($r.Actions -join ' ') | Should -Match 'verified shared in the cloud'
    }

    It 'hybrid: WARNs and does NOT claim the convert while the cloud still reads UserMailbox' {
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ Identity = 'jdoe' } }
        # dirsync hasn't landed — the cloud object is still a user mailbox
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox' } }
        $r = Invoke-CtgExchangeOffboarding -User $script:user -Config ([pscustomobject]@{ convertToShared = $true })
        Should -Invoke Set-RemoteMailbox -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $Type -eq 'Shared' }
        ($r.Actions -join ' ') | Should -Match 'WARN convert submitted on-prem'
        ($r.Actions -join ' ') | Should -Not -Match 'verified shared in the cloud'
    }

    It 'MailUser with no on-prem session: WARNs instead of throwing on Set-Mailbox' {
        # No EXO mailbox AND no Get-RemoteMailbox object -> the old code called Set-Mailbox anyway,
        # which throws "does not support recipients of this type" and aborted the whole step.
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -MockWith { $null }
        Mock Get-MailboxStatistics -ModuleName Coretelligent.Exchange -MockWith { [pscustomobject]@{ TotalItemSize = '1 GB (1,073,741,824 bytes)' } }
        Mock Get-RemoteMailbox -ModuleName Coretelligent.Exchange -MockWith { $null }
        $r = Invoke-CtgExchangeOffboarding -User $script:user -Config ([pscustomobject]@{ convertToShared = $true; removeDistributionGroups = $false })
        $r.Status | Should -Be 'ok'
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -Times 0 -Exactly -ParameterFilter { $Type -eq 'Shared' }
        ($r.Actions -join ' ') | Should -Match 'WARN mailbox NOT converted'
    }
}
