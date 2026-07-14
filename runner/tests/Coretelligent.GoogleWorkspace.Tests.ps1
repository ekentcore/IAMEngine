#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.GoogleWorkspace. Mocks the HTTP seam (Invoke-CtgGoogleApi).
# Admin SDK Directory API: create POST /users; OU/suspend PUT /users/{email}; groups via
# /groups?userKey=. Offboard SUSPENDS (never deletes) and captures group evidence first.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1" -Force
    # The runner generates the password (New-CtgCompliantPassword, in Coretelligent.M365) and passes
    # it in via -InitialPassword, so the module is testable alone with a literal.
    $script:TestPassword = ConvertTo-SecureString 'P@ssw0rd-Test!' -AsPlainText -Force
}

Describe 'Invoke-CtgGoogleOnboarding' {
    BeforeEach { $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com'; FirstName = 'Jane'; LastName = 'Doe' } }

    It 'creates a user in the target OU when none exists' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return $null }   # user not found
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return $null }   # no groups
            return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' }
        }
        $r = Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/Active Users'; groups = @('staff@brightonpark.com') }) -InitialPassword $script:TestPassword
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 1
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/groups/staff@brightonpark.com/members' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'created Google user'
    }

    It 'is idempotent — skips create when the user already exists' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return [pscustomobject]@{ groups = @([pscustomobject]@{ email = 'staff@brightonpark.com' }) } }
            return $null
        }
        $r = Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/Active Users'; groups = @('staff@brightonpark.com') }) -InitialPassword $script:TestPassword
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'already in group'
    }

    It 'refuses to place a user in the Root OU' {
        { Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/' }) -InitialPassword $script:TestPassword } | Should -Throw
    }

    It 'adopts an existing account whose NAME matches (same person, re-run) without creating' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; name = @{ givenName = 'Jane'; familyName = 'Doe' } } }
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return $null }
            return $null
        }
        $r = Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/Active Users' }) -InitialPassword $script:TestPassword
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'same person'
    }

    It 'PAUSES for a decision when the username is taken by a different person and no fallback is free' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; name = @{ givenName = 'John'; familyName = 'Doe' } } }
            return $null
        }
        { Invoke-CtgGoogleOnboarding -User $user -Config ([pscustomobject]@{ ou = '/Active Users' }) -InitialPassword $script:TestPassword } |
            Should -Throw -ExpectedMessage '*DECISION_NEEDED:username_collision*'
    }

    It 'uses a FALLBACK username when the primary is taken by a different person' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            # primary taken by someone else; the fallback is free
            if ($Method -eq 'GET' -and $Path -eq '/users/jdoe@brightonpark.com')      { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; name = @{ givenName = 'John'; familyName = 'Doe' } } }
            if ($Method -eq 'GET' -and $Path -eq '/users/jane.doe@brightonpark.com')  { return $null }
            if ($Method -eq 'GET' -and $Path -like '/groups*') { return $null }
            return $null
        }
        $u = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com'; UserPrincipalNameFallbacks = @('jane.doe@brightonpark.com'); FirstName = 'Jane'; LastName = 'Doe' }
        $r = Invoke-CtgGoogleOnboarding -User $u -Config ([pscustomobject]@{ ou = '/Active Users' }) -InitialPassword $script:TestPassword
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users' -and $Body.primaryEmail -eq 'jane.doe@brightonpark.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'fallback username'
    }
}

