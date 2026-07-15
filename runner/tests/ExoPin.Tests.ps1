# ExchangeOnlineManagement 3.10.0's REST cmdlets call HttpResponseMessage.GetResponseHeader() — a
# method that no longer exists on PS7.6's HttpResponseMessage — so every Exchange job dies with
# "does not contain a method named 'GetResponseHeader'" (puretech/core2104, 2026-07-15). The runner
# pins to the known-good 3.9.2, but the pin only helps if it's INSTALLED; a host with only the broken
# 3.10.0 used to fall back to it and limp. Install-CtgExoPin self-heals the pin at startup. These
# tests exercise that guard.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the Graph
# skew tests — we pull the function out of the script text and evaluate just it.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $m = [regex]::Match($script:Runner, '(?ms)^function Install-CtgExoPin \{.*?^\}')
    $m.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Install-CtgExoPin'
    . ([scriptblock]::Create($m.Value))

    function Initialize-CtgGallery { }  # stub the gallery bootstrap the guard calls before installing

    # This pwsh has no PowerShellGet, so there is no real Install-Module for Pester to hook -
    # declare a stub with the parameters the guard passes, then Mock over it.
    function Install-Module {
        param([string]$Name, [version]$RequiredVersion, [string]$Scope, [switch]$Force,
              [switch]$AllowClobber, [switch]$Confirm, [switch]$AcceptLicense, [string]$ErrorAction)
    }

    function script:FakeModule([string]$Name, [string]$Version) {
        [pscustomobject]@{ Name = $Name; Version = [version]$Version }
    }
}

Describe 'Install-CtgExoPin' {
    It 'installs the pin, at the exact requested version, when it is absent' {
        # The failing state: only the broken 3.10.0 is on the host, the 3.9.2 pin is missing.
        Mock Get-Module { @(FakeModule 'ExchangeOnlineManagement' '3.10.0') }
        Mock Install-Module { }
        Mock Write-Warning { }
        Install-CtgExoPin -Version '3.9.2'
        Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'ExchangeOnlineManagement' -and $RequiredVersion -eq [version]'3.9.2'
        }
    }

    It 'is a no-op when the pin is already installed (even alongside the broken build)' {
        Mock Get-Module {
            @(
                (FakeModule 'ExchangeOnlineManagement' '3.9.2'),
                (FakeModule 'ExchangeOnlineManagement' '3.10.0')   # broken build present too — pin still wins
            )
        }
        Mock Install-Module { }
        Install-CtgExoPin -Version '3.9.2'
        Should -Invoke Install-Module -Times 0 -Exactly
    }

    It 'installs the pin when EXO is not present at all' {
        Mock Get-Module { @() }
        Mock Install-Module { }
        Mock Write-Warning { }
        Install-CtgExoPin -Version '3.9.2'
        Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter { $RequiredVersion -eq [version]'3.9.2' }
    }

    It 'never throws when the gallery is unreachable (best-effort, never blocks startup)' {
        Mock Get-Module { @(FakeModule 'ExchangeOnlineManagement' '3.10.0') }
        Mock Install-Module { throw 'gallery unreachable' }
        Mock Write-Warning { }
        { Install-CtgExoPin -Version '3.9.2' } | Should -Not -Throw
        Should -Invoke Install-Module -Times 1 -Exactly
    }
}

Describe 'EXO pin self-heal (script invariants)' {
    It 'runs the pin self-heal BEFORE resolving/importing ExchangeOnlineManagement' {
        $heal   = $script:Runner.IndexOf('Install-CtgExoPin -Version $ExoModuleVersion')
        $import = $script:Runner.IndexOf('Import-Module ExchangeOnlineManagement -RequiredVersion')
        $heal | Should -BeGreaterThan -1
        ($heal -lt $import) | Should -BeTrue -Because 'the pin must be present before the import picks a build'
    }

    It 'defaults the pin to a build known to survive PS7.6 (not 3.10.0)' {
        $script:Runner | Should -Match "ExoModuleVersion = '3\.9\.2'"
    }
}
