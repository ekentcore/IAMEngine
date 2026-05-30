#Requires -Version 7.0

# Coretelligent.ServiceNow
# ServiceNow is both the input (read the case) and the audit trail (work notes).
# Table API via Invoke-RestMethod. Scaffold — confirm table/field names against
# your instance (csm_case / sn_customerservice_case, customer_contact, etc.).

Set-StrictMode -Version Latest

$script:SnBase = $null
$script:SnHeaders = $null

function Connect-CtgServiceNow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$InstanceUrl,   # https://yourinstance.service-now.com
        [Parameter(Mandatory)][pscredential]$Credential
    )
    $pair  = "$($Credential.UserName):$(ConvertFrom-SecureString $Credential.Password -AsPlainText)"
    $token = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
    $script:SnBase    = $InstanceUrl.TrimEnd('/')
    $script:SnHeaders = @{ Authorization = "Basic $token"; Accept = 'application/json' }
}

function Get-CtgServiceNowCase {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Number, [string]$Table = 'sn_customerservice_case')
    $uri = "$script:SnBase/api/now/table/$Table?sysparm_query=number=$Number&sysparm_limit=1"
    (Invoke-RestMethod -Uri $uri -Headers $script:SnHeaders).result | Select-Object -First 1
}

function ConvertTo-CtgOnboardingUser {
    <#
    .SYNOPSIS
        Normalize a case (and/or its catalog variables) into the user object the
        modules expect. Adjust the field map to your request item schema.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject]$Case, [Parameter(Mandatory)][string]$UsernamePattern, [Parameter(Mandatory)][string]$Domain)

    $first = $Case.u_first_name
    $last  = $Case.u_last_name
    $upn = $UsernamePattern.
        Replace('{first}', $first.ToLower()).
        Replace('{last}',  $last.ToLower()).
        Replace('{firstInitial}', $first.Substring(0,1).ToLower()).
        Replace('{domain}', $Domain)

    [pscustomobject]@{
        FirstName         = $first
        LastName          = $last
        DisplayName       = "$first $last"
        UserPrincipalName = $upn
        JobTitle          = $Case.u_title
        MobilePhone       = $Case.u_mobile_phone
        UsageLocation     = 'US'
    }
}

function New-CtgServiceNowContact {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [string]$Table = 'customer_contact')
    $body = @{
        first_name = $User.FirstName
        last_name  = $User.LastName
        email      = $User.UserPrincipalName
        phone      = $User.MobilePhone
        title      = $User.JobTitle
    } | ConvertTo-Json
    if ($PSCmdlet.ShouldProcess($User.UserPrincipalName, "Create ServiceNow contact")) {
        $r = Invoke-RestMethod -Method Post -Uri "$script:SnBase/api/now/table/$Table" `
            -Headers ($script:SnHeaders + @{ 'Content-Type' = 'application/json' }) -Body $body
        [pscustomobject]@{ System = 'servicenow-contact'; Status = 'ok'; Actions = @("created contact $($User.UserPrincipalName)"); SysId = $r.result.sys_id }
    }
}

function Add-CtgCaseWorkNote {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$CaseSysId, [Parameter(Mandatory)][string]$Note, [string]$Table = 'sn_customerservice_case')
    $body = @{ work_notes = $Note } | ConvertTo-Json
    Invoke-RestMethod -Method Patch -Uri "$script:SnBase/api/now/table/$Table/$CaseSysId" `
        -Headers ($script:SnHeaders + @{ 'Content-Type' = 'application/json' }) -Body $body | Out-Null
}

function Close-CtgCaseTasks {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$CaseSysId)
    # TODO: query child tasks (e.g. sc_task / catalog tasks) tied to the case and
    # patch state -> Closed Complete. Left as a stub: task table varies by instance.
    Write-Warning "Close-CtgCaseTasks: implement task query/closure for your instance."
    [pscustomobject]@{ System = 'case-resolution'; Status = 'pending'; Actions = @('task closure not yet implemented') }
}

Export-ModuleMember -Function Connect-CtgServiceNow, Get-CtgServiceNowCase, ConvertTo-CtgOnboardingUser, New-CtgServiceNowContact, Add-CtgCaseWorkNote, Close-CtgCaseTasks
