# The app now vaults 'google-admin' on Secret Server's stock "Automation - API" template
# (the same template Adobe reuses — see AdobeSecret.Tests.ps1). Its fields are:
#   ClientSecret = base64 of the FULL service-account JSON key (or a bare PEM inside base64,
#                  or the raw JSON/PEM un-encoded)
#   accountid    = the service account's client email (only needed when ClientSecret is a
#                  bare PEM — a full JSON key already carries client_email)
#   apiURL       = the super-admin email to impersonate (repurposed field name — it's an
#                  email, not a URL)
#   ClientID     = the Google Workspace customer id
#
# This is ADDITIVE: every prior accepted shape (ServiceAccountJson/KeyJson, the base64
# variants, split ClientEmail+PrivateKey, Impersonate/AdminEmail/…, CustomerId, the
# Username fallback) must keep working untouched, and is tried FIRST — the new fields
# only kick in when that chain misses.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like
# AdobeSecret.Tests.ps1 — we parse it as text and lift the function.

BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $fn = [regex]::Match($script:Runner, '(?ms)^function Use-CtgGoogleSecret \{.*?^\}')
    $fn.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare Use-CtgGoogleSecret'
    . ([scriptblock]::Create($fn.Value))

    # Seam the function calls. Capture what Connect-CtgGoogle was handed.
    function Connect-CtgGoogle {
        param($ClientEmail, $PrivateKey, $Impersonate, $CustomerId, $Scopes)
        $script:Connected = @{
            ClientEmail = $ClientEmail
            PrivateKey  = $PrivateKey
            Impersonate = $Impersonate
            CustomerId  = $CustomerId
            Scopes      = $Scopes
        }
    }

    # Build the shape Get-JobCredential hands the executors: .Fields plus .Username.
    function New-GoogleCreds {
        param([hashtable]$Fields, [string]$Username)
        @{ 'google-admin' = [pscustomobject]@{ Fields = $Fields; Username = $Username } }
    }

    function New-FakeSaJson {
        param([string]$Email = 'sa@project.iam.gserviceaccount.com', [string]$Key = "-----BEGIN PRIVATE KEY-----`nFAKEKEYMATERIAL`n-----END PRIVATE KEY-----")
        (@{ client_email = $Email; private_key = $Key } | ConvertTo-Json -Compress)
    }

    function ConvertTo-B64 { param([string]$Value) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value)) }
}

Describe 'Use-CtgGoogleSecret — Automation - API template shapes' {

    BeforeEach { $script:Connected = $null }

    It 'resolves email/key/impersonate/customer from a base64 JSON key in ClientSecret + accountid + apiURL + ClientID' {
        $json = New-FakeSaJson
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 $json
            accountid    = 'sa@project.iam.gserviceaccount.com'
            apiURL       = 'super-admin@client.com'
            ClientID     = 'C0123456'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'sa@project.iam.gserviceaccount.com'
        $script:Connected.PrivateKey  | Should -Match 'FAKEKEYMATERIAL'
        $script:Connected.Impersonate | Should -Be 'super-admin@client.com'
        $script:Connected.CustomerId  | Should -Be 'C0123456'
    }

    It 'resolves a base64-encoded bare PEM in ClientSecret, using accountid for the email' {
        $pem = "-----BEGIN PRIVATE KEY-----`nSOMEOTHERKEY`n-----END PRIVATE KEY-----"
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 $pem
            accountid    = 'sa2@project.iam.gserviceaccount.com'
            apiURL       = 'super-admin@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'sa2@project.iam.gserviceaccount.com'
        $script:Connected.PrivateKey  | Should -Match 'SOMEOTHERKEY'
        $script:Connected.Impersonate | Should -Be 'super-admin@client.com'
    }

    It 'resolves a RAW (un-base64ed) JSON key sitting directly in ClientSecret' {
        $json = New-FakeSaJson -Email 'sa3@project.iam.gserviceaccount.com'
        $creds = New-GoogleCreds @{
            ClientSecret = $json
            apiURL       = 'super-admin@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'sa3@project.iam.gserviceaccount.com'
        $script:Connected.PrivateKey  | Should -Match 'FAKEKEYMATERIAL'
    }

    It 'resolves a RAW (un-base64ed) bare PEM sitting directly in ClientSecret, using accountid' {
        $pem = "-----BEGIN PRIVATE KEY-----`nRAWPEMKEY`n-----END PRIVATE KEY-----"
        $creds = New-GoogleCreds @{
            ClientSecret = $pem
            accountid    = 'sa4@project.iam.gserviceaccount.com'
            apiURL       = 'super-admin@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'sa4@project.iam.gserviceaccount.com'
        $script:Connected.PrivateKey  | Should -Match 'RAWPEMKEY'
    }

    It 'falls back to my_customer when ClientID is empty' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'super-admin@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.CustomerId | Should -Be 'my_customer'
    }

    It 'does NOT treat apiURL as Impersonate when it has no @ (it is not an email)' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'https://not-an-email.example.com'
        }
        { Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds } |
            Should -Throw -ExpectedMessage '*no admin to impersonate*'
    }
}

