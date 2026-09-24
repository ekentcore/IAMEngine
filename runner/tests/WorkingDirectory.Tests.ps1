# FR #0000171: "Running the Start IAM Runner powershell script gives me this error: New-Item: Access to
# the path 'C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\Scripts' is
# denied. I edited the script to move the current directory to another, writable place, and it worked."
#
# A Store-installed pwsh starts with both its PowerShell location AND its process working directory at
# $PSHOME, which is read-only even to an administrator. A relative path written from there fails.
#
# The relative path is not ours: every write in this repo is anchored ($PSScriptRoot, $InstallDir,
# [System.IO.Path]::GetTempPath()), and starting the real runner from $PSHOME on a Store pwsh 7.6.6 does
# not reproduce it. It comes from a dependency called during the startup module installs, whose
# per-scope path computation degrades to a relative path on hosts where the account has no resolvable
# MyDocuments/HOME — which is what a SYSTEM scheduled task is. We cannot anchor a path inside another
# module, so the runner pins its own working directory instead, which is the reporter's own fix.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so these assert against
# the script text, the same way ExoPin.Tests.ps1 and PnPInstall.Tests.ps1 do.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw
}

Describe 'the runner pins its working directory (FR #0000171)' {
    It 'sets the PowerShell location to its own folder' {
        $script:Runner | Should -Match 'Set-Location -LiteralPath \$PSScriptRoot'
    }

    It 'ALSO sets the .NET process working directory' {
        # These are independent. Set-Location moves the provider location that New-Item/Test-Path use;
        # [System.IO.File] and Directory.CreateDirectory resolve against [Environment]::CurrentDirectory,
        # which Set-Location does not touch. Verified directly: with Set-Location $PSHOME the process
        # CWD stayed put and [System.IO.Path]::GetFullPath('Scripts') still resolved against the old one.
        $script:Runner | Should -Match '\[Environment\]::CurrentDirectory = \$PSScriptRoot'
    }

    It 'anchors BEFORE the first module install can run' {
        # The failure happens during the startup installs, so pinning afterwards would be too late.
        $anchor = $script:Runner.IndexOf('[Environment]::CurrentDirectory = $PSScriptRoot')
        $gallery = $script:Runner.IndexOf('function Initialize-CtgGallery')
        $exoPin = $script:Runner.IndexOf('Install-CtgExoPin -Version $ExoModuleVersion')
        $anchor | Should -BeGreaterThan -1
        $gallery | Should -BeGreaterThan $anchor
        $exoPin | Should -BeGreaterThan $anchor
    }

    It 'does not run before the -HealthCheck probe returns' {
        # The liveness probe must stay fast and must not have side effects on the process it probes.
        $anchor = $script:Runner.IndexOf('[Environment]::CurrentDirectory = $PSScriptRoot')
        $probeExit = $script:Runner.IndexOf('Write-Host "runner healthy: $($h.reason)"')
        $probeExit | Should -BeGreaterThan -1
        $anchor | Should -BeGreaterThan $probeExit
    }

    It 'is best-effort — a runner that cannot chdir still starts' {
        # Anchoring is a hardening step, not a prerequisite. Throwing here would take the whole runner
        # down on a host where the old behaviour merely risked one relative write.
        $block = [regex]::Match($script:Runner, '(?ms)if \(\$PSScriptRoot\) \{.*?\n\}').Value
        $block | Should -Not -BeNullOrEmpty
        $block | Should -Match 'try \{'
        $block | Should -Match 'catch \{'
    }

    It 'guards against an empty $PSScriptRoot' {
        # Dot-sourced rather than run, $PSScriptRoot is empty and Set-Location would throw on it.
        $script:Runner | Should -Match 'if \(\$PSScriptRoot\) \{'
    }
}
