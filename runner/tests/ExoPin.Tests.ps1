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

# FR #0000129 / #0000130: startup installs and imports the pin, but Repair-CtgMissingModule used to
# install the gallery LATEST for any self-healed module. For ExchangeOnlineManagement that put the
# BROKEN 3.10.0 on the host permanently, so the moment the pin was missing the startup fallback picked
# it and every Exchange job died with "does not contain a method named 'GetResponseHeader'".
# core1748 hit it twice on 2026-09-08.
Describe 'the self-heal respects the EXO pin' {
    It 'asks for the pinned version rather than the gallery latest' {
        $repair = [regex]::Match($script:Runner, '(?ms)^function Repair-CtgMissingModule \{.*?^\}').Value
        $repair | Should -Not -BeNullOrEmpty
        # The pin must be chosen BEFORE the install decision that falls back to latest. Plain substring
        # rather than a regex — the line is full of $ and braces that a pattern would have to escape.
        $repair.Contains("-eq 'ExchangeOnlineManagement'") | Should -BeTrue
        $repair.Contains('$reqVer = $ExoModuleVersion') | Should -BeTrue
        $pinAt   = $repair.IndexOf("-eq 'ExchangeOnlineManagement'")
        $installAt = $repair.IndexOf('if ($reqVer)')
        $pinAt | Should -BeGreaterThan -1
        $installAt | Should -BeGreaterThan $pinAt
    }

    It 'still pins a Microsoft.Graph submodule to the installed Graph version (unchanged)' {
        # The Graph pin exists for the sibling reason — mismatched submodule versions throw
        # "Assembly with same name is already loaded". This change must not disturb it.
        $repair = [regex]::Match($script:Runner, '(?ms)^function Repair-CtgMissingModule \{.*?^\}').Value
        $repair | Should -Match "Microsoft.Graph.Authentication"
    }
}

# FR #0000130: the Exchange-finish failure hint blamed permissions and certificates for this error,
# which sent an operator to re-consent an app that was already correctly configured.
Describe 'the Exchange finish hint names the real cause' {
    It 'does not blame permissions for a GetResponseHeader failure' {
        $fn = [regex]::Match($script:Runner, '(?ms)WARN Exchange Online finish failed').Value
        $fn | Should -Not -BeNullOrEmpty
        # The module-version branch must exist and must be reached BEFORE the catch-all hint.
        $branchAt = $script:Runner.IndexOf('GetResponseHeader|does not contain a method named')
        $catchAllAt = $script:Runner.IndexOf('grant the m365-admin app Exchange.ManageAsApp + set its cert')
        $branchAt | Should -BeGreaterThan -1
        $catchAllAt | Should -BeGreaterThan $branchAt
    }

    It 'says plainly that it is NOT a permissions problem, and names the fix' {
        $script:Runner | Should -Match 'NOT a permissions or certificate problem'
        $script:Runner | Should -Match 'Install-Module ExchangeOnlineManagement -RequiredVersion'
    }
}
