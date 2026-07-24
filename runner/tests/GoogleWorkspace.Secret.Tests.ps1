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

    # The customer-id validation warns through the runner's log seam — capture it.
    function Write-CtgLog { param([Parameter(Position = 0)]$Message, [Parameter(Position = 1)]$Level) $script:Warned = "$Message" }

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

Describe 'Use-CtgGoogleSecret — customer id validation (FR#35)' {

    # The Automation - API template's ClientID field is SUPPOSED to hold the Workspace customer id
    # (C0… from Admin Console → Account settings), but in the wild it frequently holds the service
    # account's numeric OAuth client_id instead (UOVO Art, secret 57051) — the Directory API then
    # 400s "Invalid Input". A value that doesn't look like a customer id must self-heal to
    # my_customer with a WARN, never take down the connection test.

    BeforeEach { $script:Connected = $null; $script:Warned = $null; $script:GoogleCustomerAdvisory = 'stale-from-previous-connect' }

    It 'falls back to my_customer with a WARN when ClientID holds a numeric OAuth client id' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'super-admin@client.com'
            ClientID     = '104857200000000012345'   # 21-digit SA OAuth client_id, NOT a customer id
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.CustomerId | Should -Be 'my_customer'
        $script:Warned | Should -Match 'customer id'
        $script:Warned | Should -Not -Match '104857200000000012345'   # never log the full raw value
        # the advisory must ALSO reach the conn-test output — the operator who can fix the
        # secret never reads the runner host's log file
        $script:GoogleCustomerAdvisory | Should -Match 'customer id'
        $script:GoogleCustomerAdvisory | Should -Not -Match '104857200000000012345'
    }

    It 'falls back to my_customer with a WARN when the value contains an @ (an email, not a customer id)' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'super-admin@client.com'
            ClientID     = 'admin@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.CustomerId | Should -Be 'my_customer'
        $script:Warned | Should -Match 'customer id'
    }

    It 'passes a real Workspace customer id through untouched, with no WARN' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'super-admin@client.com'
            ClientID     = 'C01ab2cd3'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.CustomerId | Should -Be 'C01ab2cd3'
        $script:Warned | Should -BeNullOrEmpty
        $script:GoogleCustomerAdvisory | Should -BeNullOrEmpty   # a stale advisory from a prior connect must clear
    }

    It 'CustomerId field still takes precedence over ClientID (regression)' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'super-admin@client.com'
            CustomerId   = 'C0aaaa111'
            ClientID     = 'C0bbbb222'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.CustomerId | Should -Be 'C0aaaa111'
        $script:Warned | Should -BeNullOrEmpty
    }

    It 'still defaults to my_customer when no customer fields exist, with no WARN (regression)' {
        $creds = New-GoogleCreds @{
            ClientSecret = ConvertTo-B64 (New-FakeSaJson)
            apiURL       = 'super-admin@client.com'
        }
        Use-CtgGoogleSecret -Job ([pscustomobject]@{}) -Creds $creds
        $script:Connected.CustomerId | Should -Be 'my_customer'
        $script:Warned | Should -BeNullOrEmpty
    }
}

Describe 'google-workspace conn-test probe — the customer id must reach the wire (FR#35)' {

    # THE actual UOVO Art bug: Connect-CtgGoogle stores the customer id in MODULE scope
    # ($script:GoogleCustomer in the psm1), but the probe scriptblock is bound to the RUNNER
    # SCRIPT's scope where that variable is never assigned — so the probe interpolated an EMPTY
    # string and sent `GET /users?customer=&maxResults=1`, which Google 400s. The configured
    # value (good or bad) never crossed the module boundary. The probe must read the customer
    # through the module's exported seam (Get-CtgGoogleCustomer).

    BeforeAll {
        $m = [regex]::Match($script:Runner, "(?ms)^\`$CONNTEST_PROBE\['google-workspace'\] = \{.*?^\}")
        $m.Success | Should -BeTrue -Because 'Start-IamRunner.ps1 must declare the google-workspace conn-test probe'
        $body = $m.Value.Substring($m.Value.IndexOf('{'))
        $script:Probe = [scriptblock]::Create($body.Substring(1, $body.Length - 2))

        # Seams the probe calls, stubbed in THIS scope (exactly how the real scope split works —
        # anything the probe needs from the module must arrive through a function, not a variable).
        function Invoke-CtgGoogleApi { param($Method, $Path) $script:ProbePath = $Path; $null }
        function Get-CtgGoogleSessionScopes { @('https://www.googleapis.com/auth/admin.directory.user', 'https://www.googleapis.com/auth/admin.directory.user.security') }
        function Get-CtgGoogleCustomer { $script:StubCustomer }
    }

    BeforeEach {
        $script:ProbePath = $null
        $script:ConnTestRights = @()
        $script:GoogleCustomerAdvisory = $null
        $script:StubCustomer = 'my_customer'
    }

    It 'sends the customer id the session was connected with' {
        $script:StubCustomer = 'C0123abcd'
        & $script:Probe ([pscustomobject]@{}) @{} | Out-Null
        $script:ProbePath | Should -Match 'customer=C0123abcd&'
    }

    It 'REGRESSION: never sends an empty customer= param' {
        & $script:Probe ([pscustomobject]@{}) @{} | Out-Null
        $script:ProbePath | Should -Not -Match 'customer=&'
        $script:ProbePath | Should -Match 'customer=my_customer&'
    }

    It 'surfaces the customer-id fallback advisory as a rights row the operator can see' {
        $script:GoogleCustomerAdvisory = "the google-admin secret's ClientID/CustomerId value '1048…' (21 chars) doesn't look like a Workspace customer id — using my_customer instead."
        & $script:Probe ([pscustomobject]@{}) @{} | Out-Null
        $advisory = @($script:ConnTestRights | Where-Object { $_.op -match 'customer' })
        $advisory.Count | Should -Be 1
        $advisory[0].ok | Should -BeNullOrEmpty
        $advisory[0].detail | Should -Match 'customer id'
    }

    It 'adds no advisory row when the customer id was fine' {
        & $script:Probe ([pscustomobject]@{}) @{} | Out-Null
        @($script:ConnTestRights | Where-Object { $_.op -match 'customer' }).Count | Should -Be 0
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
