#Requires -Version 7.0

# Coretelligent.XMatters  (xMatters on-call/alerting — provision on onboard, remove on offboard)
#
# Onboard : CREATE the person as a Standard User. Identifiers follow Coretelligent's convention —
#           targetName (login id) = the email LOCAL PART (ekent), webLogin = the full email
#           (ekent@core.tech) — plus a Work Email device so they can be alerted. Idempotent: skips
#           if the person already exists.
# Offboard: DEACTIVATE (status=INACTIVE, reversible) by default, or DELETE when config.delete is set
#           (Coretelligent deletes). Idempotent — a no-op when the person is absent/already inactive.
#
# API (xMatters REST API v1, https://{company}.xmatters.com/api/xm/1):
#   Auth    : HTTP Basic. An xMatters API KEY + SECRET (key = username, secret = password) or a REST
#             web-service user's username/password.
#   Get     : GET    /people/{idOrTargetName}            -> the person (404 -> absent)
#   Search  : GET    /people?search={text}               -> { data: [ person… ] }
#   Create  : POST   /people  { recipientType:'PERSON', targetName, firstName, lastName, webLogin,
#                               roles:[name], site, language }
#   Device  : POST   /devices { recipientType:'DEVICE', deviceType:'EMAIL', name, owner, emailAddress }
#   Disable : POST   /people  { id, status:'INACTIVE' }  (xMatters updates a person by POSTing its id)
#   Delete  : DELETE /people/{id}

Set-StrictMode -Version Latest

$script:XmBaseUrl = $null
$script:XmAuth    = $null

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Connect-CtgXMatters {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$BaseUrl,           # https://{company}.xmatters.com (with or without /api/xm/1)
        [Parameter(Mandatory)][pscredential]$Credential   # API key + secret, or a REST web-service user
    )
    $u = $BaseUrl.Trim().TrimEnd('/')
    if ($u -notmatch '^https?://') { $u = "https://$u" }
    if ($u -notmatch '/api/xm/v?\d+$') { $u = "$u/api/xm/1" }
    $script:XmBaseUrl = $u
    $pair = "$($Credential.UserName):$(ConvertFrom-SecureString $Credential.Password -AsPlainText)"
    $script:XmAuth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
}

function Invoke-CtgXMattersApi {
    # Single HTTP seam (mocked in tests). HTTP Basic. Never logs the credential.
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Method, [Parameter(Mandatory)][string]$Path, $Body)
    if (-not $script:XmAuth) { throw "Call Connect-CtgXMatters first." }
    $p = @{
        Method      = $Method
        Uri         = "$script:XmBaseUrl$Path"
        Headers     = @{ Authorization = $script:XmAuth; Accept = 'application/json' }
        ContentType = 'application/json'
    }
    if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 8) }
    try { Invoke-RestMethod @p }
    catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { ([string]$_.ErrorDetails.Message).Trim() } else { $null }
        if ($detail -and $detail.Length -gt 400) { $detail = $detail.Substring(0, 400) + '…' }
        $what = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        throw "xMatters API: $Method $($p.Uri) -> $what$(if ($detail) { " — $detail" })"
    }
}

# The departing/new user's email from any of the case's email-ish fields ('' when none).
function Resolve-CtgXMattersEmail {
    param([pscustomobject]$User)
    foreach ($k in 'UserPrincipalName', 'email', 'Email', 'mail', 'Mail', 'EmailAddress', 'PrimarySmtpAddress', 'userPrincipalName') {
        $v = [string](Get-CtgProp $User $k)
        if (-not [string]::IsNullOrWhiteSpace($v)) { return $v.Trim() }
    }
    return ''
}

# Coretelligent convention: the xMatters login id (targetName) is the email LOCAL PART.
function ConvertTo-CtgXMattersTargetName { param([string]$Email) (([string]$Email) -split '@', 2)[0].Trim() }

# First/last name from the case (explicit fields, else split the display name).
function Resolve-CtgXMattersName {
    param([pscustomobject]$User)
    $first = [string]((Get-CtgProp $User 'FirstName') ?? (Get-CtgProp $User 'firstName') ?? (Get-CtgProp $User 'GivenName'))
    $last = [string]((Get-CtgProp $User 'LastName') ?? (Get-CtgProp $User 'lastName') ?? (Get-CtgProp $User 'Surname'))
    if (-not $first -and -not $last) {
        $dn = [string]((Get-CtgProp $User 'DisplayName') ?? (Get-CtgProp $User 'displayName') ?? (Get-CtgProp $User 'userToOffboard'))
        if ($dn) { $parts = ($dn.Trim() -split '\s+', 2); $first = $parts[0]; if ($parts.Count -gt 1) { $last = $parts[1] } }
    }
    @{ First = ([string]$first).Trim(); Last = ([string]$last).Trim() }
}

