#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Browser (the bridge to the Node/Playwright sidecar) and the Spanning
# force-sync executor that rides it. These do NOT launch a real browser — Test-CtgBrowserAvailable is
# false here (no node_modules/@playwright), which pins the graceful "unavailable" path; the executor
# tests mock Invoke-CtgBrowserFlow to pin the result mapping.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Browser/Coretelligent.Browser.psd1" -Force
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Spanning/Coretelligent.Spanning.psm1" -Force
}

Describe 'Test-CtgBrowserAvailable' {
    It 'returns $false on a host without the Playwright sidecar installed (node_modules absent)' {
        # node may or may not be on PATH; either way, node_modules/@playwright is not present in the repo.
        Test-CtgBrowserAvailable | Should -BeOfType [bool]
    }
    It 'returns $false when node is not on PATH' {
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { $null } -ParameterFilter { $Name -eq 'node' }
        Test-CtgBrowserAvailable | Should -BeFalse
    }
}

Describe 'Invoke-CtgBrowserFlow' {
    It 'returns a graceful ok=$false (never throws) when the sidecar is unavailable' {
        Mock Test-CtgBrowserAvailable -ModuleName Coretelligent.Browser -MockWith { $false }
        $r = Invoke-CtgBrowserFlow -Flow 'spanning-force-sync' -InputObject @{ username = 'u'; password = 'p'; params = @{ email = 'a@b.com' } }
        $r.ok | Should -BeFalse
        $r.error | Should -Match 'unavailable'
    }
}

Describe 'Invoke-CtgSpanningForceSync' {
    BeforeAll {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }
        $cfg  = [pscustomobject]@{}
        $secret = [pscustomobject]@{ Fields = @{ Username = 'admin@medipost.com'; Password = 'secret' } }
    }

    It 'maps a successful sync to an ok result with a triggered action line' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $true; message = 'triggered a Spanning directory sync'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'triggered a Spanning directory sync'
        $r.PSObject.Properties['RetryAfterMinutes'] | Should -BeNullOrEmpty
    }

    It 'passes RetryAfterMinutes through when the portal reports the sync is async/queued' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $true; message = 'clicked the sync control'; error = $null; evidence = $null; retryAfterMinutes = 10 }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        $r.Status | Should -Be 'ok'
        $r.RetryAfterMinutes | Should -Be 10
    }

    It 'maps a flow failure to a WARN action (not a throw)' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $false; message = $null; error = 'portal requires MFA — browser automation can''t complete'; evidence = '/tmp/shot.png'; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        $r.Status | Should -Be 'ok'  # ad-hoc convenience action never hard-fails the case
        ($r.Actions -join ' ') | Should -Match 'WARN'
        ($r.Actions -join ' ') | Should -Match 'MFA'
    }

    It 'builds the portal login from the brokered secret fields (Username/Password synonyms)' {
        $captured = $null
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            $script:capturedInput = $InputObject
            [pscustomobject]@{ ok = $true; message = 'ok'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 1 -ParameterFilter {
            $Flow -eq 'spanning-force-sync' -and $InputObject.username -eq 'admin@medipost.com' -and $InputObject.password -eq 'secret' -and $InputObject.params.email -eq 'jdoe@medipost.com'
        }
    }

    It 'WARNs (no browser call) when no portal credentials are brokered' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith { throw 'should not be called' }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret ([pscustomobject]@{ Fields = @{} })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'WARN'
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 0
    }
}
