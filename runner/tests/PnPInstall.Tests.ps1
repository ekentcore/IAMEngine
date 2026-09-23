# FR #0000116: "The current OneDrive delegation is not working, and needs to function by adding
# Delegates as a Site Collection Admin, rather than the current method that is failing."
#
# The site-collection-admin grant the request asks for already exists — Grant-CtgSharePointSiteAccess
# in Coretelligent.SharePoint. It had never run on any host that did not already have PnP.PowerShell,
# for the SAME reason the EXO pin had never run (see ExoPin.Tests.ps1 and ad4cd7fc): Install-CtgPnPModule
# called Install-Module INSIDE the runner process, where PowerShellGet refuses with "The version
# '1.4.8.1' of module 'PackageManagement' is currently in use" — and by that point Initialize-CtgGallery
# has just loaded PackageManagement, one line above, every single time.
#
# The EXO version of this failure was loud downstream: the fallback loaded a broken build and Exchange
# jobs died. This one is silent end to end. $pnpAvail goes false, the m365 Offboard dispatch block skips
# the whole hand-off with no action line, and the only OneDrive grant the case reports is the Graph
# /invite (a per-item 'write' permission on the drive root) — which reads green. That is exactly the
# shape the request describes: a delegation that reports success and does not deliver the access.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like ExoPin.Tests.ps1
# — we pull the functions out of the script text and evaluate just them.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $m = [regex]::Match($script:Runner, '(?ms)^function Install-CtgPnPModule \{.*?^\}')
    $m.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Install-CtgPnPModule'
    . ([scriptblock]::Create($m.Value))

    # The out-of-process install seam, shared with the EXO pin. Dot-sourced (not stubbed) so these tests
    # also assert the script really declares it — mocking a command Pester cannot resolve is a
    # CommandNotFound error.
    $p = [regex]::Match($script:Runner, '(?ms)^function Invoke-CtgPwshInstall \{.*?^\}')
    $p.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Invoke-CtgPwshInstall'
    . ([scriptblock]::Create($p.Value))

    function Initialize-CtgGallery { }  # stub the gallery bootstrap the guard calls before installing

    # This pwsh has no PowerShellGet, so there is no real Install-Module for Pester to hook —
    # declare a stub with the parameters the guard passes, then Mock over it.
    function Install-Module {
        param([string]$Name, [version]$RequiredVersion, [string]$Scope, [switch]$Force,
              [switch]$AllowClobber, [switch]$Confirm, [switch]$AcceptLicense, [string]$ErrorAction)
    }

    function script:FakeModule([string]$Name, [string]$Version) {
        [pscustomobject]@{ Name = $Name; Version = [version]$Version }
    }
}

Describe 'Install-CtgPnPModule installs out-of-process' {
    BeforeEach { $script:LastPnpError = $null }

    It 'installs PnP in a CLEAN child pwsh, never in the running session' {
        # In-session Install-Module is the bug: Initialize-CtgGallery loads PackageManagement one line
        # earlier, and PowerShellGet then refuses to install anything while it is in use.
        Mock Get-Module { $null }
        Mock Invoke-CtgPwshInstall { [pscustomobject]@{ Code = 0; Tail = '' } }
        Mock Install-Module { }
        Mock Write-Warning { }
        Mock Write-Host { }
        $null = Install-CtgPnPModule
        Should -Invoke Invoke-CtgPwshInstall -Times 1 -Exactly -ParameterFilter { $Name -eq 'PnP.PowerShell' }
        Should -Invoke Install-Module -Times 0 -Exactly
    }

    It 'is a no-op when PnP is already installed' {
        Mock Get-Module { @(FakeModule 'PnP.PowerShell' '2.12.0') }
        Mock Invoke-CtgPwshInstall { throw 'must not be called when PnP is already present' }
        Install-CtgPnPModule | Should -BeTrue
    }

    It 'reports availability from the host, not from the install call succeeding' {
        # A child process that exits 0 having installed nothing must NOT read as available — the only
        # trustworthy answer is whether the module is on the host afterwards.
        Mock Get-Module { $null }
        Mock Invoke-CtgPwshInstall { [pscustomobject]@{ Code = 0; Tail = '' } }
        Mock Write-Warning { }
        Mock Write-Host { }
        Install-CtgPnPModule | Should -BeFalse
    }
}