Describe 'Invoke-CtgGoogleOffboarding' {
    It 'captures group evidence, suspends the user, and never deletes' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            if ($Method -eq 'GET' -and $Path -like '/groups*')  { return [pscustomobject]@{ groups = @([pscustomobject]@{ email = 'staff@brightonpark.com' }) } }
            return $null
        }
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }
        $r = Invoke-CtgGoogleOffboarding -User $user -Config ([pscustomobject]@{})
        $r.Evidence.Groups | Should -Contain 'staff@brightonpark.com'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'PUT' -and $Body.suspended -eq $true } -Times 1
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'DELETE' -and $Path -like '/users/*' } -Times 0 -Exactly
    }

    # Suspending blocks NEW sign-ins but does NOT invalidate tokens already issued — a phone with a
    # live Gmail token keeps syncing. signOut is what actually revokes sessions + refresh tokens.
    It 'signs the user out everywhere (revokes sessions + refresh tokens) after suspending' {
        Mock Get-CtgGoogleSessionScopes -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            @('https://www.googleapis.com/auth/admin.directory.user', 'https://www.googleapis.com/auth/admin.directory.user.security')
        }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            return $null
        }
        $r = Invoke-CtgGoogleOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{})
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Method -eq 'POST' -and $Path -eq '/users/jdoe@brightonpark.com/signOut' } -Times 1 -Exactly
        ($r.Actions -join ' ') | Should -Match 'signed out everywhere'
    }

    # Domain-wide delegation is all-or-nothing, so a domain that hasn't added the security scope is
    # connected WITHOUT it. Don't fire a call Google will reject — say exactly what's missing.
    It 'warns that tokens stay live when the domain has not authorized the security scope' {
        Mock Get-CtgGoogleSessionScopes -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            @('https://www.googleapis.com/auth/admin.directory.user', 'https://www.googleapis.com/auth/admin.directory.group')
        }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            return $null
        }
        $r = Invoke-CtgGoogleOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{})
        $r.Status | Should -Be 'ok'   # never fails the offboard
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Path -like '*/signOut' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'admin\.directory\.user\.security'
        ($r.Actions -join ' ') | Should -Match 'STILL VALID'
    }

    It 'does not sign the user out when signOut is false' {
        Mock Get-CtgGoogleSessionScopes -ModuleName Coretelligent.GoogleWorkspace -MockWith { @('https://www.googleapis.com/auth/admin.directory.user.security') }
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            return $null
        }
        Invoke-CtgGoogleOffboarding -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{ signOut = $false }) | Out-Null
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter { $Path -like '*/signOut' } -Times 0 -Exactly
    }
}

Describe 'Connect-CtgGoogle (service-account JWT)' {
    It 'signs an RS256 JWT with the service-account key and exchanges it for an access token' {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $pem = $rsa.ExportPkcs8PrivateKeyPem()   # stand-in for the JSON key's private_key
        $script:captured = $null
        Mock Invoke-RestMethod -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Uri, $ContentType, $Body)
            $script:captured = @{ Uri = $Uri; Body = $Body }
            [pscustomobject]@{ access_token = 'ya29.test-token'; expires_in = 3600 }
        }
        Connect-CtgGoogle -ClientEmail 'svc@proj.iam.gserviceaccount.com' -PrivateKey $pem -Impersonate 'admin@legalsifter.com'

        $script:captured.Uri | Should -Be 'https://oauth2.googleapis.com/token'
        $script:captured.Body.grant_type | Should -Be 'urn:ietf:params:oauth:grant-type:jwt-bearer'
        $parts = $script:captured.Body.assertion -split '\.'
        $parts.Count | Should -Be 3   # header.claims.signature
        $padFix = { param($x) $x.Replace('-', '+').Replace('_', '/').PadRight([math]::Ceiling($x.Length / 4) * 4, '=') }
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((& $padFix $parts[1]))) | ConvertFrom-Json
        $claims.iss   | Should -Be 'svc@proj.iam.gserviceaccount.com'
        $claims.sub   | Should -Be 'admin@legalsifter.com'   # impersonated admin (domain-wide delegation)
        $claims.aud   | Should -Be 'https://oauth2.googleapis.com/token'
        $claims.scope | Should -Match 'admin\.directory\.user'
    }

    # Domain-wide delegation is all-or-nothing: asking for a scope the domain hasn't authorized fails
    # the WHOLE exchange. We ask for the offboard security scope, but a domain that hasn't added it
    # must keep working exactly as before — so the mint retries with the legacy scope set.
    It 'asks for the session-revoke scope, and falls back to the legacy scopes when the domain refuses it' {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $pem = $rsa.ExportPkcs8PrivateKeyPem()
        $script:attempts = [System.Collections.Generic.List[string]]::new()
        Mock Invoke-RestMethod -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Uri, $ContentType, $Body)
            $padFix = { param($x) $x.Replace('-', '+').Replace('_', '/').PadRight([math]::Ceiling($x.Length / 4) * 4, '=') }
            $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((& $padFix (($Body.assertion -split '\.')[1])))) | ConvertFrom-Json
            $script:attempts.Add($claims.scope)
            if ($claims.scope -match 'user\.security') { throw 'unauthorized_client' }  # domain hasn't authorized it
            [pscustomobject]@{ access_token = 'ya29.legacy'; expires_in = 3600 }
        }
        Connect-CtgGoogle -ClientEmail 'svc@x' -PrivateKey $pem -Impersonate 'admin@x.com'

        $script:attempts.Count | Should -Be 2                       # tried WITH the scope, then without
        $script:attempts[0] | Should -Match 'user\.security'
        $script:attempts[1] | Should -Not -Match 'user\.security'
        (Get-CtgGoogleSessionScopes) | Should -Not -Contain 'https://www.googleapis.com/auth/admin.directory.user.security'
    }

    # REGRESSION: a catch-all here meant ANY transient failure (503, DNS, TLS) silently downgraded the
    # session to the legacy scopes. A domain that HAD authorized the security scope would then skip
    # the offboard's signOut and be told to add a scope it already has — while the leaver's tokens
    # stayed live. Only an authorization refusal may trigger the fallback.
    It 'does NOT downgrade the scopes on a transient token-endpoint failure — it surfaces the error' {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $pem = $rsa.ExportPkcs8PrivateKeyPem()
        $script:calls = 0
        Mock Invoke-RestMethod -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            $script:calls++
            throw 'The remote server returned an error: (503) Service Unavailable.'
        }
        { Connect-CtgGoogle -ClientEmail 'svc@x' -PrivateKey $pem -Impersonate 'admin@x.com' } | Should -Throw
        $script:calls | Should -Be 1   # no silent retry-without-the-scope
    }

    It 'throws when the token endpoint returns no access_token' {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $pem = $rsa.ExportPkcs8PrivateKeyPem()
        Mock Invoke-RestMethod -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ error = 'unauthorized_client' } }
        { Connect-CtgGoogle -ClientEmail 'svc@x' -PrivateKey $pem -Impersonate 'a@b.com' } | Should -Throw
    }
}

