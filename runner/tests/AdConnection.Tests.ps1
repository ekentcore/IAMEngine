# How the runner authenticates to Active Directory.
#
# The bug these tests pin (case UM0029763, Brock Built): the agent runs as SYSTEM ON the domain
# controller, but New-CtgAdConnection ALWAYS attached the brokered ad-dc -Credential. Delinea's
# "Active Directory Account" template keeps the domain in its own field, so the stored Username is a
# BARE sAMAccountName — which carries no realm, so SSPI cannot get a Kerberos ticket, the connection
# degrades to NTLM, and a DC with LDAP signing / channel binding enforced refuses the bind. That
# surfaced as "Authentication failed on the remote side" and, on the retry, LDAP 8 strongerAuthRequired
# ("The operation being requested was not performed because the user has not been authenticated").
#
# The fix prefers the agent's OWN identity — but only where that identity is KNOWN-privileged (SYSTEM
# on a writable DC), because the probe is a READ and every authenticated principal passes a read. The
# two invariants below are what stop the fix from being worse than the bug, and each has tests here:
#
#   * ambient is never a silent fallback for a refused credential off a privileged DC — a machine
#     account can read the directory but not create a user, so accepting it would go green and then
#     fail Access-Denied halfway through a case;
#   * at most ONE credential bind per call — probing several forms of the same password would multiply
#     badPwdCount on a SHARED service account and march it into a domain lockout.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# AdobeSecret and CredentialFieldSynonyms suites — we parse it as text and lift the functions.

BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    foreach ($name in 'Select-CtgCredField', 'Test-CtgAdConnection', 'Get-CtgAdCredential',
        'Get-CtgSamFromUserName', 'New-CtgAdConnection') {
        # the declaration may carry a param list — `function New-CtgAdConnection($creds) {`
        $fn = [regex]::Match($script:Runner, "(?ms)^function $name\s*(\([^)]*\))?\s*\{.*?^\}")
        $fn.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare $name"
        . ([scriptblock]::Create($fn.Value))
    }

    # Deliberately NOT lifted: the tests replace this with a seam (Use-PrivilegedHost, which writes to
    # the GLOBAL function drive), and dot-sourcing the real one into this script scope would shadow the
    # override — the seam would silently stop working and every test would run against the real host.
    # Still assert it exists, so a rename can't leave the seam pointing at nothing.
    [regex]::IsMatch($script:Runner, '(?m)^function Test-CtgAdAmbientIsPrivileged\b') |
        Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Test-CtgAdAmbientIsPrivileged'

    function Write-CtgLog { param($Message, $Level) $script:Logged = "$Message" }

    # Seam: which identities the DC will accept. Every OTHER bind is refused the way a hardened DC does,
    # and each attempt is recorded — so a test can assert not just the outcome but how many times we
    # hit the directory with a password (the lockout invariant).
    function Get-ADDomain {
        [CmdletBinding()]
        param([string]$Server, [pscredential]$Credential)
        $id = if ($Credential) { $Credential.UserName } else { '<ambient>' }
        $script:Attempts += @($id)
        if ($Credential) { $script:CredBinds += @($id) }
        $script:SeenServer = $Server
        if ($script:Accept -contains $id) { return [pscustomobject]@{ DNSRoot = 'brockbuilt.com' } }
        throw 'Authentication failed on the remote side (the stream might still be available for additional authentication attempts).'
    }

    # The shape Get-JobCredential hands the executors: .Fields plus a rebuilt .Credential.
    function New-AdCreds {
        param([hashtable]$Fields)
        $u = $Fields['Username']; $p = $Fields['Password']
        $cred = if ($u -and $p) { [pscredential]::new([string]$u, (ConvertTo-SecureString $p -AsPlainText -Force)) } else { $null }
        @{ 'ad-dc' = [pscustomobject]@{ Fields = $Fields; Credential = $cred; Username = $u } }
    }

    # Seam: pretend the agent host is / isn't SYSTEM on a writable DC, and reset what the probe saw.
    function Use-PrivilegedHost {
        param([bool]$Privileged)
        $script:Attempts = @()
        $script:CredBinds = @()
        $script:SeenServer = $null
        $script:Logged = $null
        $script:Accept = @()
        Set-Item function:global:Test-CtgAdAmbientIsPrivileged -Value ([scriptblock]::Create("`$$($Privileged.ToString().ToLower())"))
    }
}