Describe 'Use-CtgGoogleSecret — existing shapes keep working (no regression)' {

    BeforeEach { $script:Connected = $null }

    It 'still honours legacy ServiceAccountKeyBase64 + Impersonate' {
        $creds = New-GoogleCreds @{
            ServiceAccountKeyBase64 = ConvertTo-B64 (New-FakeSaJson -Email 'legacy@project.iam.gserviceaccount.com')
            Impersonate             = 'admin@legacy-client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'legacy@project.iam.gserviceaccount.com'
        $script:Connected.Impersonate | Should -Be 'admin@legacy-client.com'
        $script:Connected.CustomerId  | Should -Be 'my_customer'
    }

    It 'still honours split ClientEmail+PrivateKey with the Username fallback for Impersonate' {
        $creds = New-GoogleCreds -Fields @{
            ClientEmail = 'split@project.iam.gserviceaccount.com'
            PrivateKey  = '-----BEGIN PRIVATE KEY-----SPLITKEY-----END PRIVATE KEY-----'
        } -Username 'admin@split-client.com'
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'split@project.iam.gserviceaccount.com'
        $script:Connected.Impersonate | Should -Be 'admin@split-client.com'
    }

    It 'prefers the existing $pick chain over the new ClientSecret/accountid/apiURL fields when both are present' {
        # ServiceAccountJson (existing) must win over ClientSecret (new) — the new fields are a
        # fallback only, never a competing source when the old chain already resolved.
        $oldJson = New-FakeSaJson -Email 'old-wins@project.iam.gserviceaccount.com'
        $newJson = New-FakeSaJson -Email 'new-should-be-ignored@project.iam.gserviceaccount.com'
        $creds = New-GoogleCreds @{
            ServiceAccountJson = $oldJson
            ClientSecret       = ConvertTo-B64 $newJson
            accountid          = 'ignored@project.iam.gserviceaccount.com'
            Impersonate        = 'admin@old-client.com'
            apiURL             = 'ignored-impersonate@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.ClientEmail | Should -Be 'old-wins@project.iam.gserviceaccount.com'
        $script:Connected.Impersonate | Should -Be 'admin@old-client.com'
    }

    It 'throws when the job brokered no google-admin secret at all' {
        { Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds @{} } |
            Should -Throw -ExpectedMessage "*did not broker a 'google-admin' secret*"
    }
}

Describe 'Use-CtgGoogleSecret — garbage ClientSecret' {

    BeforeEach { $script:Connected = $null }

    It 'throws the standard "no service-account key" error when ClientSecret is neither PEM, JSON, nor valid base64 of either' {
        $creds = New-GoogleCreds @{
            ClientSecret = 'totally-not-a-key-or-base64!!'
            apiURL       = 'super-admin@client.com'
        }
        { Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds } |
            Should -Throw -ExpectedMessage '*has no service-account key*'
    }

    It 'throws the standard error when ClientSecret base64-decodes to garbage (valid base64, not PEM/JSON)' {
        $creds = New-GoogleCreds @{
            ClientSecret = (ConvertTo-B64 'just some plain garbage text, not a key')
            apiURL       = 'super-admin@client.com'
        }
        { Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds } |
            Should -Throw -ExpectedMessage '*has no service-account key*'
    }
}
