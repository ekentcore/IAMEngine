#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Mimecast. We mock the single HTTP seam (Invoke-CtgMimecastApi)
# so no live tenant is needed. Endpoints are the classic set served by API 2.0 with Bearer auth:
#   POST /api/directory/get-connection / execute-sync
#   POST /api/user/get-profile (fail[] = user unknown) / create-user
#   POST /api/directory/find-groups / remove-group-member / get-group-members
# The seam returns the response's data ARRAY (or the raw envelope with -AllowFail).

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Mimecast/Coretelligent.Mimecast.psm1" -Force
}

Describe 'Invoke-CtgMimecastOnboarding' {
    It 'verifies a sync connection exists, triggers a sync, and sees the user' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            switch -Wildcard ($Path) {
                '*get-connection*' { return @([pscustomobject]@{ name = 'AzureAD sync' }) }
                '*get-profile*'    { return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) } }
                default            { return @() }
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/directory/execute-sync' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'Mimecast user present'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/user/create-user' } -Times 0 -Exactly
    }

    It 'creates a cloud user when missing and createIfMissing is set' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            switch -Wildcard ($Path) {
                '*get-connection*' { return @() }
                '*get-profile*'    { return [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_user_not_found'; message = 'unknown user' }) }); data = @() } }
                default            { return @() }
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'new@drakestar.com'; DisplayName = 'New Hire' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config ([pscustomobject]@{ createIfMissing = $true }) -InitialPassword 'Xx!long-password-1'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/user/create-user' -and $Data.emailAddress -eq 'new@drakestar.com' -and $Data.forcePasswordChange -eq $true } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Mimecast cloud user'
    }

    It 'notes (not creates) when the user is missing and createIfMissing is off' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            switch -Wildcard ($Path) {
                '*get-connection*' { return @([pscustomobject]@{ name = 'AD sync' }) }
                '*get-profile*'    { return [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_xx'; message = 'unknown user address' }) }); data = @() } }
                default            { return @() }
            }
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'new@drakestar.com' }
        $r = Invoke-CtgMimecastOnboarding -User $user -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/user/create-user' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'not visible yet'
    }

    It 'warns when no sync connection exists and createIfMissing is off' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            if ($Path -like '*get-profile*') { return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) } }
            return @()
        }
        $r = Invoke-CtgMimecastOnboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{})
        ($r.Actions -join ' ') | Should -Match 'WARN no directory-sync connection'
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/directory/execute-sync' } -Times 0 -Exactly
    }
}

Describe 'Invoke-CtgMimecastOffboarding' {
    It 'resolves group names and removes the user' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            if ($Path -like '*find-groups*') { return @([pscustomobject]@{ id = 'AAAAAAAAAAAAAAAAAAAAAAAAAA'; description = 'All Staff' }) }
            return @()
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }
        $r = Invoke-CtgMimecastOffboarding -User $user -Config ([pscustomobject]@{ groups = @('All Staff') })
        Should -Invoke Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -ParameterFilter { $Path -eq '/api/directory/remove-group-member' -and $Data.emailAddress -eq 'jdoe@drakestar.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'removed from Mimecast group'
    }

    It 'no-ops cleanly with no configured groups' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith { @() }
        $r = Invoke-CtgMimecastOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'no Mimecast group removals configured'
    }
}

Describe 'Confirm-CtgMimecast' {
    It 'onboard: passes when the user profile is visible' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) }
        }
        $r = Confirm-CtgMimecast -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'onboard: fails when the user is not visible yet' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            return [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_xx'; message = 'unknown user address' }) }); data = @() }
        }
        $r = Confirm-CtgMimecast -User ([pscustomobject]@{ UserPrincipalName = 'new@drakestar.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeFalse
    }

    It 'offboard: passes when the user is absent from the configured groups' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, [switch]$AllowFail)
            if ($Path -like '*find-groups*') { return @([pscustomobject]@{ id = 'BBBBBBBBBBBBBBBBBBBBBBBBBB'; description = 'All Staff' }) }
            return @()   # get-group-members: empty
        }
        $r = Confirm-CtgMimecast -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@drakestar.com' }) -Config ([pscustomobject]@{ groups = @('All Staff') }) -Action 'offboard'
        $r.ok | Should -BeTrue
    }
}

