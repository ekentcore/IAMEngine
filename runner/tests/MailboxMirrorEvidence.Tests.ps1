#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Task 6 — the shared-mailbox mirror's per-grant evidence lines must name the mailbox SMTP,
# the display name, AND the mirror source (an auditor reading a single line otherwise can't
# tell whose access was copied). See Invoke-CtgExchangeSharedMailboxMirror.

BeforeAll {
    # Same stub set as Coretelligent.Exchange.Tests.ps1's SharedMailboxMirror describe block —
    # the EXO V3 cmdlets aren't installed here, so we stub + mock them.
    function global:Get-Recipient { [CmdletBinding()] param($Identity, $Filter, $ResultSize) }
    function global:Get-Mailbox { [CmdletBinding()] param($Identity, $RecipientTypeDetails, $ResultSize) }
    function global:Get-MailboxPermission { [CmdletBinding()] param($Identity) }
    function global:Add-MailboxPermission { [CmdletBinding()] param($Identity, $User, $AccessRights, $InheritanceType, [switch]$AutoMapping, [switch]$Confirm) }
    function global:Get-RecipientPermission { [CmdletBinding()] param($Identity) }
    function global:Add-RecipientPermission { [CmdletBinding()] param($Identity, $Trustee, $AccessRights, [switch]$Confirm) }
    function global:Set-Mailbox { [CmdletBinding()] param($Identity, $GrantSendOnBehalfTo) }

    Import-Module "$PSScriptRoot/../modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1" -Force
}

Describe 'Invoke-CtgExchangeSharedMailboxMirror — evidence naming' {
    BeforeEach {
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'John Smith' } -MockWith { [pscustomobject]@{ DisplayName = 'John Smith'; PrimarySmtpAddress = 'john.smith@x.com'; UserPrincipalName = 'john.smith@x.com'; Name = 'John Smith' } }
        Mock Get-Recipient -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'jane@x.com' } -MockWith { [pscustomobject]@{ DisplayName = 'Jane Doe'; PrimarySmtpAddress = 'jane@x.com'; UserPrincipalName = 'jane@x.com'; Name = 'Jane Doe' } }
        Mock Get-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $RecipientTypeDetails -eq 'SharedMailbox' } -MockWith {
            @([pscustomobject]@{ DisplayName = 'Finance'; PrimarySmtpAddress = 'finance@x.com'; Identity = 'finance@x.com'; GrantSendOnBehalfTo = @() })
        }
        # Mirror user (John Smith) holds explicit FullAccess on the Finance shared mailbox; the target
        # (jane@x.com) does not yet — so the mirror should grant it.
        Mock Get-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith {
            @([pscustomobject]@{ User = 'john.smith@x.com'; AccessRights = @('FullAccess'); IsInherited = $false })
        }
        Mock Get-RecipientPermission -ModuleName Coretelligent.Exchange -MockWith { @() }
        Mock Add-MailboxPermission -ModuleName Coretelligent.Exchange -MockWith { }
        Mock Set-Mailbox -ModuleName Coretelligent.Exchange -MockWith { }
    }

    It 'names the mailbox SMTP, display name, and the mirror source on the grant line' {
        $actions = Invoke-CtgExchangeSharedMailboxMirror -MirrorUser 'John Smith' -NewUser 'jane@x.com'

        ($actions -join ';') | Should -Match ([regex]::Escape('granted FullAccess on shared mailbox finance@x.com (Finance) — mirrored from John Smith'))
        Should -Invoke Add-MailboxPermission -ModuleName Coretelligent.Exchange -ParameterFilter { $Identity -eq 'finance@x.com' -and $User -eq 'jane@x.com' } -Times 1
    }
}