Describe 'Install-CtgPnPModule says why when it cannot' {
    BeforeEach { $script:LastPnpError = $null }

    It 'records WHY when PnP is still absent after the attempt' {
        # The host state that hid this for two months: the install is refused and PnP never appears.
        Mock Get-Module { $null }
        Mock Invoke-CtgPwshInstall {
            [pscustomobject]@{ Code = 1; Tail = "The version '1.4.8.1' of module 'PackageManagement' is currently in use." }
        }
        Mock Write-Warning { }
        Mock Write-Host { }
        $null = Install-CtgPnPModule
        $script:LastPnpError | Should -Not -BeNullOrEmpty
        $script:LastPnpError | Should -Match 'PackageManagement'
    }

    It 'names the consequence, not just the error — which grant will not happen' {
        Mock Get-Module { $null }
        Mock Invoke-CtgPwshInstall { [pscustomobject]@{ Code = 1; Tail = 'gallery unreachable' } }
        Mock Write-Warning { }
        Mock Write-Host { }
        $null = Install-CtgPnPModule
        $script:LastPnpError | Should -Match 'site-collection admin'
    }

    It 'clears a previously recorded failure once PnP IS present' {
        # Having the module outranks any reason we did not have it earlier — mirrors the EXO pin.
        $script:LastPnpError = 'a stale reason from the last boot'
        Mock Get-Module { @(FakeModule 'PnP.PowerShell' '2.12.0') }
        Mock Invoke-CtgPwshInstall { throw 'must not be called when PnP is already present' }
        $null = Install-CtgPnPModule
        $script:LastPnpError | Should -BeNullOrEmpty
    }

    It 'never throws when the child process itself cannot be started' {
        Mock Get-Module { $null }
        Mock Invoke-CtgPwshInstall { throw 'pwsh not found' }
        Mock Write-Warning { }
        Mock Write-Host { }
        { Install-CtgPnPModule } | Should -Not -Throw
        $script:LastPnpError | Should -Not -BeNullOrEmpty
    }
}

# Invoke-CtgPwshInstall was written for the EXO pin, which pins an exact version. PnP is deliberately
# unpinned (it tracks the gallery latest), so the seam has to be able to install WITHOUT
# -RequiredVersion rather than being handed a made-up version.
Describe 'Invoke-CtgPwshInstall supports an unpinned install' {
    It 'omits -RequiredVersion when no version is requested' {
        $fn = [regex]::Match($script:Runner, '(?ms)^function Invoke-CtgPwshInstall \{.*?^\}').Value
        $fn | Should -Not -Match '\[Parameter\(Mandatory\)\]\[string\]\$Version'
        $fn | Should -Match 'RequiredVersion'
    }

    It 'still pins the EXO install to an exact version (unchanged)' {
        # The EXO pin's whole purpose is the exact build; making Version optional must not weaken it.
        $exo = [regex]::Match($script:Runner, '(?ms)^function Install-CtgExoPin \{.*?^\}').Value
        $exo | Should -Match "-Version \`$Version"
    }
}