AfterAll {
    # Use-PrivilegedHost writes to the GLOBAL function drive — don't leak it into sibling suites.
    Remove-Item function:global:Test-CtgAdAmbientIsPrivileged -ErrorAction SilentlyContinue
}

Describe 'New-CtgAdConnection — SYSTEM on a writable domain controller' {
    BeforeEach { Use-PrivilegedHost -Privileged $true }

    It 'uses the agent''s own identity and passes NO credential' {
        # This is the Brock Built topology. SYSTEM on a DC is the directory's own SYSTEM principal.
        $script:Accept = @('<ambient>')
        $splat = New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; Domain = 'brockbuilt.com' })

        $splat.ContainsKey('Credential') | Should -BeFalse -Because 'a DC-hosted agent needs no ad-dc credential'
        $script:Attempts | Should -Be @('<ambient>') -Because 'ambient must be tried FIRST and accepted'
        $script:CredBinds | Should -BeNullOrEmpty -Because 'a working ambient identity must never touch the password'
    }

    It 'records that it selected the ambient identity, so the rights probe knows who to audit' {
        $script:Accept = @('<ambient>')
        New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw' }) | Out-Null
        $script:CtgAdIdentity.kind | Should -Be 'ambient'
        $script:CtgAdIdentity.sam | Should -BeNullOrEmpty
    }

    It 'falls back to the brokered credential when AD refuses the agent''s own identity' {
        # e.g. the scheduled task was re-pointed off SYSTEM. Here the fallback IS safe: we only reach it
        # after ambient was refused outright, so we are not papering over a working-but-unprivileged bind.
        $script:Accept = @('svc_iam@brockbuilt.com')
        $splat = New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; Domain = 'brockbuilt.com' })

        $splat.Credential.UserName | Should -Be 'svc_iam@brockbuilt.com'
        $script:Attempts[0] | Should -Be '<ambient>' -Because 'ambient is still preferred, and only then fallen back from'
        $script:Logged | Should -Match 'refused' -Because 'a fallback is worth a WARN in the run log'
        $script:CtgAdIdentity.kind | Should -Be 'credential'
        $script:CtgAdIdentity.sam | Should -Be 'svc_iam' -Because 'the ACL check resolves SIDs from the sAMAccountName'
    }
}

Describe 'New-CtgAdConnection — anywhere that is not a privileged DC' {
    BeforeEach { Use-PrivilegedHost -Privileged $false }

    It 'uses the brokered credential and never probes the unprivileged ambient identity' {
        $script:Accept = @('<ambient>', 'CORP\svc_iam')
        $splat = New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; Domain = 'CORP' })

        $splat.Credential.UserName | Should -Be 'CORP\svc_iam'
        $script:Attempts | Should -Be @('CORP\svc_iam') -Because 'ambient here is only the machine account — do not even consider it'
    }

    It 'THROWS rather than silently falling back to the machine account when the credential is refused' {
        # The regression this guards. Ambient WOULD pass the read probe (a machine account is a valid
        # authenticated user and can read the directory) — but it cannot create users. Accepting it
        # would turn "your ad-dc password is stale" into a half-applied offboard that dies Access-Denied
        # partway through. Fail loudly instead.
        $script:Accept = @('<ambient>')   # ambient works, the credential does not
        $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'stale'; Domain = 'CORP' }

        { New-CtgAdConnection $creds } | Should -Throw -ExpectedMessage "*refused the brokered ad-dc account 'CORP\svc_iam'*"
        $script:Attempts | Should -Not -Contain '<ambient>' -Because 'the machine account must never be accepted as a fallback here'
    }

    It 'still uses ambient when no ad-dc credential is wired at all — that is all there is' {
        $script:Accept = @('<ambient>')
        $splat = New-CtgAdConnection @{}
        $splat.ContainsKey('Credential') | Should -BeFalse
        $script:CtgAdIdentity.kind | Should -Be 'ambient'
    }
}

