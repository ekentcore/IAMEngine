#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Browser (the bridge to the Node/Playwright sidecar) and the Spanning
# force-sync executor that rides it. These do NOT launch a real browser — Test-CtgBrowserAvailable is
# false here (no node_modules/@playwright), which pins the graceful "unavailable" path; the executor
# tests mock Invoke-CtgBrowserFlow to pin the result mapping.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Browser/Coretelligent.Browser.psd1" -Force
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Spanning/Coretelligent.Spanning.psm1" -Force
}

Describe 'Test-CtgBrowserAvailable' {
    It 'returns $false on a host without the Playwright sidecar installed (node_modules absent)' {
        # node may or may not be on PATH; either way, node_modules/@playwright is not present in the repo.
        Test-CtgBrowserAvailable | Should -BeOfType [bool]
    }
    It 'returns $false when node is genuinely absent (not on PATH AND not in a standard dir)' {
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { $null } -ParameterFilter { $Name -eq 'node' }
        # Also defeat the standard-install-dir fallback, or this would find the real node on the box.
        Mock Test-Path -ModuleName Coretelligent.Browser -MockWith { $false }
        Test-CtgBrowserAvailable | Should -BeFalse
    }

    It 'finds node in a standard dir even when PATH does not have it (launchd / SYSTEM task)' {
        # The exact failure on the central Mac: node is at /usr/local/bin but launchd's PATH is
        # /usr/bin:/bin:/usr/sbin:/sbin, so Get-Command finds nothing and the sidecar was skipped.
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { $null } -ParameterFilter { $Name -eq 'node' }
        Mock Test-Path -ModuleName Coretelligent.Browser -MockWith { $true } -ParameterFilter { $LiteralPath -like '*node*' }
        Resolve-CtgNodeTool 'node' | Should -Not -BeNullOrEmpty
    }

    It 'returns $false when @playwright/test is a HOLLOW directory (missing package.json) even if Chromium is present' {
        # The exact fleet-wide outage (2026-07-15): an interrupted npm install left node_modules/
        # @playwright/test as an EMPTY dir. A bare @playwright directory-exists check passed, the agent
        # advertised 'browser', and every flow then crashed at `import "@playwright/test"`. The gate must
        # key off the package's own package.json, not the directory.
        Mock Resolve-CtgNodeTool -ModuleName Coretelligent.Browser -MockWith { '/usr/local/bin/node' } -ParameterFilter { $Name -eq 'node' }
        Mock Test-CtgChromiumInstalled -ModuleName Coretelligent.Browser -MockWith { $true }
        Mock Test-Path -ModuleName Coretelligent.Browser -MockWith { $false } -ParameterFilter { $LiteralPath -like '*@playwright*' }
        Test-CtgBrowserAvailable | Should -BeFalse
    }

    It 'returns $true when node, a real @playwright/test package.json, and Chromium are all present' {
        Mock Resolve-CtgNodeTool -ModuleName Coretelligent.Browser -MockWith { '/usr/local/bin/node' } -ParameterFilter { $Name -eq 'node' }
        Mock Test-CtgChromiumInstalled -ModuleName Coretelligent.Browser -MockWith { $true }
        Mock Test-Path -ModuleName Coretelligent.Browser -MockWith { $true } -ParameterFilter { $LiteralPath -like '*@playwright*test*package.json' }
        Test-CtgBrowserAvailable | Should -BeTrue
    }
}

