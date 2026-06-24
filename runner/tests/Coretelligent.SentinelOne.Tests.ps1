#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.SentinelOne. Mocks the HTTP seam (Invoke-CtgSentinelOneApi).
# Behaviour pinned: offboard network-isolates the user's endpoint (idempotent; skips if already
# isolated; refuses to act when the machine is ambiguous/unresolvable); shutdown only when asked.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.SentinelOne/Coretelligent.SentinelOne.psm1" -Force
}

Describe 'Invoke-CtgSentinelOneOffboarding' {
    It 'network-isolates the matched endpoint (default, no shutdown)' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a1'; computerName = 'LT-JDOE'; networkStatus = 'connected' }) } }
            return [pscustomobject]@{ data = @{ affected = 1 } }
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' -and $Path -match 'disconnect' -and $Body.filter.ids -contains 'a1' } -Times 1
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Path -match 'shutdown' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'network-isolated'
    }

    It 'is idempotent — no isolate when the endpoint is already disconnected' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a1'; computerName = 'LT-JDOE'; networkStatus = 'disconnected' }) } }
            return $null
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already network-isolated'
    }

    It 'sends shutdown only when config.shutdown is set' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a1'; computerName = 'LT-JDOE'; networkStatus = 'connected' }) } }
            return $null
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{ shutdown = $true })
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Path -match 'shutdown' -and $Body.filter.ids -contains 'a1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'sent shutdown'
    }

    It 'refuses to act when no machine can be resolved' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith { throw 'should not be called' }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@x.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'cannot resolve'
    }

    It 'refuses to act when more than one agent matches (ambiguous)' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @(
                [pscustomobject]@{ id = 'a1'; computerName = 'LT-JDOE'; networkStatus = 'connected' },
                [pscustomobject]@{ id = 'a2'; computerName = 'LT-JDOE'; networkStatus = 'connected' }
            ) } }
            return $null
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'ambiguous'
    }

    It 'is a clean no-op when no agent matches the machine' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @() } }
            return $null
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ computerName = 'GONE-PC' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'no SentinelOne agent found'
    }
}

Describe 'Invoke-CtgSentinelOneOffboarding (multiple devices)' {
    It 'isolates EVERY device in -Machines and records each in Isolated' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') {
                if ($Path -match 'PC-A') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a'; computerName = 'PC-A'; networkStatus = 'connected' }) } }
                if ($Path -match 'PC-B') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'b'; computerName = 'PC-B'; networkStatus = 'connected' }) } }
                return [pscustomobject]@{ data = @() }
            }
            return $null
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'x@y.com' }) -Config ([pscustomobject]@{}) -Machines @('PC-A', 'PC-B')
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' -and $Path -match 'disconnect' -and $Body.filter.ids -contains 'a' } -Times 1
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' -and $Path -match 'disconnect' -and $Body.filter.ids -contains 'b' } -Times 1
        @($r.Isolated).Count | Should -Be 2
        @($r.Isolated | ForEach-Object { $_.machine }) | Should -Contain 'PC-A'
    }

    It 'isolates the reachable device and cleanly skips a not-found one (mixed list)' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') {
                if ($Path -match 'PC-A') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a'; computerName = 'PC-A'; networkStatus = 'connected' }) } }
                return [pscustomobject]@{ data = @() }   # PC-GONE absent
            }
            return $null
        }
        $r = Invoke-CtgSentinelOneOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'x@y.com' }) -Config ([pscustomobject]@{}) -Machines @('PC-A', 'PC-GONE')
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' -and $Body.filter.ids -contains 'a' } -Times 1
        @($r.Isolated).Count | Should -Be 1
        ($r.Actions -join ' ') | Should -Match "no SentinelOne agent found for 'PC-GONE'"
    }
}

Describe 'Invoke-CtgSentinelOneReconnect' {
    It 'reconnects by agent id via the connect action' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith { $null }
        $r = Invoke-CtgSentinelOneReconnect -AgentId 'a1' -Machine 'LT-JDOE'
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' -and $Path -match 'actions/connect' -and $Body.filter.ids -contains 'a1' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'reconnected'
    }

    It 'resolves the agent by machine name when no id is given' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET') { return [pscustomobject]@{ data = @([pscustomobject]@{ id = 'z9'; computerName = 'LT-JDOE'; networkStatus = 'disconnected' }) } }
            return $null
        }
        $r = Invoke-CtgSentinelOneReconnect -Machine 'LT-JDOE'
        Should -Invoke Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -ParameterFilter { $Method -eq 'POST' -and $Path -match 'actions/connect' -and $Body.filter.ids -contains 'z9' } -Times 1
    }
}

Describe 'Confirm-CtgSentinelOne' {
    It 'offboard: passes when the endpoint is isolated' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith { [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a1'; computerName = 'LT-JDOE'; networkStatus = 'disconnected' }) } }
        $r = Confirm-CtgSentinelOne -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: fails when the endpoint is still connected' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith { [pscustomobject]@{ data = @([pscustomobject]@{ id = 'a1'; computerName = 'LT-JDOE'; networkStatus = 'connected' }) } }
        $r = Confirm-CtgSentinelOne -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }

    It 'offboard: passes when no machine is resolvable (nothing claimed)' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith { throw 'should not be called' }
        $r = Confirm-CtgSentinelOne -User ([pscustomobject]@{ UserPrincipalName = 'x@y.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: always passes (deployment out of band)' {
        Mock Invoke-CtgSentinelOneApi -ModuleName Coretelligent.SentinelOne -MockWith { throw 'should not be called' }
        $r = Confirm-CtgSentinelOne -User ([pscustomobject]@{ computerName = 'LT-JDOE' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }
}
