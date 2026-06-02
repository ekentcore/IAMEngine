#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Mimecast. We mock the single HTTP seam (Invoke-CtgMimecastApi)
# so no live Mimecast tenant is needed. API shape per the Mimecast 2.0 cloud-gateway docs:
#   POST /directory/cloud-gateway/v1/integrations/sync-requests   (trigger directory sync)
#   GET  /domain/cloud-gateway/v1/internal-domains                (verify the client's domain)

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Mimecast/Coretelligent.Mimecast.psm1" -Force
}

Describe 'Invoke-CtgMimecastOnboarding' {
    BeforeEach {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Method, $Path, $Body)
            if ($Path -like '*internal-domains*') {
                return [pscustomobject]@{ data = @([pscustomobject]@{ domain = '61commodities.com'; status = 'verified' }) }
            }
            return [pscustomobject]@{ data = @() }
        }
    }

    It 'triggers a directory sync when syncAll is set' {
        $config = [pscustomobject]@{ syncAll = $true; verifyInternalDirectory = '@61commodities.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Method -eq 'POST' -and $Path -match 'sync-requests' } -Times 1
    }

    It 'verifies the client domain is an internal verified domain' {
        $config = [pscustomobject]@{ syncAll = $true; verifyInternalDirectory = '@61commodities.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config $config
        ($r.Actions -join ' ') | Should -Match 'internal domain verified: 61commodities.com'
    }

    It 'flags partial status when the domain is not an internal domain' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            [pscustomobject]@{ data = @([pscustomobject]@{ domain = 'someoneelse.com'; status = 'verified' }) }
        }
        $config = [pscustomobject]@{ verifyInternalDirectory = '@61commodities.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config $config
        $r.Status | Should -Be 'partial'
        ($r.Actions -join ' ') | Should -Match 'not found'
    }
}

Describe 'Connect-CtgMimecast' {
    It 'requests an OAuth2 client-credentials token and stores it' {
        Mock Invoke-RestMethod -ModuleName Coretelligent.Mimecast -MockWith { [pscustomobject]@{ access_token = 'tok-123' } }
        $cred = [pscredential]::new('client-id', (ConvertTo-SecureString 'secret' -AsPlainText -Force))
        Connect-CtgMimecast -Credential $cred -BaseUrl 'https://api.services.mimecast.com'
        Should -Invoke Invoke-RestMethod -ModuleName Coretelligent.Mimecast -ParameterFilter { $Uri -match '/oauth/token' } -Times 1
    }
}

Describe 'Confirm-CtgMimecast' {
    It 'onboard: verifies the internal domain is registered' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Method, $Path, $Body)
            if ($Path -like '*internal-domains*') { return [pscustomobject]@{ data = @([pscustomobject]@{ domain = '61commodities.com'; status = 'verified' }) } }
            return [pscustomobject]@{ data = @() }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgMimecast -User $user -Config ([pscustomobject]@{ verifyInternalDirectory = '@61commodities.com' }) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when the user is absent from each configured group' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Method, $Path, $Body)
            return [pscustomobject]@{ data = @([pscustomobject]@{ emailAddress = 'someone-else@61commodities.com' }) }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgMimecast -User $user -Config ([pscustomobject]@{ groups = @('grp-1') }) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: fails when the user is still a group member' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Method, $Path, $Body)
            return [pscustomobject]@{ data = @([pscustomobject]@{ emailAddress = 'jdoe@61commodities.com' }) }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@61commodities.com' }
        $r = Confirm-CtgMimecast -User $user -Config ([pscustomobject]@{ groups = @('grp-1') }) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}
