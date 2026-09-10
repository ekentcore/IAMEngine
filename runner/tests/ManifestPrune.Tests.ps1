#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# The self-update PRUNE. Dot-sources the REAL lib/CtgUpdate.ps1 (the file both Start-IamRunner.ps1 and
# the pool supervisor dot-source) and runs it against a throwaway runner folder, so these exercise
# production code rather than a re-implementation.
#
# The prune exists so a removed/renamed bundle file cannot linger and hold the build id away from the
# app's forever. What it must NOT do is reach outside the bundle's own file set: browser/node_modules
# holds the Playwright sidecar and .node the portable Node, neither ships in the manifest, and deleting
# them stopped the agent reporting the 'browser' capability -- which made the claim gate withhold every
# browser job from every agent, leaving them pending with no error (FR #0000121).

BeforeAll { . "$PSScriptRoot/../lib/CtgUpdate.ps1" }

Describe 'Invoke-CtgManifestPull prune' {
    BeforeEach {
        $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ("ctgprune-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $script:Root | Out-Null

        # What the app serves.
        $script:Manifest = @{ buildId = 'deadbeef1234'; files = @('Start-IamRunner.ps1', 'modules/Coretelligent.M365/Coretelligent.M365.psm1') }
        Mock Invoke-RestMethod -MockWith { [pscustomobject]$script:Manifest }
        Mock Invoke-WebRequest  -MockWith { [pscustomobject]@{ Content = 'pulled-content' } }

        function New-TestFile([string]$rel, [string]$body = 'x') {
            $p = Join-Path $script:Root $rel
            New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
            [System.IO.File]::WriteAllText($p, $body)
            return $p
        }

        # In the manifest -- must survive (and be overwritten by the pull).
        $script:Kept    = New-TestFile 'Start-IamRunner.ps1' 'old'
        # NOT in the manifest and inside the bundle's file set -- the prune's actual job.
        $script:Stale   = New-TestFile 'modules/Coretelligent.Gone/Coretelligent.Gone.psm1'
        # NOT in the manifest and OUTSIDE it -- must all survive.
        $script:Sidecar = New-TestFile 'browser/node_modules/@playwright/test/package.json'
        $script:Node    = New-TestFile '.node/node.exe'
        $script:Tests   = New-TestFile 'tests/Something.Tests.ps1'
        $script:Scripts = New-TestFile 'scripts/diagnose.ps1'
        $script:Build   = New-TestFile '.build'
        $script:Lock    = New-TestFile '.runner.abc123.lock'
        $script:Log     = New-TestFile 'runner.log'
    }

    AfterEach { Remove-Item -Recurse -Force -LiteralPath $script:Root -ErrorAction SilentlyContinue }

    It 'keeps the browser sidecar that is deliberately absent from the manifest (FR #0000121)' {
        Invoke-CtgManifestPull -AppUrl 'https://app' -ApiToken 't' -RunnerDir $script:Root | Out-Null
        Test-Path -LiteralPath $script:Sidecar | Should -BeTrue
    }

    It 'keeps the portable Node, tests, scripts and every runtime dot-file' {
        Invoke-CtgManifestPull -AppUrl 'https://app' -ApiToken 't' -RunnerDir $script:Root | Out-Null
        Test-Path -LiteralPath $script:Node    | Should -BeTrue
        Test-Path -LiteralPath $script:Tests   | Should -BeTrue
        Test-Path -LiteralPath $script:Scripts | Should -BeTrue
        Test-Path -LiteralPath $script:Build   | Should -BeTrue
        Test-Path -LiteralPath $script:Lock    | Should -BeTrue
        Test-Path -LiteralPath $script:Log     | Should -BeTrue
    }

    It 'STILL prunes a stale bundle file, which is the whole point of the prune' {
        Invoke-CtgManifestPull -AppUrl 'https://app' -ApiToken 't' -RunnerDir $script:Root | Out-Null
        Test-Path -LiteralPath $script:Stale | Should -BeFalse
    }

    It 'pulls every manifest file and reports the build id' {
        $r = Invoke-CtgManifestPull -AppUrl 'https://app' -ApiToken 't' -RunnerDir $script:Root
        $r.buildId | Should -Be 'deadbeef1234'
        $r.count   | Should -Be 2
        [System.IO.File]::ReadAllText($script:Kept) | Should -Be 'pulled-content'
    }
}