function Get-CtgXMattersPerson {
    # GET /people/{idOrTargetName} -> the person object, or $null on 404 (absent).
    param([Parameter(Mandatory)][string]$Id)
    try { Invoke-CtgXMattersApi -Method GET -Path "/people/$([uri]::EscapeDataString($Id))?embed=roles" }
    catch { if ($_.Exception.Message -match '\b404\b|not found') { return $null }; throw }
}

# Find people whose "first last" matches a display name (xMatters has no exact-name filter, so search
# then match). Returns ALL matches so a caller can refuse on ambiguity.
function Find-CtgXMattersByName {
    param([Parameter(Mandatory)][string]$DisplayName)
    $needle = (($DisplayName -replace '\s+', ' ').Trim()).ToLower()
    $hits = [System.Collections.Generic.List[object]]::new()
    if (-not $needle) { return $hits.ToArray() }
    $resp = Invoke-CtgXMattersApi -Method GET -Path "/people?search=$([uri]::EscapeDataString($DisplayName))"
    foreach ($p in @(Get-CtgProp $resp 'data')) {
        $full = ((("$([string](Get-CtgProp $p 'firstName')) $([string](Get-CtgProp $p 'lastName'))")) -replace '\s+', ' ').Trim().ToLower()
        if ($full -eq $needle) { $hits.Add($p) }
    }
    return $hits.ToArray()
}

# Resolve an EXISTING xMatters person for offboard: by targetName (email local part) FIRST, else by
# display name. Returns @{ Person; MatchCount; DisplayName }.
function Resolve-CtgXMattersTarget {
    param([pscustomobject]$User)
    $email = Resolve-CtgXMattersEmail $User
    if ($email) {
        $p = Get-CtgXMattersPerson -Id (ConvertTo-CtgXMattersTargetName $email)
        if ($p) { return @{ Person = $p; MatchCount = 1; DisplayName = '' } }
    }
    $dn = [string]((Get-CtgProp $User 'DisplayName') ?? (Get-CtgProp $User 'displayName') ?? (Get-CtgProp $User 'userToOffboard'))
    if (-not $dn) { return @{ Person = $null; MatchCount = 0; DisplayName = '' } }
    $hits = @(Find-CtgXMattersByName -DisplayName $dn)
    if ($hits.Count -eq 1) { return @{ Person = $hits[0]; MatchCount = 1; DisplayName = $dn } }
    return @{ Person = $null; MatchCount = $hits.Count; DisplayName = $dn }
}

