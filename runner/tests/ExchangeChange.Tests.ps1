#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Invoke-CtgExchangeChange — the change/mover lane: add/remove DL & 365-group
# membership by name, and grant/revoke shared-mailbox FullAccess. Add paths reuse the existing
# onboard helper (Invoke-CtgExchangeNamedGroups); remove/revoke paths are new (Task 12) and must
# follow the audit-integrity pattern — a real failure surfaces as a WARN action, never a silent
# false-success, while an idempotent not-found is a benign skip line.

BeforeAll {
    # EXO V3's real cmdlets are proxy functions generated at runtime by Connect-ExchangeOnline — they
    # don't exist as static commands just from importing the module, so Mock can't find them to mock
    # (same reason the sibling Coretelligent.Exchange.Tests.ps1 stubs its own set). Stub the ones this
    # lane calls before importing, so Pester's Mock has a real command to intercept.
    function global:Get-Recipient { [CmdletBinding()] param($Identity, $Filter, $ResultSize) }
    function global:Remove-DistributionGroupMember { [CmdletBinding()] param($Identity, $Member, [switch]$BypassSecurityGroupManagerCheck, [switch]$Confirm) }
    function global:Remove-UnifiedGroupLinks { [CmdletBinding()] param($Identity, $LinkType, $Links, [switch]$Confirm) }
    function global:Add-MailboxPermission { [CmdletBinding()] param($Identity, $User, $AccessRights, $InheritanceType, [switch]$AutoMapping, [switch]$Confirm) }
    function global:Remove-MailboxPermission { [CmdletBinding()] param($Identity, $User, $AccessRights, [switch]$Confirm) }

    Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1" -Force
}

Describe 'Invoke-CtgExchangeChange' {
    BeforeEach {
        Mock -CommandName Invoke-CtgExchangeNamedGroups -ModuleName Coretelligent.Exchange -MockWith { param($NewUser, $Groups) @($Groups | ForEach-Object { "added to group: $_" }) }
        Mock -CommandName Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { param($Identity) [pscustomobject]@{ RecipientType = 'MailUniversalDistributionGroup'; RecipientTypeDetails = 'MailUniversalDistributionGroup'; Identity = $Identity } }
        Mock -CommandName Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { }
        Mock -CommandName Remove-UnifiedGroupLinks -ModuleName Coretelligent.Exchange -MockWith { }
        Mock -CommandName Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock -CommandName Remove-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
    }

    It 'adds named groups via the existing helper' {
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ namedGroups = @('sales@x.com') })
        Should -Invoke Invoke-CtgExchangeNamedGroups -ModuleName Coretelligent.Exchange -Times 1
        $r.Actions -join ';' | Should -Match 'added to group: sales@x.com'
    }

    It 'removes a named distribution list' {
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeNamedGroups = @('sales@x.com') })
        Should -Invoke Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 1
        Should -Invoke Remove-UnifiedGroupLinks -ModuleName Coretelligent.Exchange -Times 0
        $r.Actions -join ';' | Should -Match 'removed from distribution list: sales@x.com'
    }

    It 'removes a named 365 (Unified) group via Remove-UnifiedGroupLinks' {
        Mock -CommandName Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { param($Identity) [pscustomobject]@{ RecipientType = 'GroupMailbox'; RecipientTypeDetails = 'GroupMailbox'; Identity = $Identity } }
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeNamedGroups = @('allstaff@x.com') })
        Should -Invoke Remove-UnifiedGroupLinks -ModuleName Coretelligent.Exchange -Times 1
        Should -Invoke Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -Times 0
        $r.Actions -join ';' | Should -Match 'removed from 365 group: allstaff@x.com'
    }

    It 'skips a removeNamedGroups entry that does not resolve in EXO, without a WARN' {
        Mock -CommandName Get-Recipient -ModuleName Coretelligent.Exchange -MockWith { $null }
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeNamedGroups = @('ghost@x.com') })
        $r.Actions -join ';' | Should -Match 'group not found: ghost@x.com'
        $r.Actions -join ';' | Should -Not -Match 'WARN'
    }

    It 'grants and revokes shared-mailbox FullAccess' {
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ addSharedMailboxes = @('team@x.com'); removeSharedMailboxes = @('old@x.com') })
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1
        Should -Invoke Remove-MailboxPermission -ModuleName Coretelligent.Exchange -Times 1
        $r.Actions -join ';' | Should -Match 'granted FullAccess on: team@x.com'
        $r.Actions -join ';' | Should -Match 'revoked FullAccess on: old@x.com'
    }

    It 'WARNs (does not silently succeed) when revoking shared-mailbox access throws' {
        Mock -CommandName Remove-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { throw 'access denied' }
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeSharedMailboxes = @('old@x.com') })
        $r.Actions -join ';' | Should -Match 'WARN could not revoke'
        $r.Actions -join ';' | Should -Not -Match 'revoked FullAccess on: old@x.com'
    }

    It 'WARNs (does not silently succeed) when removing a distribution-list member throws' {
        Mock -CommandName Remove-DistributionGroupMember -ModuleName Coretelligent.Exchange -MockWith { throw 'object not found' }
        $r = Invoke-CtgExchangeChange -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{ removeNamedGroups = @('sales@x.com') })
        $r.Actions -join ';' | Should -Match 'WARN could not remove'
        $r.Actions -join ';' | Should -Not -Match 'removed from distribution list: sales@x.com'
    }
}