Describe 'Install-CtgBrowser' {
    It 'returns $false (and never throws) when node is genuinely absent — nothing to install against' {
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { $null } -ParameterFilter { $Name -eq 'node' }
        Mock Test-Path -ModuleName Coretelligent.Browser -MockWith { $false }
        Install-CtgBrowser | Should -BeFalse
    }
    It 'returns $false when npm is genuinely absent' {
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { [pscustomobject]@{ Source = '/usr/bin/node' } } -ParameterFilter { $Name -eq 'node' }
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { $null } -ParameterFilter { $Name -eq 'npm' }
        # npm must be absent from the standard dirs too, or the resolver would find the real one.
        Mock Test-Path -ModuleName Coretelligent.Browser -MockWith { $false } -ParameterFilter { $LiteralPath -like '*npm*' }
        Install-CtgBrowser | Should -BeFalse
    }
    It 'returns $false when the sidecar directory is missing (never runs an installer)' {
        Mock Get-Command -ModuleName Coretelligent.Browser -MockWith { [pscustomobject]@{ Source = 'x' } } -ParameterFilter { $Name -in @('node','npm') }
        Mock Get-CtgBrowserRoot -ModuleName Coretelligent.Browser -MockWith { Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-nope-" + [guid]::NewGuid()) }
        Mock Invoke-CtgNodeTool -ModuleName Coretelligent.Browser -MockWith { throw 'should not install' }
        Install-CtgBrowser | Should -BeFalse
        Should -Invoke Invoke-CtgNodeTool -ModuleName Coretelligent.Browser -Times 0
    }
}

Describe 'Invoke-CtgBrowserFlow' {
    It 'returns a graceful ok=$false (never throws) when the sidecar is unavailable' {
        Mock Test-CtgBrowserAvailable -ModuleName Coretelligent.Browser -MockWith { $false }
        $r = Invoke-CtgBrowserFlow -Flow 'spanning-force-sync' -InputObject @{ username = 'u'; password = 'p'; params = @{ email = 'a@b.com' } }
        $r.ok | Should -BeFalse
        $r.error | Should -Match 'unavailable'
    }
}

Describe 'ConvertFrom-CtgStageLine' {
    It 'extracts the stage name from a sidecar "@@stage:" marker line' {
        ConvertFrom-CtgStageLine '[browser] @@stage:signin' | Should -Be 'signin'
        ConvertFrom-CtgStageLine '[browser] @@stage:create' | Should -Be 'create'
        ConvertFrom-CtgStageLine '[browser] @@stage:harvest' | Should -Be 'harvest'
    }
    It 'returns $null for an ordinary log line (not a stage marker)' {
        ConvertFrom-CtgStageLine '[browser] entering the Mimecast admin email' | Should -BeNullOrEmpty
        ConvertFrom-CtgStageLine '' | Should -BeNullOrEmpty
    }
    It 'ignores surrounding text and stops at the first non-name character' {
        ConvertFrom-CtgStageLine 'noise @@stage:vault more noise' | Should -Be 'vault'
    }
}

Describe 'Invoke-CtgBrowserFlow -OnStage forwarding' {
    It 'invokes the OnStage hook for each stage marker the sidecar emits, in order' {
        # Drive a fake sidecar: a tiny node script that prints the two stderr stage markers with a beat
        # between them, then the single JSON result line on stdout. Proves the live line-by-line drain
        # forwards markers via OnStage — not just at exit. Markers are spaced comfortably past the 200ms
        # drain interval so each is dequeued in its own iteration, matching real runs where stages are
        # seconds apart (the app keeps the LAST-posted stage, so arrival order must follow emission).
        # Skipped when node isn't available.
        $node = $null
        try { $node = Resolve-CtgNodeTool 'node' } catch { }
        if (-not $node) { Set-ItResult -Skipped -Because 'node is not available on this host'; return }

        $fake = Join-Path ([System.IO.Path]::GetTempPath()) ("ctg-fake-sidecar-" + [guid]::NewGuid() + ".mjs")
        @'
process.stdin.on('data', () => {});
process.stderr.write('[browser] @@stage:signin\n');
setTimeout(() => { process.stderr.write('[browser] @@stage:create\n'); }, 700);
setTimeout(() => {
  process.stdout.write(JSON.stringify({ ok: true, message: 'done' }) + '\n');
  process.exit(0);
}, 1200);
'@ | Set-Content -LiteralPath $fake -Encoding utf8

        # Point the flow runner at the fake script instead of run-flow.mjs.
        Mock Test-CtgBrowserAvailable -ModuleName Coretelligent.Browser -MockWith { $true }
        Mock Get-CtgBrowserRoot -ModuleName Coretelligent.Browser -MockWith { Split-Path -Parent $fake }
        Mock Join-Path -ModuleName Coretelligent.Browser -MockWith { $fake } -ParameterFilter { $ChildPath -eq 'run-flow.mjs' }

        $seen = [System.Collections.Generic.List[string]]::new()
        $r = Invoke-CtgBrowserFlow -Flow 'x' -InputObject @{} -TimeoutSeconds 20 -OnStage { param($s) $seen.Add($s) }

        $r.ok | Should -BeTrue
        $seen | Should -Be @('signin', 'create')

        Remove-Item -LiteralPath $fake -ErrorAction SilentlyContinue
    }
}

Describe 'Invoke-CtgSpanningForceSync' {
    BeforeAll {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@medipost.com' }
        $cfg  = [pscustomobject]@{}
        $secret = [pscustomobject]@{ Fields = @{ Username = 'admin@medipost.com'; Password = 'secret' } }
    }

    It 'maps a successful sync to an ok result with a triggered action line' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $true; message = 'triggered a Spanning directory sync'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'triggered a Spanning directory sync'
        $r.PSObject.Properties['RetryAfterMinutes'] | Should -BeNullOrEmpty
    }

    It 'passes RetryAfterMinutes through when the portal reports the sync is async/queued' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $true; message = 'clicked the sync control'; error = $null; evidence = $null; retryAfterMinutes = 10 }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        $r.Status | Should -Be 'ok'
        $r.RetryAfterMinutes | Should -Be 10
    }

    It 'maps a flow failure to a WARN action (not a throw)' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $false; message = $null; error = 'portal requires MFA — browser automation can''t complete'; evidence = '/tmp/shot.png'; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        $r.Status | Should -Be 'ok'  # ad-hoc convenience action never hard-fails the case
        ($r.Actions -join ' ') | Should -Match 'WARN'
        ($r.Actions -join ' ') | Should -Match 'MFA'
    }

    It 'builds the portal login from the brokered secret fields (Username/Password synonyms)' {
        $captured = $null
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            $script:capturedInput = $InputObject
            [pscustomobject]@{ ok = $true; message = 'ok'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 1 -ParameterFilter {
            $Flow -eq 'spanning-force-sync' -and $InputObject.username -eq 'admin@medipost.com' -and $InputObject.password -eq 'secret' -and $InputObject.params.email -eq 'jdoe@medipost.com'
        }
    }

    It 'WARNs (no browser call) when no portal credentials are brokered' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith { throw 'should not be called' }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret ([pscustomobject]@{ Fields = @{} })
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'WARN'
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 0
    }

    It 'passes a TOTP seed through to the flow when the secret carries one' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $true; message = 'ok'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $withSeed = [pscustomobject]@{ Fields = @{ Username = 'admin@medipost.com'; Password = 'secret'; TOTPSeed = 'GEZDGNBVGY3TQOJQ' } }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $withSeed
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 1 -ParameterFilter {
            $InputObject.params.totpSeed -eq 'GEZDGNBVGY3TQOJQ'
        }
    }

    It 'omits totpSeed from the flow input when the secret has no seed' {
        Mock Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -MockWith {
            [pscustomobject]@{ ok = $true; message = 'ok'; error = $null; evidence = $null; retryAfterMinutes = $null }
        }
        $r = Invoke-CtgSpanningForceSync -User $user -Config $cfg -Secret $secret
        Should -Invoke Invoke-CtgBrowserFlow -ModuleName Coretelligent.Spanning -Times 1 -ParameterFilter {
            -not $InputObject.params.ContainsKey('totpSeed')
        }
    }
}
