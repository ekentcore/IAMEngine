# Drive ownership transfer on offboard. It used to POST /dataTransfer on the Directory API, which isn't
# an endpoint: the 404 was swallowed and the step still said "transferred", so no Drive was moved. The
# real call is the Data Transfer API, on its own scope, with Google user ids and the Drive app's id.
BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1" -Force
    Connect-CtgGoogle -AccessToken 'ya29.test-token'
    $script:Leaver = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }
    $script:Cfg = [pscustomobject]@{ transferTarget = 'boss@brightonpark.com'; signOut = $false }
    function script:MockDirectory {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body, $BaseUrl, $Token)
            if ($Method -eq 'GET' -and $Path -eq '/users/jdoe@brightonpark.com') { return [pscustomobject]@{ id = '1001'; primaryEmail = 'jdoe@brightonpark.com' } }
            if ($Method -eq 'GET' -and $Path -eq '/users/boss@brightonpark.com') { return [pscustomobject]@{ id = '2002'; primaryEmail = 'boss@brightonpark.com' } }
            if ($Method -eq 'GET' -and $Path -eq '/applications') { return [pscustomobject]@{ applications = @([pscustomobject]@{ id = '435070579839'; name = 'Calendar' }, [pscustomobject]@{ id = '55656082996'; name = 'Drive and Docs' }) } }
            if ($Method -eq 'POST' -and $Path -eq '/transfers') { return [pscustomobject]@{ id = 'tr-1'; overallTransferStatusCode = 'new' } }
            return $null
        }
    }
}
AfterAll { Remove-Module Coretelligent.GoogleWorkspace -Force -ErrorAction SilentlyContinue }

Describe 'Drive ownership transfer on offboard' {
    # PR #110's per-runner memory of posted transfers would otherwise carry between tests.
    BeforeEach { InModuleScope Coretelligent.GoogleWorkspace { $script:GoogleTransfersPosted = @{} } }
    It 'requests the transfer from the Data Transfer API with user ids and the Drive app id, on its own token' {
        MockDirectory
        Mock Get-CtgGoogleScopedToken -ModuleName Coretelligent.GoogleWorkspace { 'dt-token' }
        $r = Invoke-CtgGoogleOffboarding -User $script:Leaver -Config $script:Cfg
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'POST' -and $Path -eq '/transfers' -and $BaseUrl -eq 'https://admin.googleapis.com/admin/datatransfer/v1' -and $Token -eq 'dt-token' -and
            $Body.oldOwnerUserId -eq '1001' -and $Body.newOwnerUserId -eq '2002' -and $Body.applicationDataTransfers[0].applicationId -eq '55656082996'
        }
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Path -eq '/dataTransfer' }
        Should -Invoke Get-CtgGoogleScopedToken -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Scope -eq 'https://www.googleapis.com/auth/admin.datatransfer' }
        ($r.Actions -join ' ') | Should -Match 'requested Drive ownership transfer to: boss@brightonpark\.com .*status: new'
        ($r.Actions -join ' ') | Should -Not -Match 'transferred Drive ownership'
    }
    It 'warns (never claims success) when the domain has not delegated the data-transfer scope, and still finishes the offboard' {
        MockDirectory
        Mock Get-CtgGoogleScopedToken -ModuleName Coretelligent.GoogleWorkspace { throw 'Google refused a token for https://www.googleapis.com/auth/admin.datatransfer' }
        $r = Invoke-CtgGoogleOffboarding -User $script:Leaver -Config $script:Cfg
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'WARN Drive ownership was NOT transferred to boss@brightonpark\.com .*admin\.datatransfer.*by hand'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' -and $Path -in '/transfers', '/dataTransfer' }
    }
    It 'warns when the transfer target does not exist' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path)
            if ($Method -eq 'GET' -and $Path -eq '/users/jdoe@brightonpark.com') { return [pscustomobject]@{ id = '1001'; primaryEmail = 'jdoe@brightonpark.com' } }
            return $null
        }
        Mock Get-CtgGoogleScopedToken -ModuleName Coretelligent.GoogleWorkspace { 'dt-token' }
        $r = Invoke-CtgGoogleOffboarding -User $script:Leaver -Config $script:Cfg
        ($r.Actions -join ' ') | Should -Match 'NOT transferred.*boss@brightonpark\.com was not found'
    }
}

Describe 'Get-CtgGoogleScopedToken' {
    It 'refuses on a session opened with a ready-made token (nothing to sign with)' {
        Connect-CtgGoogle -AccessToken 'ya29.test-token'
        { InModuleScope Coretelligent.GoogleWorkspace { Get-CtgGoogleScopedToken -Scope 'https://www.googleapis.com/auth/admin.datatransfer' } } | Should -Throw '*ready-made token*'
    }
    It 'mints a token for ONLY that scope with the connect''s signer, and caches it' {
        InModuleScope Coretelligent.GoogleWorkspace {
            $script:GoogleMint = @{ ClientEmail = 'sa@x.iam.gserviceaccount.com'; Impersonate = 'admin@x.com'; PrivateKey = 'pem' }
            $script:GoogleScopedTokens = @{}
            Mock New-CtgGoogleServiceToken { 'scoped-token' }
            $a = Get-CtgGoogleScopedToken -Scope 'https://www.googleapis.com/auth/admin.datatransfer'
            $b = Get-CtgGoogleScopedToken -Scope 'https://www.googleapis.com/auth/admin.datatransfer'
            $a | Should -Be 'scoped-token'; $b | Should -Be 'scoped-token'
            Should -Invoke New-CtgGoogleServiceToken -Times 1 -Exactly -ParameterFilter { @($scopeList).Count -eq 1 -and $scopeList[0] -eq 'https://www.googleapis.com/auth/admin.datatransfer' -and $Impersonate -eq 'admin@x.com' }
        }
    }
}
