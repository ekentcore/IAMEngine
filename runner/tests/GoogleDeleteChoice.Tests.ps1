# FR #0000128: a case can choose DELETE instead of suspend for the Google account. The executor deletes
# last (after evidence, group removal, OU move and sign-out) and HOLDS the delete when a Drive transfer
# was requested — Google runs the transfer in the background, and deleting the owner first loses files.
BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1" -Force -DisableNameChecking
    # The Data Transfer API's own token (PR #114) — the domain is taken to have delegated the scope.
    Mock Get-CtgGoogleScopedToken -ModuleName Coretelligent.GoogleWorkspace { 'dt-token' }
    $script:User = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }
    $script:Api = {
        param($Method, $Path, $Body)
        if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
        if ($Method -eq 'GET' -and $Path -like '/groups*') { return [pscustomobject]@{ groups = @() } }
        return $null
    }
}
AfterAll { Remove-Module Coretelligent.GoogleWorkspace -Force -ErrorAction SilentlyContinue }

Describe 'Invoke-CtgGoogleOffboarding — per-case delete' {
    It 'deletes the user when the case chose it, after suspending' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:Api
        $r = Invoke-CtgGoogleOffboarding -User $script:User -Config ([pscustomobject]@{ deleteUser = $true; signOut = $false })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/jdoe@brightonpark.com' }
        ($r.Actions -join "`n") | Should -Match 'deleted Google user'
    }
    It 'holds the delete when the transfer status cannot be read, and leaves a MANUAL checklist line' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:Api
        $r = Invoke-CtgGoogleOffboarding -User $script:User -Config ([pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com'; signOut = $false })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/jdoe@brightonpark.com' }
        ($r.Actions -join "`n") | Should -Match 'MANUAL: delete jdoe@brightonpark.com'
    }
    It 'never deletes by default' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:Api
        $null = Invoke-CtgGoogleOffboarding -User $script:User -Config ([pscustomobject]@{ signOut = $false })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/jdoe@brightonpark.com' }
    }
}

# Review N1: a transfer the client asks for as standing config must not turn every approved delete into
# a silent "suspended" success, and a re-run must not post the transfer again.
Describe 'Invoke-CtgGoogleOffboarding — delete held for a Drive transfer' {
    BeforeAll {
        $script:Cfg = [pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com'; signOut = $false }
        $script:ApiWithTransfer = {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/transfers?*') { return [pscustomobject]@{ dataTransfers = @([pscustomobject]@{ overallTransferStatusCode = $script:TransferCode }) } }
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; id = '1234567890' } }
            if ($Method -eq 'GET' -and $Path -eq '/applications') { return [pscustomobject]@{ applications = @([pscustomobject]@{ id = '55656082996'; name = 'Drive and Docs' }) } }
            if ($Method -eq 'POST' -and $Path -eq '/transfers') { return [pscustomobject]@{ id = 'tr-1'; overallTransferStatusCode = 'new' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*') { return [pscustomobject]@{ groups = @() } }
            return $null
        }
    }
    It 'while the transfer runs: no second transfer, no delete, and an automatic re-check' {
        $script:TransferCode = 'inProgress'
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:ApiWithTransfer
        $r = Invoke-CtgGoogleOffboarding -User $script:User -Config $script:Cfg
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/transfers' }
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/jdoe@brightonpark.com' }
        $r.PSObject.Properties['RetryAfterMinutes'] | Should -Not -BeNullOrEmpty
        $r.RetryAfterMinutes | Should -BeGreaterThan 0
        ($r.Actions -join "`n") | Should -Match 'MANUAL: delete'
    }
    It 'once Google reports the transfer complete: deletes, without posting it again' {
        $script:TransferCode = 'completed'
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:ApiWithTransfer
        $r = Invoke-CtgGoogleOffboarding -User $script:User -Config $script:Cfg
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/transfers' }
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/jdoe@brightonpark.com' }
        ($r.Actions -join "`n") | Should -Not -Match 'MANUAL'
    }
    It 'a failed transfer holds the delete with no automatic re-check (a human has to fix it)' {
        $script:TransferCode = 'failed'
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:ApiWithTransfer
        $r = Invoke-CtgGoogleOffboarding -User $script:User -Config $script:Cfg
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'DELETE' -and $Path -eq '/users/jdoe@brightonpark.com' }
        $r.PSObject.Properties['RetryAfterMinutes'] | Should -BeNullOrEmpty
        ($r.Actions -join "`n") | Should -Match 'MANUAL: delete.*FAILED'
    }
}

