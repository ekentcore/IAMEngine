# Microsoft.Graph submodules only import together when every resolved submodule carries the SAME
# version — a mixed set (Authentication 2.33 next to Users 2.38, from installs drifting across the
# SYSTEM profile and AllUsers) dies at Import-Module with "Assembly with same name is already
# loaded", killing the runner before it polls (Six One DC agent, 2026-07-13). The runner aligns the
# set at startup; these tests exercise that guard.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# ConnectionCache tests — we pull the function out of the script text and evaluate just it.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $m = [regex]::Match($script:Runner, '(?ms)^function Repair-CtgGraphVersionSkew \{.*?^\}')
    $m.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Repair-CtgGraphVersionSkew'
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

Describe 'Repair-CtgGraphVersionSkew' {
    It 'aligns every lagging submodule to the highest installed version' {
        Mock Get-Module {
            @(
                (FakeModule 'Microsoft.Graph.Authentication' '2.33.0'),
                (FakeModule 'Microsoft.Graph.Authentication' '2.30.0'),  # older copy in another scope
                (FakeModule 'Microsoft.Graph.Users' '2.38.0'),
                (FakeModule 'Microsoft.Graph.Groups' '2.38.0')
            )
        }
        Mock Install-Module { }
        Mock Write-Warning { }
        Repair-CtgGraphVersionSkew
        # only Authentication (resolved 2.33.0) lags behind the 2.38.0 target
        Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter {
            $Name -eq 'Microsoft.Graph.Authentication' -and $RequiredVersion -eq [version]'2.38.0'
        }
    }

    It 'is a no-op when every submodule resolves to the same version' {
        Mock Get-Module {
            @(
                (FakeModule 'Microsoft.Graph.Authentication' '2.38.0'),
                (FakeModule 'Microsoft.Graph.Users' '2.38.0')
            )
        }
        Mock Install-Module { }
        Repair-CtgGraphVersionSkew
        Should -Invoke Install-Module -Times 0 -Exactly
    }

    It 'is a no-op when no Graph modules are installed at all' {
        Mock Get-Module { @() }
        Mock Install-Module { }
        Repair-CtgGraphVersionSkew
        Should -Invoke Install-Module -Times 0 -Exactly
    }

    It 'keeps going when one align fails (best-effort, never blocks startup)' {
        Mock Get-Module {
            @(
                (FakeModule 'Microsoft.Graph.Authentication' '2.30.0'),
                (FakeModule 'Microsoft.Graph.Users' '2.31.0'),
                (FakeModule 'Microsoft.Graph.Groups' '2.38.0')
            )
        }
        Mock Install-Module { throw 'gallery unreachable' }
        Mock Write-Warning { }
        { Repair-CtgGraphVersionSkew } | Should -Not -Throw
        Should -Invoke Install-Module -Times 2 -Exactly   # tried both lagging modules
    }
}

Describe 'self-heal Graph install pinning (script invariants)' {
    It 'pins a self-healed Microsoft.Graph submodule to the installed Authentication version' {
        # Repair-CtgMissingModule must never grab the gallery-latest Graph submodule: that is
        # exactly how a host ends up with a mixed set.
        $script:Runner | Should -Match "(?ms)\`$mod -like 'Microsoft\.Graph\*'.*?Microsoft\.Graph\.Authentication"
        $script:Runner | Should -Match 'Install-Module \$mod -RequiredVersion \$reqVer'
    }

    It 'runs the skew guard before the first heavy module import' {
        $guard  = $script:Runner.IndexOf('Repair-CtgGraphVersionSkew')
        $import = $script:Runner.IndexOf('modules/Coretelligent.M365/Coretelligent.M365.psd1')
        $guard | Should -BeGreaterThan -1
        ($guard -lt $import) | Should -BeTrue -Because 'the repair must happen before Import-Module can die on the skew'
    }
}
