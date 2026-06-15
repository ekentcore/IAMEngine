#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Exchange. The Exchange Online (EXO V3) cmdlets aren't installed
# here, so we stub + mock them. Focus: convert-to-shared honoring the >50 GB skip, CAS disable,
# and the on-request OOO message.

BeforeAll {
    function global:Connect-ExchangeOnline { [CmdletBinding()] param($AppId, $Organization, $CertificateThumbprint, [switch]$ShowBanner) }
    function global:Get-MailboxStatistics { [CmdletBinding()] param($Identity) }
    function global:Set-Mailbox { [CmdletBinding()] param($Identity, $Type, $ForwardingSmtpAddress, [switch]$DeliverToMailboxAndForward) }
    function global:Set-CASMailbox { [CmdletBinding()] param($Identity, $ActiveSyncEnabled, $OWAEnabled) }
    function global:Set-MailboxAutoReplyConfiguration { [CmdletBinding()] param($Identity, $AutoReplyState, $InternalMessage, $ExternalMessage) }
    # on-prem hybrid remote-mailbox + post-sync EXO finishing
    function global:Get-RemoteMailbox { [CmdletBinding()] param($Identity) }
    function global:Enable-RemoteMailbox { [CmdletBinding()] param($Identity, $RemoteRoutingAddress, $Alias, $DisplayName, $PrimarySmtpAddress) }
    function global:Set-RemoteMailbox { [CmdletBinding()] param($Identity, $EmailAddressPolicyEnabled) }
    function global:Set-MailboxRegionalConfiguration { [CmdletBinding()] param($Identity, $Language, $TimeZone) }
    function global:Add-MailboxFolderPermission { [CmdletBinding()] param($Identity, $User, $AccessRights, [switch]$Confirm) }
    function global:Get-Mailbox { [CmdletBinding()] param($Identity) }
    # distribution-list mirror (EXO)
    function global:Get-Recipient { [CmdletBinding()] param($Identity, $Filter, $ResultSize) }
    function global:Add-DistributionGroupMember { [CmdletBinding()] param($Identity, $Member, [switch]$BypassSecurityGroupManagerCheck) }

    Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Force
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
}

Describe 'Connect-CtgExchange' {
    It 'connects app-only with appId, org and certificate thumbprint' {
        Mock Connect-ExchangeOnline -ModuleName Coretelligent.Exchange -MockWith { }
        Connect-CtgExchange -AppId 'app-1' -Organization '61commodities.com' -CertificateThumbprint 'ABC123'
        Should -Invoke Connect-ExchangeOnline -ModuleName Coretelligent.Exchange -Times 1 -ParameterFilter { $Organization -eq '61commodities.com' }
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
    It 'adds the user to a named distribution list; skips a non-DL group and an unknown name' {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'DCG' } -MockWith { [pscustomobject]@{ DisplayName = 'DCG'; Identity = 'DCG'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; IsDirSynced = $false } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'Team365' } -MockWith { [pscustomobject]@{ DisplayName = 'Team365'; Identity = 'Team365'; RecipientTypeDetails = 'GroupMailbox'; IsDirSynced = $false } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'Ghost' } -MockWith { $null }
        Mock Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        $acts = Invoke-CtgExchangeNamedGroups -NewUser 'laura@dcg.co' -Groups @('DCG', 'Team365', 'Ghost')
        Should -Invoke Add-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 1 -Exactly
        ($acts -join ' ') | Should -Match 'added to distribution group: DCG'
        ($acts -join ' ') | Should -Match 'not a distribution/mail-enabled group'
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
