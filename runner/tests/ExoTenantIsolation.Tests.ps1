# EXO's -Organization must name the tenant THIS client's own credentials live in — never one
# inherited from whatever the fleet-shared, process-wide Graph session was last bound to.
#
# The bug these guard (UM0029840): Olympus Cosmetic's conn tests bound Graph to Olympus; twelve
# minutes later an Easterseals offboard's `exchange` step read Get-MgOrganization off that stale
# session, got olympuscosmetic.com, and sent Easterseals' own app id to Olympus's directory →
# AADSTS700016 "Application ... was not found in the directory 'Olympus Cosmetic'".
#
# The opposite failure (JAMS) must stay fixed at the same time: deriving the domain from the client's
# informational primaryDomain (newcoinc.com) resolved to a SEPARATE "Newco, Inc." tenant → the same
# AADSTS700016. So "stop trusting Graph" is not a fix — "trust only OUR OWN Graph session" is.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — as in the
# ConnectionCache tests — we lift the functions out via the AST and exercise them directly.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:RunnerPath = Join-Path $Root 'Start-IamRunner.ps1'
    $script:Runner = Get-Content $script:RunnerPath -Raw

    $errs = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($script:RunnerPath, [ref]$null, [ref]$errs)
    $errs | Should -BeNullOrEmpty
    $fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
    foreach ($name in 'Get-CtgM365AppId', 'Get-CtgM365TenantId', 'Test-CtgGraphBoundTo', 'Connect-CtgGraphForJob', 'Get-CtgTenantDomain', 'Get-CtgExoOrganization', 'Get-CtgConnectionSiblings', 'Clear-CtgConnectionSiblings', 'Disconnect-CtgAllCloud', 'Reset-CtgCloudSessionsOnClientChange') {
        $fn = $fns | Where-Object { $_.Name -eq $name } | Select-Object -First 1
        $fn | Should -Not -BeNullOrEmpty -Because "Start-IamRunner.ps1 must define $name"
        . ([scriptblock]::Create($fn.Extent.Text))
    }
    # The real group map + cache, so sibling invalidation is exercised for real rather than mocked.
    $gm = [regex]::Match($script:Runner, '(?ms)^\$script:ConnectionGroups\s*=\s*(@\{.*?^\})')
    $script:ConnectionGroups = & ([scriptblock]::Create($gm.Groups[1].Value))

    # Stubs for the Graph cmdlets the runner calls, so Pester can mock them here.
    function Get-MgContext { [CmdletBinding()] param() }
    function Get-MgOrganization { [CmdletBinding()] param() }
    function Connect-CtgM365 { [CmdletBinding()] param([pscredential]$Credential, [string]$TenantId) }
    function Disconnect-MgGraph { [CmdletBinding()] param() }
    function Disconnect-CtgExchange { [CmdletBinding()] param() }
    function Write-CtgLog { [CmdletBinding()] param([string]$Level, [string]$Message) }

    function New-TestCreds {
        param([string]$AppId = 'app-easterseals', [hashtable]$Fields = @{})
        @{ 'm365-admin' = [pscustomobject]@{
                Credential = [pscredential]::new($AppId, (ConvertTo-SecureString 'pw' -AsPlainText -Force))
                Fields     = $Fields
            }
        }
    }
    function New-TestJob {
        param([string]$Slug = 'core1453', [string]$PrimaryDomain = 'easterseals.com')
        [pscustomobject]@{ id = 'job-1'; client = [pscustomobject]@{ slug = $Slug; primaryDomain = $PrimaryDomain }; payload = $null }
    }
    function New-MgOrg {
        param([string]$Default)
        [pscustomobject]@{ VerifiedDomains = @([pscustomobject]@{ Name = $Default; IsDefault = $true }) }
    }
}