Describe 'Confirm-CtgGoogle' {
    It 'onboard: passes when present and not in Root OU' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; orgUnitPath = '/Active Users'; suspended = $false } }
        $r = Confirm-CtgGoogle -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{}) -Action 'onboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: passes when suspended and moved to the Inactive OU' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; orgUnitPath = '/Email & Calendar/Inactive'; suspended = $true } }
        $r = Confirm-CtgGoogle -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeTrue
    }

    It 'offboard: fails when the user is still active' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com'; orgUnitPath = '/Active Users'; suspended = $false } }
        $r = Confirm-CtgGoogle -User ([pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }) -Config ([pscustomobject]@{}) -Action 'offboard'
        $r.ok | Should -BeFalse
    }
}

Describe 'Invoke-CtgGooglePasswordReset' {
    # Ad-hoc "Generate random password": app-generated value arrives as config.newPassword; the
    # executor PUTs it with changePasswordAtNextLogin and never echoes it into the result.
    BeforeEach {
        $user = [pscustomobject]@{ UserPrincipalName = 'jdoe@brightonpark.com' }
        $config = [pscustomobject]@{ newPassword = 'Xy7#kQ9pLm2$Wn4v' }
    }

    It 'PUTs the new password with change-at-next-login' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith {
            param($Method, $Path, $Body)
            if ($Method -eq 'GET' -and $Path -like '/users/*') { return [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
            return $null
        }
        $r = Invoke-CtgGooglePasswordReset -User $user -Config $config
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'PUT' -and $Path -eq '/users/jdoe@brightonpark.com' -and $Body.password -eq 'Xy7#kQ9pLm2$Wn4v' -and $Body.changePasswordAtNextLogin -eq $true
        }
        ($r | ConvertTo-Json -Depth 6) | Should -Not -Match ([regex]::Escape('Xy7#kQ9pLm2$Wn4v'))
    }

    It 'throws when the user is not found — never silently no-ops' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { $null }
        { Invoke-CtgGooglePasswordReset -User $user -Config $config } | Should -Throw '*not found*'
    }

    It 'throws when the app did not inject newPassword' {
        Mock Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -MockWith { [pscustomobject]@{ primaryEmail = 'jdoe@brightonpark.com' } }
        { Invoke-CtgGooglePasswordReset -User $user -Config ([pscustomobject]@{}) } | Should -Throw '*newPassword*'
    }
}

Describe 'Connect-CtgGoogle session scopes' {
    It 'records the minted scopes (delegation proved them) and clears them for raw tokens' {
        Connect-CtgGoogle -AccessToken 'tok-direct'
        @(Get-CtgGoogleSessionScopes) | Should -HaveCount 0
    }
}
