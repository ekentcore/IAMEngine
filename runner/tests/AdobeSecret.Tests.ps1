# Adobe UMAPI v2 needs three things from the secret: Client ID, Client Secret, and the ORGANIZATION
# ID (XXXXXXXXXXXX@AdobeOrg), which goes in the URL path of every call.
#
# The bug these tests pin: the dispatch entry read $creds['adobe'].Fields['OrgId'] directly, but
# Delinea's stock "Automation - API" template has NO OrgId field — its fields are
# clientID / ClientSecret / accountid / apiURL — so in practice the org id is stored in `accountid`.
# Every such secret produced a $null OrgId and a UMAPI call against .../action/ with an empty org,
# failing opaquely rather than saying "your org id isn't where I looked".
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# CredentialFieldSynonyms and ConnectionCache suites — we parse it as text and lift the function.

BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $fn = [regex]::Match($script:Runner, '(?ms)^function Use-CtgAdobeSecret \{.*?^\}')
    $fn.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Use-CtgAdobeSecret'
    . ([scriptblock]::Create($fn.Value))

    # Seams the function calls. Capture what Connect-CtgAdobe was handed; swallow the log.
    function Connect-CtgAdobe {
        param([pscredential]$Credential, [string]$OrgId)
        $script:Connected = @{ ClientId = $Credential.UserName
                               Secret   = (ConvertFrom-SecureString $Credential.Password -AsPlainText)
                               OrgId    = $OrgId }
    }
    function Write-CtgLog { param($Message, $Level) $script:Warned = "$Message" }

    # Build the shape Get-JobCredential hands the executors: .Fields plus a rebuilt .Credential.
    function New-AdobeCreds {
        param([hashtable]$Fields)
        $u = $Fields['Username']; $p = $Fields['Password']
        $cred = if ($u -and $p) { [pscredential]::new([string]$u, (ConvertTo-SecureString $p -AsPlainText -Force)) } else { $null }
        @{ 'adobe' = [pscustomobject]@{ Fields = $Fields; Credential = $cred; Username = $u } }
    }
}

Describe 'Use-CtgAdobeSecret — org id resolution' {

    BeforeEach { $script:Connected = $null; $script:Warned = $null }

    It 'finds the org id in accountid (the "Automation - API" template, which has no OrgId field)' {
        # the real stock field set, verbatim — this is the case that was broken
        $creds = New-AdobeCreds @{
            clientID     = 'abc123clientid'
            ClientSecret = 'p8e-thesecret'
            accountid    = '1A2B3C4D5E6F7A8B9C0D1E2F@AdobeOrg'
            apiURL       = 'https://usermanagement.adobe.io'
        }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.OrgId    | Should -Be '1A2B3C4D5E6F7A8B9C0D1E2F@AdobeOrg'
        $script:Connected.ClientId | Should -Be 'abc123clientid'
        $script:Connected.Secret   | Should -Be 'p8e-thesecret'
    }

    It 'still honours an explicit OrgId field' {
        $creds = New-AdobeCreds @{ Username = 'cid'; Password = 'sec'; OrgId = 'AAA@AdobeOrg' }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.OrgId | Should -Be 'AAA@AdobeOrg'
    }

    It 'finds the org id by VALUE SHAPE even in an unexpected field name' {
        # an operator put it somewhere we never listed — the @AdobeOrg suffix still identifies it
        $creds = New-AdobeCreds @{ Username = 'cid'; Password = 'sec'; Notes = 'ZZZ@AdobeOrg' }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.OrgId | Should -Be 'ZZZ@AdobeOrg'
    }

    It 'prefers the @AdobeOrg value over a non-org value sitting in accountid' {
        # accountid holds a Spanning-style bare account name; the real org id is elsewhere
        $creds = New-AdobeCreds @{ Username = 'cid'; Password = 'sec'
                                   accountid = 'coretelligent'; OrgId = 'REAL@AdobeOrg' }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.OrgId | Should -Be 'REAL@AdobeOrg'
    }

    It 'trims copy-paste whitespace from the org id, id and secret' {
        $creds = New-AdobeCreds @{ clientID = " cid`n"; ClientSecret = "  sec "; accountid = " XYZ@AdobeOrg `n" }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.OrgId    | Should -Be 'XYZ@AdobeOrg'
        $script:Connected.ClientId | Should -Be 'cid'
        $script:Connected.Secret   | Should -Be 'sec'
    }
}

Describe 'Use-CtgAdobeSecret — credential resolution' {

    BeforeEach { $script:Connected = $null; $script:Warned = $null }

    It 'takes the client id/secret from Username/Password when there are no ClientId fields' {
        $creds = New-AdobeCreds @{ Username = 'u-as-clientid'; Password = 'p-as-secret'; accountid = 'O@AdobeOrg' }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientId | Should -Be 'u-as-clientid'
        $script:Connected.Secret   | Should -Be 'p-as-secret'
    }

    It 'prefers explicit ClientId/ClientSecret fields over Username/Password' {
        $creds = New-AdobeCreds @{ Username = 'ignore-me'; Password = 'ignore-me-too'
                                   ClientId = 'real-cid'; ClientSecret = 'real-sec'; accountid = 'O@AdobeOrg' }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientId | Should -Be 'real-cid'
        $script:Connected.Secret   | Should -Be 'real-sec'
    }
}

Describe 'Use-CtgAdobeSecret — actionable failures' {

    BeforeEach { $script:Connected = $null; $script:Warned = $null }

    It 'names accountid when no org id is present anywhere' {
        $creds = New-AdobeCreds @{ Username = 'cid'; Password = 'sec'; apiURL = 'https://x' }
        { Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds } |
            Should -Throw -ExpectedMessage '*accountid*'
    }

    It 'lists the fields the secret actually HAS, so the fix is obvious' {
        $creds = New-AdobeCreds @{ Username = 'cid'; Password = 'sec'; SomeOddField = 'x' }
        { Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds } |
            Should -Throw -ExpectedMessage '*SomeOddField*'
    }

    It 'throws when the client id/secret are missing' {
        $creds = New-AdobeCreds @{ accountid = 'O@AdobeOrg' }
        { Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds } |
            Should -Throw -ExpectedMessage '*Server-to-Server*'
    }

    It 'throws when the job brokered no adobe secret at all' {
        { Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds @{} } |
            Should -Throw -ExpectedMessage "*did not broker an 'adobe' secret*"
    }

    It 'warns (but proceeds) when the org id does not look like an Adobe org id' {
        # Adobe owns this format; if they change it we warn rather than hard-block a working credential
        $creds = New-AdobeCreds @{ Username = 'cid'; Password = 'sec'; OrgId = 'not-an-org-id' }
        Use-CtgAdobeSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.OrgId | Should -Be 'not-an-org-id'
        $script:Warned | Should -Match '@AdobeOrg'
    }
}

Describe 'the dispatch entry uses the resolver' {
    It 'no longer indexes Fields[OrgId] directly' {
        $script:Runner | Should -Not -Match "Connect-CtgAdobe -Credential .*Fields\['OrgId'\]" `
            -Because 'the stock Delinea template has no OrgId field — go through Use-CtgAdobeSecret'
        $script:Runner | Should -Match 'Use-CtgAdobeSecret -Job \$job -Creds \$creds'
    }
}