Describe 'Invoke-CtgMimecastApi (body serialization)' {
    It 'serializes an empty data payload as [] — never null (err_deserialise guard)' {
        InModuleScope Coretelligent.Mimecast {
            $script:MimecastToken = 't'
            Mock Invoke-RestMethod { param($Method, $Uri, $Headers, $ContentType, $Body) [pscustomobject]@{ fail = @(); data = @() } }
            Invoke-CtgMimecastApi -Path '/api/directory/get-connection' | Out-Null
            Should -Invoke Invoke-RestMethod -ParameterFilter { $Body -match '"data":\s*\[\s*\]' -and $Body -notmatch 'null' } -Times 1
        }
    }
}

Describe 'Get-CtgMimecastProfile (fail classification)' {
    It 'treats a user-not-found fail as a lookup miss (null)' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_xx'; message = 'unknown user' }) }); data = @() }
        }
        Get-CtgMimecastProfile -Email 'x@y.com' | Should -BeNullOrEmpty
    }

    It 'throws on a non-not-found fail instead of pretending the user is missing' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_deserialise'; message = 'payload contains null objects' }) }); data = @() }
        }
        { Get-CtgMimecastProfile -Email 'x@y.com' } | Should -Throw '*err_deserialise*'
    }

    It 'forbidden-for-address + a readable postmaster = not synced yet (null), not a permission error' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            param($Path, $Data, $AllowFail)
            $addr = if ($Data) { [string]$Data.emailAddress } else { '' }
            if ($addr -like 'postmaster@*') { return [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = $addr }) } }
            [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_xdk_operation_forbidden_for_address'; message = '0003 Forbidden To Perform Operation For Address' }) }); data = @() }
        }
        Get-CtgMimecastProfile -Email 'newhire@logicsource.com' | Should -BeNullOrEmpty
    }

    It 'forbidden-for-address where even postmaster is forbidden = a real permission gap (throws)' {
        Mock Invoke-CtgMimecastApi -ModuleName Coretelligent.Mimecast -MockWith {
            [pscustomobject]@{ fail = @([pscustomobject]@{ errors = @([pscustomobject]@{ code = 'err_xdk_operation_forbidden_for_address'; message = '0003 Forbidden To Perform Operation For Address' }) }); data = @() }
        }
        { Get-CtgMimecastProfile -Email 'x@y.com' } | Should -Throw '*not permitted to read*'
    }
}

Describe 'Invoke-CtgMimecastApi (transient retry)' {
    # These tests exercise the HTTP seam ITSELF (the other Describes mock it away), so they mock
    # Invoke-RestMethod. A real Mimecast 504 ("GatewayTimeout: Connection to service has timed out")
    # failed a whole onboard step, because only 401 was ever retried.
    BeforeEach {
        InModuleScope Coretelligent.Mimecast {
            $script:MimecastToken   = 'test-token'
            $script:MimecastBaseUrl = 'https://api.services.mimecast.com'
            $script:MimecastCredential = $null
        }
        Mock Start-Sleep -ModuleName Coretelligent.Mimecast -MockWith { }
        $global:McCalls = 0
    }
    AfterEach {
        Remove-Variable -Name McCalls -Scope Global -ErrorAction SilentlyContinue
        Remove-Variable -Name McStatus -Scope Global -ErrorAction SilentlyContinue
        Remove-Variable -Name McFailFor -Scope Global -ErrorAction SilentlyContinue
    }
    # The mock body runs in the MODULE's session state, so it can't see test-scope helpers/vars —
    # hence $global: for the call counter and the status to raise.

    It 'retries a 504 and succeeds once the gateway recovers' {
        $global:McStatus = 504
        $global:McFailFor = 2   # fail the first two attempts, then recover
        Mock Invoke-RestMethod -ModuleName Coretelligent.Mimecast -MockWith {
            $global:McCalls++
            if ($global:McCalls -le $global:McFailFor) {
                $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$global:McStatus)
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new("HTTP $($global:McStatus)", $r)
            }
            [pscustomobject]@{ fail = @(); data = @([pscustomobject]@{ emailAddress = 'jdoe@drakestar.com' }) }
        }
        $r = Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{ emailAddress = 'jdoe@drakestar.com' }
        $global:McCalls | Should -Be 3
        $r[0].emailAddress | Should -Be 'jdoe@drakestar.com'
    }

    It 'retries a throttled 429 too' {
        $global:McStatus = 429
        $global:McFailFor = 1
        Mock Invoke-RestMethod -ModuleName Coretelligent.Mimecast -MockWith {
            $global:McCalls++
            if ($global:McCalls -le $global:McFailFor) {
                $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$global:McStatus)
                throw [Microsoft.PowerShell.Commands.HttpResponseException]::new("HTTP $($global:McStatus)", $r)
            }
            [pscustomobject]@{ fail = @(); data = @() }
        }
        { Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{} } | Should -Not -Throw
        $global:McCalls | Should -Be 2
    }

    It 'gives up after 4 attempts and reports the status (a gateway that never recovers still fails)' {
        $global:McStatus = 504
        Mock Invoke-RestMethod -ModuleName Coretelligent.Mimecast -MockWith {
            $global:McCalls++
            $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$global:McStatus)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new("HTTP $($global:McStatus)", $r)
        }
        { Invoke-CtgMimecastApi -Path '/api/user/get-profile' -Data @{} } | Should -Throw '*HTTP 504*'
        $global:McCalls | Should -Be 4
    }

    It 'does NOT retry a 500 — it can mean the request was processed and then blew up' {
        $global:McStatus = 500
        Mock Invoke-RestMethod -ModuleName Coretelligent.Mimecast -MockWith {
            $global:McCalls++
            $r = [System.Net.Http.HttpResponseMessage]::new([System.Net.HttpStatusCode]$global:McStatus)
            throw [Microsoft.PowerShell.Commands.HttpResponseException]::new("HTTP $($global:McStatus)", $r)
        }
        { Invoke-CtgMimecastApi -Path '/api/user/create-user' -Data @{} } | Should -Throw '*HTTP 500*'
        $global:McCalls | Should -Be 1
    }
}

