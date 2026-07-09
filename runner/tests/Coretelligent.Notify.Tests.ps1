#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Notify. Mocks the Graph send seam (Send-MgUserMail). Behaviour pinned:
# offboard sends the communication email to the list + the "RE: INC..." case-note email; templates expand;
# missing config skips cleanly (warns, never fails).

BeforeAll {
    function global:Send-MgUserMail { param($UserId, $BodyParameter, $ErrorAction) }
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Notify/Coretelligent.Notify.psm1" -Force
}

Describe 'Expand-CtgNoticeTemplate' {
    It 'substitutes tokens' {
        $r = Expand-CtgNoticeTemplate 'Offboarding ({fullName}) in {department}' @{ fullName = 'Jane Doe'; department = 'Sales' }
        $r | Should -Be 'Offboarding (Jane Doe) in Sales'
    }
}

Describe 'Invoke-CtgNotifyOffboarding' {
    BeforeEach { Mock Send-MgUserMail -ModuleName Coretelligent.Notify -MockWith { } }

    It 'sends the communication email to the offboarding list and the RE-INC case note' {
        $user = [pscustomobject]@{ DisplayName = 'Jane Doe'; Department = 'Sales'; CaseNumber = 'INC123' }
        $config = [pscustomobject]@{ sender = 'offboarding@coretelligent.com'; recipients = @('a@core.tech', 'b@core.tech') }
        $r = Invoke-CtgNotifyOffboarding -User $user -Config $config
        # communication email to the two recipients, subject names the person
        Should -Invoke Send-MgUserMail -ModuleName Coretelligent.Notify -ParameterFilter {
            $UserId -eq 'offboarding@coretelligent.com' -and $BodyParameter.message.subject -eq 'Offboarding (Jane Doe)' -and $BodyParameter.message.toRecipients.Count -eq 2
        } -Times 1
        # case note to internalsupport, threaded with the RE-INC subject
        Should -Invoke Send-MgUserMail -ModuleName Coretelligent.Notify -ParameterFilter {
            $BodyParameter.message.subject -match '^RE: INC123' -and $BodyParameter.message.toRecipients[0].emailAddress.address -eq 'internalsupport@core.tech'
        } -Times 1
        ($r.Actions -join ' ') | Should -Match 'communication email to 2'
        ($r.Actions -join ' ') | Should -Match 'RE: INC123'
    }

    It 'warns and sends nothing when no sender is configured' {
        $r = Invoke-CtgNotifyOffboarding -User ([pscustomobject]@{ DisplayName = 'Jane Doe' }) -Config ([pscustomobject]@{ recipients = @('a@core.tech') })
        Should -Invoke Send-MgUserMail -ModuleName Coretelligent.Notify -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'no sender mailbox'
    }

    It 'skips the case note when there is no case number, still sends the communication email' {
        $r = Invoke-CtgNotifyOffboarding -User ([pscustomobject]@{ DisplayName = 'Jane Doe' }) -Config ([pscustomobject]@{ sender = 'x@core.tech'; recipients = @('a@core.tech') })
        Should -Invoke Send-MgUserMail -ModuleName Coretelligent.Notify -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'case-note email skipped'
    }

    It 'does not fail the step when a send throws (best-effort)' {
        Mock Send-MgUserMail -ModuleName Coretelligent.Notify -MockWith { throw 'graph 500' }
        $r = Invoke-CtgNotifyOffboarding -User ([pscustomobject]@{ DisplayName = 'Jane Doe'; CaseNumber = 'INC1' }) -Config ([pscustomobject]@{ sender = 'x@core.tech'; recipients = @('a@core.tech') })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'WARN could not send'
    }
}
