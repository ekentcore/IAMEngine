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
        @{ System = 'm365';             Fns = @('Connect-CtgM365', 'Invoke-CtgM365Onboarding', 'Invoke-CtgM365Offboarding', 'New-CtgCompliantPassword') }
        @{ System = 'active-directory'; Fns = @('Invoke-CtgADOnboarding', 'Invoke-CtgADOffboarding') }
        @{ System = 'mimecast';         Fns = @('Connect-CtgMimecast', 'Invoke-CtgMimecastOnboarding', 'Invoke-CtgMimecastOffboarding') }
        @{ System = 'directory-sync';   Fns = @('Invoke-CtgDirectorySync') }
        @{ System = 'exchange';         Fns = @('Connect-CtgExchange', 'Invoke-CtgExchangeOffboarding') }
        @{ System = 'zoom';             Fns = @('Connect-CtgZoom', 'Invoke-CtgZoomOnboarding', 'Invoke-CtgZoomOffboarding') }
        @{ System = 'adobe';            Fns = @('Connect-CtgAdobe', 'Invoke-CtgAdobeOnboarding', 'Invoke-CtgAdobeOffboarding') }
        @{ System = 'perimeter81';      Fns = @('Connect-CtgPerimeter81', 'Invoke-CtgPerimeter81Onboarding', 'Invoke-CtgPerimeter81Offboarding') }
    )
    It 'exports every function the <System> lane dispatches' -ForEach $cases {
        foreach ($fn in $Fns) {
            (Get-Command $fn -ErrorAction SilentlyContinue) | Should -Not -BeNullOrEmpty -Because "$fn is dispatched for $System"
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