Describe 'Test-CtgGraphBoundTo' {
    It 'rejects a session bound to ANOTHER client (the UM0029840 leak)' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-olympus'; TenantId = 'tenant-olympus' } }
        Test-CtgGraphBoundTo -AppId 'app-easterseals' -TenantId 'tenant-easterseals' | Should -BeFalse
    }

    It 'rejects a matching app id in the WRONG tenant (one app shared by a parent and its children)' {
        # A child client inheriting its parent's m365-admin has the SAME app id, so ClientId alone
        # cannot prove the session is this client's — the tenant has to match too.
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-shared'; TenantId = '11111111-1111-1111-1111-111111111111' } }
        Test-CtgGraphBoundTo -AppId 'app-shared' -TenantId '22222222-2222-2222-2222-222222222222' | Should -BeFalse
    }

    It 'matches a GUID tenant case-insensitively' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-a'; TenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
        Test-CtgGraphBoundTo -AppId 'app-a' -TenantId 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE' | Should -BeTrue
    }

    It 'ignores a DOMAIN in the TenantId field rather than rejecting our own session forever' {
        # Get-MgContext always reports a GUID. If an operator typed a domain into TenantId, comparing
        # the two would never match — we'd disown our own session on every run and fall back to the
        # configured domains, which is the JAMS path. Fall back to the app id instead.
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-a'; TenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }
        Test-CtgGraphBoundTo -AppId 'app-a' -TenantId 'contoso.onmicrosoft.com' | Should -BeTrue
    }

    It 'accepts our own session' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-easterseals'; TenantId = 'tenant-easterseals' } }
        Test-CtgGraphBoundTo -AppId 'app-easterseals' -TenantId 'tenant-easterseals' | Should -BeTrue
    }

    It 'accepts on app id alone when the secret carries no authoritative TenantId' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-easterseals'; TenantId = 'tenant-easterseals' } }
        Test-CtgGraphBoundTo -AppId 'app-easterseals' -TenantId '' | Should -BeTrue
    }

    It 'is false when there is no Graph session at all' {
        Mock Get-MgContext { throw 'not connected' }
        Test-CtgGraphBoundTo -AppId 'app-easterseals' -TenantId 'tenant-easterseals' | Should -BeFalse
    }

    It 'is false when no app id is known' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-x'; TenantId = 'tenant-x' } }
        Test-CtgGraphBoundTo -AppId '' -TenantId '' | Should -BeFalse
    }
}

Describe 'Get-CtgExoOrganization' {
    It 'NEVER reads a Graph session belonging to another client (UM0029840)' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-olympus'; TenantId = 'tenant-olympus' } }
        Mock Get-MgOrganization { New-MgOrg -Default 'olympuscosmetic.com' }
        $creds = New-TestCreds -AppId 'app-easterseals' -Fields @{ TenantId = 'tenant-easterseals'; Domain = 'EasterSealsSouthFlorid.onmicrosoft.com' }

        $org = Get-CtgExoOrganization (New-TestJob) $creds

        $org | Should -Be 'EasterSealsSouthFlorid.onmicrosoft.com'
        $org | Should -Not -Be 'olympuscosmetic.com'
        Should -Not -Invoke Get-MgOrganization -Because 'a foreign session must never even be read'
    }

    It 'prefers OUR tenant''s default verified domain over the informational primaryDomain (JAMS stays fixed)' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-jams'; TenantId = 'tenant-jams' } }
        Mock Get-MgOrganization { New-MgOrg -Default 'jams.onmicrosoft.com' }
        $creds = New-TestCreds -AppId 'app-jams' -Fields @{ TenantId = 'tenant-jams' }

        # primaryDomain newcoinc.com resolves to a DIFFERENT directory — it must lose to Graph.
        Get-CtgExoOrganization (New-TestJob -Slug 'core-jams' -PrimaryDomain 'newcoinc.com') $creds |
            Should -Be 'jams.onmicrosoft.com'
    }

    It 'falls back to the operator-set secret Domain BEFORE primaryDomain when Graph is unavailable' {
        # Since the offboard reorder, `exchange` runs first, so a client whose m365-admin cannot drive
        # Graph reaches the fallback chain on every run. primaryDomain is the SN website domain and is
        # exactly what mis-resolved for JAMS, so an explicitly typed Domain field has to outrank it.
        Mock Get-MgContext { throw 'not connected' }
        Mock Get-MgOrganization { New-MgOrg -Default 'should-never-be-read.com' }
        $creds = New-TestCreds -AppId 'app-jams' -Fields @{ Domain = 'jams.onmicrosoft.com' }

        Get-CtgExoOrganization (New-TestJob -Slug 'core-jams' -PrimaryDomain 'newcoinc.com') $creds |
            Should -Be 'jams.onmicrosoft.com'
    }

    It 'still falls back to primaryDomain when the secret names no domain' {
        Mock Get-MgContext { throw 'not connected' }
        Get-CtgExoOrganization (New-TestJob) (New-TestCreds -Fields @{ TenantId = 'tenant-easterseals' }) |
            Should -Be 'easterseals.com'
    }

    It 'never returns a bare tenant GUID (EXO rejects "Organization cannot be a Guid")' {
        Mock Get-MgContext { throw 'not connected' }
        $creds = New-TestCreds -Fields @{ Domain = '11111111-2222-3333-4444-555555555555' }
        Get-CtgExoOrganization (New-TestJob -PrimaryDomain 'easterseals.com') $creds | Should -Be 'easterseals.com'
    }

    It 'falls back when our own Graph session is unreadable (throttle / missing Organization.Read.All)' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-easterseals'; TenantId = 'tenant-easterseals' } }
        Mock Get-MgOrganization { throw 'throttled' }
        $creds = New-TestCreds -Fields @{ TenantId = 'tenant-easterseals'; Domain = 'EasterSealsSouthFlorid.onmicrosoft.com' }
        Get-CtgExoOrganization (New-TestJob) $creds | Should -Be 'EasterSealsSouthFlorid.onmicrosoft.com'
    }

    It 'throws a fixable error when no domain can be resolved at all' {
        Mock Get-MgContext { throw 'not connected' }
        { Get-CtgExoOrganization (New-TestJob -PrimaryDomain '') (New-TestCreds -Fields @{}) } |
            Should -Throw -ExpectedMessage '*no Exchange Online organization DOMAIN*'
    }
}

