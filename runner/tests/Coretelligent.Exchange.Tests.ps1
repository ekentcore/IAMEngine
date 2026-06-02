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

    Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Force
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