# The defect the request actually reports. Whether or not PnP is installable on a given host, an
# offboard that names a delegate and then does NOT run the site-collection-admin hand-off must say so
# on the case. It used to skip in silence: `if ($pnpAvail -and $spDelegate) { ... }` with no else, so
# the leaver's data stayed unreachable and the run report showed only the Graph /invite line, green.
Describe 'a skipped SharePoint hand-off is never silent (script invariant)' {
    It 'records a skip line when a delegate was named but PnP is unavailable' {
        $block = [regex]::Match($script:Runner, '(?ms)\$spDelegate = \[string\]\(Get-CtgProp \$job\.config.*?\n            \}\n            \$r\n').Value
        $block | Should -Not -BeNullOrEmpty -Because 'the m365 Offboard dispatch block must be findable'
        # A delegate named + no PnP must produce an action line, not nothing at all.
        $block | Should -Match 'elseif \(\$spDelegate\)'
        $block | Should -Match 'SharePoint hand-off skipped'
    }

    It 'tells the operator the access the delegate did NOT get' {
        # "skipped" alone sends nobody anywhere. The line has to name what is missing (full site access,
        # vs. the per-item invite that DID run) so the case says what to do by hand.
        $block = [regex]::Match($script:Runner, '(?ms)\$spDelegate = \[string\]\(Get-CtgProp \$job\.config.*?\n            \}\n            \$r\n').Value
        $block | Should -Match 'site-collection admin'
    }

    It 'names several delegates as a list, not run together into one nonexistent person' {
        # FR #0000120 was exactly this: [string] on an array joins with a space, so "Rachel Thompson"
        # and "Nicole Hayes" became "Rachel Thompson Nicole Hayes". The gate may use the joined value;
        # the line that NAMES people must not.
        $block = [regex]::Match($script:Runner, '(?ms)\$spDelegate = \[string\]\(Get-CtgProp \$job\.config.*?\n            \}\n            \$r\n').Value
        $block | Should -Match "-join ', '"
        $block | Should -Not -Match "so '\`$spDelegate' was NOT"
    }
}

# Recording a reason nobody reads is the failure this whole request is made of, so the recorded reason
# has to reach a file that outlives the process. Write-CtgLog does not exist yet at install time (the
# install runs ~line 353, the logger is declared ~line 380), which is why this is a two-step: record
# there, report once startup has a logger.
Describe 'the recorded PnP failure reaches runner.log' {
    It 'initialises the slot immediately before the install, not later' {
        # Anywhere later and it erases the verdict the self-heal just recorded — the EXO pin carries the
        # same comment for the same reason.
        $initAt = $script:Runner.IndexOf('$script:LastPnpError = $null' + "`n" + '$pnpAvail = Install-CtgPnPModule')
        $initAt | Should -BeGreaterThan -1
    }

    It 'writes the recorded reason to the persistent log once at startup' {
        $script:Runner | Should -Match 'if \(\$script:LastPnpError\) \{ Write-CtgLog'
    }

    It 'reports it AFTER Write-CtgLog is declared' {
        # Calling it at install time would throw CommandNotFound — the logger is declared further down.
        $loggerAt = $script:Runner.IndexOf('function Write-CtgLog')
        $reportAt = $script:Runner.IndexOf('PnP.PowerShell unavailable:')
        $loggerAt | Should -BeGreaterThan -1
        $reportAt | Should -BeGreaterThan $loggerAt
    }
}

# The comment above Install-CtgPnPModule claimed "the app's claim gate withholds those grants from it".
# No such gate exists: $script:OnPremCapabilityProbe reports only active-directory and directory-sync
# (plus 'browser'), there is no PnP capability anywhere, and the hand-off is not a separate job — it
# rides inside the m365 offboard, which every cloud runner can claim. A comment asserting a safety net
# that is not there is how this survived two months of review.
Describe 'the PnP gate does not claim a protection it does not have' {
    It 'does not assert that the claim gate withholds SharePoint grants' {
        $script:Runner | Should -Not -Match "claim gate withholds those grants"
    }

    It 'reports no PnP capability, consistent with there being no gate' {
        $probe = [regex]::Match($script:Runner, '(?ms)\$script:OnPremCapabilityProbe = \[ordered\]@\{.*?\}').Value
        $probe | Should -Not -BeNullOrEmpty
        $probe | Should -Not -Match 'pnp|sharepoint'
    }
}