Describe 'Resolve-CtgMimecastConsoleLogin' {
    # The console sign-in login-resolver — the ONE place that decides what may be typed into the
    # Mimecast Administration Console login. Field synonyms mirror field-requirements.ts 'mimecast-console'.
    It 'resolves Username + Password from the secret fields' {
        $secret = [pscustomobject]@{ Fields = @{ Username = 'admin@drakestar.com'; Password = 'p@ss' } }
        $r = Resolve-CtgMimecastConsoleLogin -Secret $secret
        $r.Ok | Should -BeTrue
        $r.Username | Should -Be 'admin@drakestar.com'
        $r.Password | Should -Be 'p@ss'
    }

    It 'accepts the AdminEmail / AdminPassword synonyms' {
        $secret = [pscustomobject]@{ Fields = @{ AdminEmail = 'it@drakestar.com'; AdminPassword = 'x' } }
        $r = Resolve-CtgMimecastConsoleLogin -Secret $secret
        $r.Ok | Should -BeTrue
        $r.Username | Should -Be 'it@drakestar.com'
    }

    It 'falls back to the secret Credential when no email/password fields are present' {
        $cred = [System.Management.Automation.PSCredential]::new('admin@drakestar.com', (ConvertTo-SecureString 'sekret' -AsPlainText -Force))
        $secret = [pscustomobject]@{ Fields = @{}; Credential = $cred }
        $r = Resolve-CtgMimecastConsoleLogin -Secret $secret
        $r.Ok | Should -BeTrue
        $r.Username | Should -Be 'admin@drakestar.com'
        $r.Password | Should -Be 'sekret'
    }

    It 'fails (Ok=$false) with an actionable reason when nothing is wired — and never echoes a value' {
        $r = Resolve-CtgMimecastConsoleLogin -Secret ([pscustomobject]@{ Fields = @{} })
        $r.Ok | Should -BeFalse
        $r.Username | Should -BeNullOrEmpty
        $r.Reason | Should -Match "no 'mimecast-console' secret is wired"
    }

    It 'rejects a non-email username (an API clientId is not a console sign-in) without echoing it' {
        $secret = [pscustomobject]@{ Fields = @{ Username = 'not-an-email-clientid'; Password = 'x' } }
        $r = Resolve-CtgMimecastConsoleLogin -Secret $secret
        $r.Ok | Should -BeFalse
        $r.Reason | Should -Match 'is not an email'
        $r.Reason | Should -Not -Match 'not-an-email-clientid'
    }
}
