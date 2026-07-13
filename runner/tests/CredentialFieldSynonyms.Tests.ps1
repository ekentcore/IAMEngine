# Delinea stores the SAME m365 app-registration credential under two different field spellings,
# depending on the template the secret was created from:
#
#   "Entra Azure AD Account"  -> Username / Password / TenantId
#   "Automation - Azure App"  -> appID    / Secret   / tenantID
#
# Connect-CtgM365 connects with -ClientSecretCredential, where UserName IS the app id and Password IS
# the client secret — so both spellings are the same credential. The broker used to read ONLY
# 'Username'/'Password', so every client whose m365-admin secret came from the Automation template got
# a $null .Credential and failed at connect with an opaque bind error. These tests pin the synonyms.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# ConnectionCache tests — we parse it as data and evaluate just the pieces under test.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    foreach ($name in 'CRED_USERNAME_FIELDS', 'CRED_PASSWORD_FIELDS') {
        $m = [regex]::Match($script:Runner, "(?ms)^\`$script:$name\s*=\s*(@\(.*?\))\s*$")
        $m.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare `$script:$name"
        Set-Variable -Scope script -Name $name -Value (& ([scriptblock]::Create($m.Groups[1].Value)))
    }

    # Lift Select-CtgCredField out of the runner and define it here.
    $fn = [regex]::Match($script:Runner, '(?ms)^function Select-CtgCredField \{.*?^\}')
    $fn.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Select-CtgCredField'
    . ([scriptblock]::Create($fn.Value))

    # Rebuild the credential exactly as the broker does, from a flat field hashtable.
    function New-BrokeredCred {
        param([hashtable]$Fields)
        $u = Select-CtgCredField $Fields $script:CRED_USERNAME_FIELDS
        $p = Select-CtgCredField $Fields $script:CRED_PASSWORD_FIELDS
        $sec = if ($p) { ConvertTo-SecureString $p -AsPlainText -Force } else { $null }
        if ($u -and $sec) { [pscredential]::new([string]$u, $sec) } else { $null }
    }
}

Describe 'brokered credential field synonyms' {
    It 'builds a credential from the Entra Azure AD Account spelling (Username/Password)' {
        $c = New-BrokeredCred @{ Username = 'app-id-guid'; Password = 'shh'; TenantId = 't' }
        $c | Should -Not -BeNullOrEmpty
        $c.UserName | Should -Be 'app-id-guid'
    }

    It 'builds a credential from the Automation - Azure App spelling (appID/Secret)' {
        # the real CoreAutomation - Azure App field set, verbatim
        $fields = @{
            OrganizationLongName = 'Acme'; OrgShortName = 'ACME'; AzOrgSubscription = 's'
            AzOrgResourceGroup   = 'rg'; AzOrgLocation = 'eastus'; OnMicrosoftOrgName = 'acme'
            tenantID             = '11111111-2222-3333-4444-555555555555'
            appID                = '99999999-8888-7777-6666-555555555555'
            Secret               = 'the-client-secret'
        }
        $c = New-BrokeredCred $fields
        $c | Should -Not -BeNullOrEmpty -Because 'this is the credential the runner previously could not use'
        $c.UserName | Should -Be '99999999-8888-7777-6666-555555555555'
        ([pscredential]::new('x', $c.Password)).GetNetworkCredential().Password | Should -Be 'the-client-secret'
    }

    It 'resolves tenantID through the case-insensitive Fields lookup Get-CtgTenantDomain uses' {
        # PowerShell hashtables are case-insensitive, so $Fields['TenantId'] finds a 'tenantID' key.
        # This is why the tenant needed no synonym work — pin it so a future refactor can't regress it.
        $fields = @{ tenantID = 'tenant-guid' }
        $fields['TenantId'] | Should -Be 'tenant-guid'
    }

    It 'prefers the canonical name when both spellings are present' {
        $c = New-BrokeredCred @{ Username = 'canonical'; appID = 'other'; Password = 'p'; Secret = 's' }
        $c.UserName | Should -Be 'canonical'
    }

    It 'skips a field that exists but is blank, falling through to the next synonym' {
        # a template that carries an empty Username must not shadow a populated appID
        $c = New-BrokeredCred @{ Username = '  '; appID = 'real-app-id'; Password = ''; Secret = 'real-secret' }
        $c | Should -Not -BeNullOrEmpty
        $c.UserName | Should -Be 'real-app-id'
    }

    It 'returns no credential when neither spelling carries a value' {
        New-BrokeredCred @{ Notes = 'nothing useful' } | Should -BeNullOrEmpty
    }

    It 'is used by every place the runner rebuilds a credential' {
        # Three sites rebuild $creds from brokered fields: Get-JobCredential, Get-ConnTestCredential,
        # and the cloud-group discovery loop. A new one that reads $fields['Username'] directly would
        # silently reintroduce the bug for that path only.
        $direct = [regex]::Matches($script:Runner, "\`$(fields|f)\['Username'\]")
        $direct.Count | Should -Be 0 -Because 'credential rebuilds must go through Select-CtgCredField'
        ([regex]::Matches($script:Runner, 'Select-CtgCredField \$\w+ \$script:CRED_USERNAME_FIELDS')).Count |
            Should -Be 3 -Because 'Get-JobCredential, Get-ConnTestCredential and cloud-group discovery all broker credentials'
    }
}