Describe 'Connect-CtgGraphForJob' {
    It 'binds Graph to THIS client when the session is another client''s' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-olympus'; TenantId = 'tenant-olympus' } }
        Mock Connect-CtgM365 { }
        $creds = New-TestCreds -AppId 'app-easterseals' -Fields @{ TenantId = 'tenant-easterseals' }

        Connect-CtgGraphForJob (New-TestJob) $creds | Should -BeTrue
        Should -Invoke Connect-CtgM365 -Times 1 -ParameterFilter { $TenantId -eq 'tenant-easterseals' }
    }

    It 'reuses a session that is already ours (no needless reconnect)' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-easterseals'; TenantId = 'tenant-easterseals' } }
        Mock Connect-CtgM365 { }
        $creds = New-TestCreds -AppId 'app-easterseals' -Fields @{ TenantId = 'tenant-easterseals' }

        Connect-CtgGraphForJob (New-TestJob) $creds | Should -BeTrue
        Should -Not -Invoke Connect-CtgM365
    }

    It 'returns false instead of throwing when the client''s m365-admin cannot drive Graph' {
        # A cert-only app (no client secret) must not turn a working exchange job into a failure —
        # the resolver simply falls back to the configured domains, as it did before.
        Mock Get-MgContext { throw 'not connected' }
        Mock Connect-CtgM365 { throw 'AADSTS7000215: invalid client secret' }
        Connect-CtgGraphForJob (New-TestJob) (New-TestCreds -Fields @{ TenantId = 't' }) | Should -BeFalse
    }

    It 'returns false when no m365-admin secret was brokered' {
        Connect-CtgGraphForJob (New-TestJob) @{} | Should -BeFalse
    }

    It 'evicts every cached key that rides Graph when it REBINDS the session' {
        # Displacing the Graph session invalidates everyone riding it. Without this, the client we just
        # displaced sees its m365 key intact, skips Connect, and provisions inside THIS client's tenant.
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-olympus'; TenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }
        Mock Connect-CtgM365 { }
        $script:ConnectedTenant = @{ 'm365' = 'olympus|fp'; 'entra' = 'olympus|fp'; 'tap' = 'olympus|fp'; 'exchange' = 'easterseals|fp' }

        Connect-CtgGraphForJob (New-TestJob) (New-TestCreds -AppId 'app-easterseals' -Fields @{ TenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }) | Should -BeTrue

        $script:ConnectedTenant.ContainsKey('m365') | Should -BeFalse
        $script:ConnectedTenant.ContainsKey('entra') | Should -BeFalse
        $script:ConnectedTenant.ContainsKey('tap') | Should -BeFalse
        # exchange rides its OWN EXO session keyed by client — a Graph rebind must not evict it.
        $script:ConnectedTenant['exchange'] | Should -Be 'easterseals|fp'
    }

    It 'does NOT evict anything when it reuses a session that is already ours' {
        Mock Get-MgContext { [pscustomobject]@{ ClientId = 'app-easterseals'; TenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } }
        Mock Connect-CtgM365 { }
        $script:ConnectedTenant = @{ 'm365' = 'easterseals|fp'; 'entra' = 'easterseals|fp' }

        Connect-CtgGraphForJob (New-TestJob) (New-TestCreds -AppId 'app-easterseals' -Fields @{ TenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }) | Should -BeTrue

        $script:ConnectedTenant['m365'] | Should -Be 'easterseals|fp'
        $script:ConnectedTenant['entra'] | Should -Be 'easterseals|fp'
    }
}

