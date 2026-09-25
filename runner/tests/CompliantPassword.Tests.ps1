# FR #0000114: "Uncommon characters that can't normally be typed on a keyboard should not be a part of
# the password" -- the runner-generated password (Google onboarding) must be typeable on any layout.
BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psm1" -Force -DisableNameChecking
}
AfterAll { Remove-Module Coretelligent.M365 -Force -ErrorAction SilentlyContinue }

Describe 'New-CtgCompliantPassword' {
    It 'is always printable keyboard ASCII, never uses the ^ dead key, and is at least 16 characters' {
        foreach ($i in 1..500) {
            $p = ConvertFrom-SecureString (New-CtgCompliantPassword) -AsPlainText
            $p | Should -Match '^[\x21-\x7E]+$'
            $p | Should -Not -Match '\^'
            $p.Length | Should -BeGreaterOrEqual 16
        }
    }
    It 'still carries every required character class' {
        foreach ($i in 1..200) {
            $p = ConvertFrom-SecureString (New-CtgCompliantPassword) -AsPlainText
            $p | Should -MatchExactly '[A-Z]'
            $p | Should -MatchExactly '[a-z]'
            $p | Should -Match '[2-9]'
            $p | Should -Match '[!@#$%&*\-_=+?]'
        }
    }
}
