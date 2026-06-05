#Requires -Version 7.0

# Coretelligent.Secrets
# Runtime secret retrieval. Nothing sensitive is ever written to a profile or log.
# This is an adapter shell — wire Get-CtgSecret to your existing Delinea
# Secret Server REST function (hierarchical retrieval) rather than re-implementing.

Set-StrictMode -Version Latest

$script:DelineaBaseUrl = $env:DELINEA_BASE_URL  # e.g. https://coretelligent.secretservercloud.com
$script:DelineaToken   = $null

function Connect-CtgSecretStore {
    <#
    .SYNOPSIS
        Obtain a bearer token for Delinea Secret Server.
    .NOTES
        Prefer a machine identity / SDK client over user creds in automation.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscredential]$Credential,
        [string]$BaseUrl = $script:DelineaBaseUrl
    )
    $body = @{
        grant_type = 'password'
        username   = $Credential.UserName
        password   = (ConvertFrom-SecureString $Credential.Password -AsPlainText)
    }
    $resp = Invoke-RestMethod -Method Post -Uri "$BaseUrl/oauth2/token" `
        -Body $body -ContentType 'application/x-www-form-urlencoded'
    $script:DelineaToken   = $resp.access_token
    $script:DelineaBaseUrl = $BaseUrl
    Write-Verbose "Secret store session established."
}

function Get-CtgSecret {
    <#
    .SYNOPSIS
        Resolve a secretRef (from a profile) into a usable credential.
    .PARAMETER Reference
        A profile secretRef: @{ provider = 'delinea'; id = '20102' }.
    .OUTPUTS
        pscustomobject with .Username, .Password (SecureString), .Credential, .Fields
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$Reference,
        # Reason recorded in Delinea's audit + supplied for secrets with a "require comment on view"
        # policy (passed as ?autoComment; harmless for secrets without the policy).
        [string]$AccessComment = 'iam-engine automated provisioning'
    )

    if ($Reference.provider -ne 'delinea') {
        throw "Unsupported secret provider: $($Reference.provider)"
    }
    if (-not $script:DelineaToken) { throw "Call Connect-CtgSecretStore first." }
    if ($Reference.id -eq 'REPLACE_ME') { throw "Secret id is a placeholder — fill it in the profile." }

    $headers = @{ Authorization = "Bearer $script:DelineaToken" }
    $comment = [uri]::EscapeDataString($AccessComment)
    $secret = Invoke-RestMethod -Method Get -Headers $headers `
        -Uri "$script:DelineaBaseUrl/api/v1/secrets/$($Reference.id)?autoComment=$comment"

    # Flatten the field collection into a simple hashtable.
    $fields = @{}
    foreach ($item in $secret.items) { $fields[$item.fieldName] = $item.itemValue }

    $username = $fields['Username']
    $password = if ($fields.ContainsKey('Password')) {
        ConvertTo-SecureString $fields['Password'] -AsPlainText -Force
    } else { $null }

    $cred = if ($username -and $password) { [pscredential]::new($username, $password) } else { $null }

    [pscustomobject]@{
        Username   = $username
        Password   = $password
        Credential = $cred
        Fields     = $fields
    }
}

Export-ModuleMember -Function Connect-CtgSecretStore, Get-CtgSecret