Describe 'client boundary — nothing survives from one client to the next' {
    BeforeEach {
        Mock Disconnect-MgGraph { }
        Mock Disconnect-CtgExchange { }
        Mock Write-CtgLog { }
        $script:CurrentClientKey = $null
        $script:ConnectedTenant = @{}
    }

    It 'disconnects everything when the client changes' {
        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1456'))   # Olympus first
        $script:ConnectedTenant = @{ 'm365' = 'olympus|fp'; 'exchange' = 'olympus|fp' }

        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1453'))   # -> Easterseals

        Should -Invoke Disconnect-MgGraph -Times 1
        Should -Invoke Disconnect-CtgExchange -Times 1
        $script:ConnectedTenant.Count | Should -Be 0 -Because 'a key naming a session we just closed makes the next job skip Connect and run unconnected'
    }

    It 'does NOT disconnect between two jobs for the SAME client' {
        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1453'))
        $script:ConnectedTenant = @{ 'm365' = 'easterseals|fp' }

        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1453'))

        Should -Not -Invoke Disconnect-MgGraph -Because 'within one client there is nothing to leak FROM — and EXO reconnects cost seconds'
        $script:ConnectedTenant['m365'] | Should -Be 'easterseals|fp'
    }

    It 'does not disconnect on the very first job of the process (nothing is bound yet)' {
        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1453'))
        Should -Not -Invoke Disconnect-MgGraph
    }

    It 'treats a conn test and a job as the same boundary (the actual UM0029840 sequence)' {
        # Olympus Cosmetic's CONN TESTS bound Graph; an Easterseals JOB inherited it 12 minutes later.
        # Both loops share this process's sessions, so both must honour the boundary.
        [void](Reset-CtgCloudSessionsOnClientChange ([pscustomobject]@{ client = [pscustomobject]@{ slug = 'core1456' } }))  # conn test
        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1453'))                                          # job
        Should -Invoke Disconnect-MgGraph -Times 1
    }

    It 'handles a job with no client without collapsing every such job into one identity' {
        [void](Reset-CtgCloudSessionsOnClientChange ([pscustomobject]@{ client = $null }))
        $script:CurrentClientKey | Should -Be '(no client)'
        # ...and moving to a real client from there is still a boundary.
        [void](Reset-CtgCloudSessionsOnClientChange (New-TestJob -Slug 'core1453'))
        Should -Invoke Disconnect-MgGraph -Times 1
    }
}

Describe 'the exchange lane declares its Graph dependency' {
    It 'binds Graph for this client BEFORE resolving the EXO organization' {
        # Ordering is the whole fix: resolving first would read whatever session was already loaded.
        $m = [regex]::Match($script:Runner, '(?ms)Connect-CtgGraphForJob \$job \$creds.*?Connect-CtgExchange')
        $m.Success | Should -BeTrue -Because 'the exchange Connect lane must bind Graph before Get-CtgExoOrganization'
    }

    It 'keeps exchange OUT of the Graph group (membership is symmetric; this relationship is not)' {
        # exchange rebinding Graph must evict the riders — Connect-CtgGraphForJob does that itself. The
        # reverse must NOT happen: exchange's cache key already encodes its client, so an m365 job for
        # someone else evicting it would force a Connect-ExchangeOnline that isn't needed, and EXO
        # sessions stack rather than replace.
        $g = [regex]::Match($script:Runner, '(?ms)^\$script:ConnectionGroups\s*=\s*(@\{.*?^\})')
        $groups = & ([scriptblock]::Create($g.Groups[1].Value))
        $groups.graph | Should -Not -Contain 'exchange'
    }

    It 'closes the EXO session when the job finishes, and forgets the cache key with it' {
        # A teardown that left the key cached would make the next job skip Connect and run unconnected.
        $script:Runner | Should -Match '(?ms)\$handler\.ContainsKey\(''Disconnect''\).*?& \$handler\.Disconnect.*?Clear-CtgConnectionSiblings -SystemKey \$job\.systemKey -IncludeSelf'
    }

    It 'the exchange handler exposes a Disconnect lane' {
        $script:Runner | Should -Match "Disconnect = \{ Disconnect-CtgExchange \}"
    }

    It 'BOTH the job loop and the conn-test loop reset on a client change' {
        # One loop honouring the boundary is not enough: the two share this process's sessions, and in
        # UM0029840 the poisoner was a conn test and the victim was a job.
        ([regex]::Matches($script:Runner, 'Reset-CtgCloudSessionsOnClientChange \$job')).Count |
            Should -BeGreaterOrEqual 2 -Because 'the job loop and the conn-test loop must both enforce it'
    }

    It 'resets BEFORE the connect gate could reuse a cached session' {
        $script:Runner | Should -Match '(?ms)Reset-CtgCloudSessionsOnClientChange \$job.*?brokering credentials.*?\$handler\.ContainsKey\(''Connect''\)'
    }

    It 'exports Disconnect-CtgExchange from the module manifest (psd1 drift hides it in prod)' {
        $psd1 = Get-Content (Join-Path (Split-Path $PSScriptRoot -Parent) 'modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1') -Raw
        $psd1 | Should -Match "'Disconnect-CtgExchange'"
    }

    It 'Start-IamRunner.ps1 still parses' {
        $errs = $null
        [System.Management.Automation.Language.Parser]::ParseFile($script:RunnerPath, [ref]$null, [ref]$errs) | Out-Null
        $errs | Should -BeNullOrEmpty
    }
}