Describe 'Confirm-CtgGoogle — per-case delete' {
    It 'passes a chosen delete when the account is gone' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace -MockWith { $null }
        $v = Confirm-CtgGoogle -User $script:User -Config ([pscustomobject]@{ deleteUser = $true }) -Action offboard
        $v.ok | Should -BeTrue
    }
    It 'fails a chosen delete while the account still exists' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; suspended = $true } }
        $v = Confirm-CtgGoogle -User $script:User -Config ([pscustomobject]@{ deleteUser = $true }) -Action offboard
        $v.ok | Should -BeFalse
    }
    It 'fails a chosen delete that was held for a Drive transfer while the account still exists' {
        Mock Get-CtgGoogleUser -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; suspended = $true; orgUnitPath = '/Email & Calendar/Inactive' } }
        $v = Confirm-CtgGoogle -User $script:User -Config ([pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com' }) -Action offboard
        $v.ok | Should -BeFalse
    }
}

# Review round 3: a held delete fails Confirm on purpose, and a failed Confirm makes the runner re-run the
# whole executor ($MaxRevalidate times) — which, with the transfer state unreadable, posted the Drive
# transfer on every pass. The loop is lifted from Start-IamRunner.ps1 (not dot-sourceable) and run for
# real against the Google executor + validator.
Describe 'Invoke-JobWithValidation — a held Google delete' {
    BeforeAll {
        $runner = Get-Content "$PSScriptRoot/../Start-IamRunner.ps1" -Raw
        $fn = [regex]::Match($runner, '(?ms)^function Invoke-JobWithValidation\s*\{.*?^\}')
        $fn.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Invoke-JobWithValidation'
        . ([scriptblock]::Create($fn.Value))
        $max = [regex]::Match($runner, '(?m)^\$MaxRevalidate\s*=\s*(\d+)')
        $max.Success | Should -BeTrue
        $script:MaxRevalidate = [int]$max.Groups[1].Value
        $script:Handler = @{ Validate = { param($job, $creds) Confirm-CtgGoogle -User $job.payload -Config $job.config -Action offboard } }
        $script:Fn = { param($job, $creds) Invoke-CtgGoogleOffboarding -User $job.payload -Config $job.config }
        $script:HeldApi = {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/transfers?*') { return $null }   # status unreadable
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; id = '1234567890'; suspended = $true; orgUnitPath = '/Email & Calendar/Inactive' } }
            if ($Method -eq 'GET' -and $Path -eq '/applications') { return [pscustomobject]@{ applications = @([pscustomobject]@{ id = '55656082996'; name = 'Drive and Docs' }) } }
            if ($Method -eq 'POST' -and $Path -eq '/transfers') { return [pscustomobject]@{ id = 'tr-1'; overallTransferStatusCode = 'new' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*') { return [pscustomobject]@{ groups = @() } }
            return $null
        }
    }
    BeforeEach { InModuleScope Coretelligent.GoogleWorkspace { $script:GoogleTransfersPosted = @{} } }
    It 'posts the Drive transfer once and does not re-run the executor for a held delete' {
        Mock Start-Sleep { }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:HeldApi
        $job = [pscustomobject]@{ payload = $script:User; config = [pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com'; signOut = $false } }
        $out = Invoke-JobWithValidation -Job $job -Handler $script:Handler -Fn $script:Fn -Creds $null -DryRun $false
        $out.Validation.ok | Should -BeFalse
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/transfers' }
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'PUT' -and $Body.suspended -eq $true }
    }
    It 'an operator re-run on the same runner does not post the transfer again while its status is unreadable' {
        Mock Start-Sleep { }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith $script:HeldApi
        $job = [pscustomobject]@{ payload = $script:User; config = [pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com'; signOut = $false } }
        $null = Invoke-JobWithValidation -Job $job -Handler $script:Handler -Fn $script:Fn -Creds $null -DryRun $false
        $second = Invoke-JobWithValidation -Job $job -Handler $script:Handler -Fn $script:Fn -Creds $null -DryRun $false
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/transfers' }
        ($second.Result.Actions -join "`n") | Should -Match 'already requested'
    }
    It 'a delete that DID run is revalidated through Google replication lag (not cut off as final)' {
        Mock Start-Sleep { }
        $script:Deleted = $false; $script:LagReads = 0
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'DELETE' -and $Path -like '/users/*') { $script:Deleted = $true; return $null }
            if ($Method -eq 'GET' -and $Path -like '/transfers?*') { return [pscustomobject]@{ dataTransfers = @([pscustomobject]@{ overallTransferStatusCode = 'completed' }) } }
            if ($Method -eq 'GET' -and $Path -like '/users/*') {
                # Google still returns the account for one read after the DELETE (replication lag).
                if ($script:Deleted) { $script:LagReads++; if ($script:LagReads -gt 1) { return $null } }
                return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; id = '1234567890'; suspended = $true }
            }
            if ($Method -eq 'GET' -and $Path -eq '/applications') { return [pscustomobject]@{ applications = @([pscustomobject]@{ id = '55656082996'; name = 'Drive and Docs' }) } }
            if ($Method -eq 'POST' -and $Path -eq '/transfers') { return [pscustomobject]@{ id = 'tr-1'; overallTransferStatusCode = 'new' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*') { return [pscustomobject]@{ groups = @() } }
            return $null
        }
        $job = [pscustomobject]@{ payload = $script:User; config = [pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com'; signOut = $false } }
        $out = Invoke-JobWithValidation -Job $job -Handler $script:Handler -Fn $script:Fn -Creds $null -DryRun $false
        $out.Validation.ok | Should -BeTrue
    }
    It 'a transfer Google reports FAILED says so, even when this runner posted it within the day' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/transfers?*') { return [pscustomobject]@{ dataTransfers = @([pscustomobject]@{ overallTransferStatusCode = 'failed' }) } }
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; id = '1234567890' } }
            if ($Method -eq 'GET' -and $Path -eq '/applications') { return [pscustomobject]@{ applications = @([pscustomobject]@{ id = '55656082996'; name = 'Drive and Docs' }) } }
            if ($Method -eq 'POST' -and $Path -eq '/transfers') { return [pscustomobject]@{ id = 'tr-1'; overallTransferStatusCode = 'new' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*') { return [pscustomobject]@{ groups = @() } }
            return $null
        }
        InModuleScope Coretelligent.GoogleWorkspace { $script:GoogleTransfersPosted['jdoe@brightonpark.com|boss@brightonpark.com'] = [datetime]::UtcNow.AddMinutes(-5) }
        $r = Invoke-CtgGoogleOffboarding -User $script:User -Config ([pscustomobject]@{ deleteUser = $true; transferTarget = 'boss@brightonpark.com'; signOut = $false })
        $text = $r.Actions -join "`n"
        $text | Should -Match 'WARN Drive transfer to boss@brightonpark.com FAILED'
        $text | Should -Not -Match 'already requested'
    }
    It 'still revalidates an ordinary miss (the loop is only cut short when re-running cannot help)' {
        Mock Start-Sleep { }
        $script:Runs = 0
        $fn = { param($job, $creds) $script:Runs++; [pscustomobject]@{ Status = 'ok' } }
        $h = @{ Validate = { param($job, $creds) [pscustomobject]@{ ok = $false; checks = @() } } }
        $null = Invoke-JobWithValidation -Job ([pscustomobject]@{}) -Handler $h -Fn $fn -Creds $null -DryRun $false
        $script:Runs | Should -Be (1 + $script:MaxRevalidate)
    }
}
