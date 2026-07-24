# The wire scrub for conn-test rights rows. Secrets are scrubbed out of every detail before the
# POST, but the row's CLASSIFICATION flags must survive the rebuild: dropping `optional` made a
# healthy credential that lacks only optional caps read as a red "✗ missing 6" in the app
# (core1747) — summarizeRights counts a flagless ok=$false row as a REQUIRED miss.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop) — like the
# GraphCaps suite, parse it as text and lift the one pure function under test.

BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $src = Get-Content "$Root/Start-IamRunner.ps1" -Raw
    $fn = [regex]::Match($src, "(?ms)^function ConvertTo-CtgConnTestWireRights\s*(\([^)]*\))?\s*\{.*?^\}")
    $fn.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare ConvertTo-CtgConnTestWireRights'
    . ([scriptblock]::Create($fn.Value))
    # The scrubber the function rides — identity-with-marker stub so the test can prove every
    # detail went through it; the scrubbing itself is covered by its own suite.
    function Protect-CtgSecretsInText([string]$Text, $Creds) { "scrubbed:$Text" }
}

Describe 'ConvertTo-CtgConnTestWireRights' {
    It 'scrubs every detail through Protect-CtgSecretsInText' {
        $rows = ConvertTo-CtgConnTestWireRights @(@{ op = 'a'; ok = $true; detail = 'granted via X' }) $null
        @($rows).Count | Should -Be 1
        $rows[0].detail | Should -Be 'scrubbed:granted via X'
        $rows[0].op | Should -Be 'a'
        $rows[0].ok | Should -BeTrue
    }
    It 'preserves the optional flag, and never invents one on a required row (core1747)' {
        $rows = ConvertTo-CtgConnTestWireRights @(
            @{ op = 'create / update users'; ok = $true; detail = 'granted via User.ReadWrite.All' }
            @{ op = 'remove MFA methods on offboard'; ok = $false; optional = $true; detail = 'optional — grant UserAuthenticationMethod.ReadWrite.All — …' }
        ) $null
        $rows[0].ContainsKey('optional') | Should -BeFalse
        $rows[1].optional | Should -BeTrue
    }
    It 'preserves surplus (and the optional it rides with) so over-permission rows stay non-failing' {
        $rows = ConvertTo-CtgConnTestWireRights @(@{ op = 'OVER-PERMISSIONED: RoleManagement.ReadWrite.Directory'; ok = $false; optional = $true; surplus = $true; detail = 'x' }) $null
        $rows[0].surplus | Should -BeTrue
        $rows[0].optional | Should -BeTrue
    }
    It 'keeps the ok tri-state intact ($null = unverifiable)' {
        $rows = ConvertTo-CtgConnTestWireRights @(@{ op = 'console sign-in (browser)'; ok = $null; detail = 'no browser runtime' }) $null
        $rows[0].ok | Should -Be $null
    }
}
