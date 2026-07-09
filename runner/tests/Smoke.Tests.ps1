#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Smoke test: the runner script parses and every function its DISPATCH map calls is exported
# by its module. Runs anywhere — modules are imported by .psm1 (no Microsoft.Graph / AD / live
# tenant needed to LOAD them). This is the "is the wiring intact?" check for the POC host.

BeforeAll {
    $script:Root = "$PSScriptRoot/.."
    Get-ChildItem "$Root/modules" -Recurse -Filter '*.psm1' | ForEach-Object { Import-Module $_.FullName -Force }
}

Describe 'Runner wiring smoke' {
    It 'Start-IamRunner.ps1 parses without syntax errors' {
        $errs = $null
        [System.Management.Automation.Language.Parser]::ParseFile("$Root/Start-IamRunner.ps1", [ref]$null, [ref]$errs) | Out-Null
        $errs | Should -BeNullOrEmpty
    }

    # systemKey -> the functions the DISPATCH lanes invoke (keep in sync with Start-IamRunner.ps1).
    $cases = @(
        @{ System = 'm365';             Fns = @('Connect-CtgM365', 'Invoke-CtgM365Onboarding', 'Invoke-CtgM365Offboarding', 'New-CtgCompliantPassword', 'Confirm-CtgM365') }
        @{ System = 'active-directory'; Fns = @('Invoke-CtgADOnboarding', 'Invoke-CtgADOffboarding', 'Confirm-CtgAD') }
        @{ System = 'mimecast';         Fns = @('Connect-CtgMimecast', 'Invoke-CtgMimecastOnboarding', 'Invoke-CtgMimecastOffboarding', 'Confirm-CtgMimecast') }
        @{ System = 'directory-sync';   Fns = @('Invoke-CtgDirectorySync', 'Confirm-CtgDirectorySync') }
        @{ System = 'exchange';         Fns = @('Connect-CtgExchange', 'Invoke-CtgExchangeHybridOnboard', 'Invoke-CtgExchangeOffboarding', 'Confirm-CtgExchange') }
        @{ System = 'zoom';             Fns = @('Connect-CtgZoom', 'Invoke-CtgZoomOnboarding', 'Invoke-CtgZoomOffboarding', 'Confirm-CtgZoom') }
        @{ System = 'adobe';            Fns = @('Connect-CtgAdobe', 'Invoke-CtgAdobeOnboarding', 'Invoke-CtgAdobeOffboarding', 'Confirm-CtgAdobe') }
        @{ System = 'perimeter81';      Fns = @('Connect-CtgPerimeter81', 'Invoke-CtgPerimeter81Onboarding', 'Invoke-CtgPerimeter81Offboarding', 'Confirm-CtgPerimeter81') }
    )
    It 'exports every function the <System> lane dispatches' -ForEach $cases {
        foreach ($fn in $Fns) {
            (Get-Command $fn -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty -Because "$fn is dispatched for $System"
        }
    }

    It 'Start-IamRunner.ps1 Import-Modules the module behind EVERY dispatched function' {
        # Catches "added a DISPATCH lane + Use-*Secret but forgot the Import-Module" — the smoke
        # BeforeAll imports every .psm1 itself, so it can't see what the RUNNER actually loads.
        $runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw
        $imported = @([regex]::Matches($runner, 'modules/(Coretelligent\.[A-Za-z0-9]+)/') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        $referenced = @([regex]::Matches($runner, '\b((?:Invoke|Confirm|Connect)-Ctg[A-Za-z0-9]+)\b') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
        foreach ($fn in $referenced) {
            $cmd = Get-Command $fn -ErrorAction SilentlyContinue
            if (-not $cmd -or $cmd.ModuleName -notlike 'Coretelligent.*') { continue }  # runner-local helper -> not a module import
            $imported | Should -Contain $cmd.ModuleName -Because "$fn lives in $($cmd.ModuleName) — Start-IamRunner.ps1 must Import-Module it"
        }
    }

    It 'every module manifest parses and declares its root + exports' {
        # Import-PowerShellDataFile validates the manifest as data without resolving its
        # RequiredModules (Graph / ActiveDirectory aren't installed in this test environment).
        foreach ($psd1 in (Get-ChildItem "$Root/modules" -Recurse -Filter '*.psd1')) {
            $m = Import-PowerShellDataFile -Path $psd1.FullName
            $m.RootModule        | Should -Not -BeNullOrEmpty -Because "$($psd1.Name) needs a RootModule"
            $m.FunctionsToExport  | Should -Not -BeNullOrEmpty -Because "$($psd1.Name) must export functions"
        }
    }
}