function Invoke-CtgXMattersOnboarding {
    <#
    .SYNOPSIS
        Create the xMatters person as a Standard User (idempotent). targetName = email local part,
        webLogin = full email, plus a Work Email device. Config: role (default 'Standard User'),
        site (default 'Default Site'), addEmailDevice (default $true).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()

    $email = Resolve-CtgXMattersEmail $User
    if (-not $email) {
        $actions.Add("WARN no email/UPN on the case — can't provision the xMatters person. Set the user's email and re-run. Nothing done.")
        return [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = ''; Actions = $actions.ToArray() }
    }
    $targetName = ConvertTo-CtgXMattersTargetName $email

    if (Get-CtgXMattersPerson -Id $targetName) {
        $actions.Add("xMatters person already exists: $targetName ($email) — no change")
        return [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }

    $name = Resolve-CtgXMattersName $User
    if (-not $name.First -or -not $name.Last) {
        $actions.Add("WARN can't create the xMatters person — need a first AND last name (have first='$($name.First)', last='$($name.Last)'). Nothing done.")
        return [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
    }
    $role = [string](Get-CtgProp $Config 'role'); if (-not $role) { $role = 'Standard User' }
    $site = [string](Get-CtgProp $Config 'site'); if (-not $site) { $site = 'Default Site' }

    if ($PSCmdlet.ShouldProcess($targetName, "Create xMatters person ($role)")) {
        $body = @{
            recipientType = 'PERSON'
            targetName    = $targetName
            firstName     = $name.First
            lastName      = $name.Last
            webLogin      = $email
            roles         = @($role)
            site          = $site
            language      = 'en'
        }
        $created = Invoke-CtgXMattersApi -Method POST -Path '/people' -Body $body
        $personId = [string](Get-CtgProp $created 'id')
        $actions.Add("created xMatters person: $targetName (webLogin $email), role '$role', site '$site'")

        # Work Email device so the person can actually be alerted (best-effort — don't fail onboard).
        if ((Get-CtgProp $Config 'addEmailDevice') -ne $false) {
            if ($PSCmdlet.ShouldProcess($targetName, "Add Work Email device")) {
                $owner = if ($personId) { $personId } else { $targetName }
                try {
                    Invoke-CtgXMattersApi -Method POST -Path '/devices' -Body @{
                        recipientType = 'DEVICE'; deviceType = 'EMAIL'; name = 'Work Email'; owner = $owner; emailAddress = $email
                    } | Out-Null
                    $actions.Add("added Work Email device: $email")
                }
                catch { $actions.Add("WARN could not add the Work Email device ($email): $($_.Exception.Message)") }
            }
        }
    }
    [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = $email; Actions = $actions.ToArray() }
}

function Invoke-CtgXMattersOffboarding {
    <#
    .SYNOPSIS
        Remove the departed user from xMatters. DEACTIVATE (status=INACTIVE) by default; DELETE when
        config.delete is set. Resolves by targetName (email local part), else display name.
        Idempotent — a no-op when the person is absent or already inactive.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    $actions = [System.Collections.Generic.List[string]]::new()

    $t = Resolve-CtgXMattersTarget $User
    if (-not $t.Person) {
        $actions.Add($(if ($t.MatchCount -gt 1) { "WARN $($t.MatchCount) xMatters people match display name '$($t.DisplayName)' — set the exact email on the case. Nothing done." }
                else { "xMatters person not found$(if ($t.DisplayName) { " for display name '$($t.DisplayName)'" }) — nothing to remove" }))
        return [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = ''; Actions = $actions.ToArray() }
    }
    $person = $t.Person
    $id = [string](Get-CtgProp $person 'id')
    $tn = [string](Get-CtgProp $person 'targetName')

    if (Get-CtgProp $Config 'delete') {
        if ($PSCmdlet.ShouldProcess($tn, "Delete xMatters person")) {
            Invoke-CtgXMattersApi -Method DELETE -Path "/people/$id" | Out-Null
            $actions.Add("deleted xMatters person: $tn")
        }
    }
    elseif (([string](Get-CtgProp $person 'status')).ToUpper() -eq 'INACTIVE') {
        $actions.Add("xMatters person already inactive: $tn — no change")
    }
    elseif ($PSCmdlet.ShouldProcess($tn, "Deactivate xMatters person")) {
        Invoke-CtgXMattersApi -Method POST -Path '/people' -Body @{ id = $id; status = 'INACTIVE' } | Out-Null
        $actions.Add("deactivated xMatters person: $tn")
    }

    [pscustomobject]@{ System = 'xmatters'; Status = 'ok'; Email = $tn; Actions = $actions.ToArray() }
}

function Confirm-CtgXMatters {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    if ($Action -eq 'onboard') {
        $email = Resolve-CtgXMattersEmail $User
        if (-not $email) { return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'no email on the case — nothing to verify'; expected = $true; actual = $true; pass = $true }) } }
        $present = [bool](Get-CtgXMattersPerson -Id (ConvertTo-CtgXMattersTargetName $email))
        return [pscustomobject]@{ ok = $present; checks = @(@{ name = 'xMatters person present'; expected = $true; actual = $present; pass = $present }) }
    }
    $t = Resolve-CtgXMattersTarget $User
    if (-not $t.Person) {
        return [pscustomobject]@{ ok = $true; checks = @(@{ name = 'xMatters person absent — removed'; expected = $true; actual = $true; pass = $true }) }
    }
    # A delete leaves no person; a deactivate leaves status INACTIVE.
    $gone = ([string](Get-CtgProp $t.Person 'status')).ToUpper() -eq 'INACTIVE'
    [pscustomobject]@{ ok = $gone; checks = @(@{ name = 'xMatters person removed/inactive'; expected = $true; actual = $gone; pass = $gone }) }
}

Export-ModuleMember -Function Connect-CtgXMatters, Invoke-CtgXMattersApi, Resolve-CtgXMattersEmail, ConvertTo-CtgXMattersTargetName, Get-CtgXMattersPerson, Find-CtgXMattersByName, Resolve-CtgXMattersTarget, Invoke-CtgXMattersOnboarding, Invoke-CtgXMattersOffboarding, Confirm-CtgXMatters