Describe 'Get-CtgAdCredential — one bind, never a ladder' {
    BeforeEach { Use-PrivilegedHost -Privileged $false }

    It 'makes AT MOST ONE credential bind even when the password is wrong' {
        # ad-dc is a SHARED account (clients reuse it for exchange-onprem / directory-sync). Probing
        # DOMAIN\user, then user@domain, then the bare name would be 3 failed logons per call and would
        # walk a stale password straight into a domain lockout.
        $script:Accept = @()
        { New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'stale'; Domain = 'brockbuilt.com' }) } | Should -Throw

        $script:CredBinds.Count | Should -Be 1 -Because 'each extra failed bind increments badPwdCount on a shared account'
    }

    It 'qualifies a bare username from the secret''s Domain field' {
        # THE root cause: a bare name has no realm -> no Kerberos -> NTLM -> a hardened DC refuses it.
        $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; Domain = 'CORP' }
        (Get-CtgAdCredential $creds['ad-dc']).UserName | Should -Be 'CORP\svc_iam'
    }

    It 'puts a DNS domain in the UPN slot, not the down-level slot' {
        $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; Domain = 'brockbuilt.com' }
        (Get-CtgAdCredential $creds['ad-dc']).UserName | Should -Be 'svc_iam@brockbuilt.com'
    }

    It 'trusts an already-qualified username verbatim and does not mangle it' {
        foreach ($u in @('CORP\svc_iam', 'svc_iam@brockbuilt.com')) {
            $creds = New-AdCreds @{ Username = $u; Password = 'pw'; Domain = 'IGNORED' }
            (Get-CtgAdCredential $creds['ad-dc']).UserName | Should -Be $u
        }
    }

    It 'leaves a bare username alone when the secret has no Domain field — no worse than today' {
        $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'pw' }
        (Get-CtgAdCredential $creds['ad-dc']).UserName | Should -Be 'svc_iam'
    }

    It 'returns nothing when no credential is brokered' {
        Get-CtgAdCredential $null | Should -BeNullOrEmpty
    }
}

Describe 'Get-CtgSamFromUserName' {
    It 'pulls the sAMAccountName out of every username form' {
        Get-CtgSamFromUserName 'CORP\svc_iam' | Should -Be 'svc_iam'
        Get-CtgSamFromUserName 'svc_iam@brockbuilt.com' | Should -Be 'svc_iam'
        Get-CtgSamFromUserName 'svc_iam' | Should -Be 'svc_iam'
    }
}

Describe 'New-CtgAdConnection — the -Server target' {
    BeforeEach { Use-PrivilegedHost -Privileged $true }

    It 'reads the DC name from the Documentation Link field the AD template actually has' {
        $script:Accept = @('<ambient>')
        $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; 'Documentation Link' = 'bb-dc02.brockbuilt.com' }
        (New-CtgAdConnection $creds).Server | Should -Be 'bb-dc02.brockbuilt.com'
    }

    It 'ignores a Documentation Link that is a genuine URL' {
        $script:Accept = @('<ambient>')
        $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; 'Documentation Link' = 'https://wiki/ad' }
        (New-CtgAdConnection $creds).ContainsKey('Server') | Should -BeFalse
    }

    It 'accepts every server synonym the app''s ad-dc field-requirements advertises' {
        # The app tells operators Host/DC are valid field names; the runner must actually read them.
        foreach ($field in @('Server', 'Host', 'DomainController', 'DC')) {
            Use-PrivilegedHost -Privileged $true
            $script:Accept = @('<ambient>')
            $creds = New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; $field = 'bb-dc02' }
            (New-CtgAdConnection $creds).Server | Should -Be 'bb-dc02' -Because "the app advertises '$field'"
        }
    }

    It 'omits -Server entirely when none is configured, so the cmdlets target the local domain' {
        $script:Accept = @('<ambient>')
        (New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw' })).ContainsKey('Server') | Should -BeFalse
    }
}

Describe 'New-CtgAdConnection — when nothing authenticates' {
    BeforeEach { Use-PrivilegedHost -Privileged $true }

    It 'names both identities it tried, and says how to fix the credential' {
        $script:Accept = @()   # a hardened DC refusing everything
        $err = { New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw'; Domain = 'brockbuilt.com' }) } |
            Should -Throw -PassThru

        "$err" | Should -Match 'SYSTEM on this domain controller'
        "$err" | Should -Match 'svc_iam@brockbuilt.com'
        "$err" | Should -Match 'Kerberos'
        "$err" | Should -Match 'DOMAIN-QUALIFIED'
    }

    It 'does not blame the credential when the DC is simply unreachable' {
        # A transient outage refuses every identity too — the message must not send someone off to
        # re-cut a secret that was fine.
        $script:Accept = @()
        $err = { New-CtgAdConnection (New-AdCreds @{ Username = 'svc_iam'; Password = 'pw' }) } | Should -Throw -PassThru
        "$err" | Should -Match 'unreachable'
    }
}
