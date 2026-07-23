#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Per-agent token: bearer selection + provisionToken adoption. Dot-sources the REAL
# lib/CtgAgentAuth.ps1 (the file Start-IamRunner.ps1 itself dot-sources) so these tests exercise
# production code, not a re-implementation of the logic inline.

BeforeAll { . "$PSScriptRoot/../lib/CtgAgentAuth.ps1" }

Describe 'Get-CtgBearer' {
    AfterEach {
        $script:AgentToken = $null
        $script:ApiToken = $null
    }

    It 'prefers the per-agent token over the shared token' {
        $script:AgentToken = 'agt_abc'
        $script:ApiToken = 'shared-xyz'
        Get-CtgBearer | Should -Be 'agt_abc'
    }

    It 'falls back to the shared token when no per-agent token is set' {
        $script:AgentToken = ''
        $script:ApiToken = 'shared-xyz'
        Get-CtgBearer | Should -Be 'shared-xyz'
    }

    It 'returns nothing when neither token is set (mTLS-only host)' {
        $script:AgentToken = ''
        $script:ApiToken = ''
        Get-CtgBearer | Should -BeNullOrEmpty
    }
}

Describe 'Set-CtgAgentToken (provisionToken adoption)' {
    BeforeEach {
        $script:AgentToken = ''
        $script:ApiToken = 'shared-xyz'
        $env:RUNNER_AGENT_TOKEN = $null
        $env:RUNNER_API_TOKEN = 'shared-xyz'
    }

    AfterAll {
        $script:AgentToken = $null
        $script:ApiToken = $null
        $env:RUNNER_AGENT_TOKEN = $null
        $env:RUNNER_API_TOKEN = $null
    }

    It 'switches the bearer to the delivered token' {
        # Simulates the runner's real heartbeat-response branch: $hb.provisionToken -> Set-CtgAgentToken.
        $hb = [pscustomobject]@{ provisionToken = 'agt_new' }
        if ($hb.provisionToken) { Set-CtgAgentToken -Token ([string]$hb.provisionToken) }
        Get-CtgBearer | Should -Be 'agt_new'
    }

    It 'persists the new token to the session env var' {
        Set-CtgAgentToken -Token 'agt_new'
        $env:RUNNER_AGENT_TOKEN | Should -Be 'agt_new'
    }

    It 'drops the shared token (script var and session env var)' {
        Set-CtgAgentToken -Token 'agt_new'
        $script:ApiToken | Should -BeNullOrEmpty
        $env:RUNNER_API_TOKEN | Should -BeNullOrEmpty
    }

    It 'never falls back to the shared token once adopted' {
        Set-CtgAgentToken -Token 'agt_new'
        # Even if something re-set the shared token afterward, the per-agent one still wins.
        $script:ApiToken = 'shared-xyz'
        Get-CtgBearer | Should -Be 'agt_new'
    }
}
