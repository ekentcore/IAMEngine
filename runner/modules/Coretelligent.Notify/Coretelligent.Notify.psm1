#Requires -Version 7.0

# Coretelligent.Notify  (offboard notifications via Microsoft Graph sendMail)
# Sends the two emails the offboard script used to send, but from the central runner using the
# m365-admin app (the internal smtp.coretelligent.com relay isn't reachable centrally):
#   1. a COMMUNICATION email to the offboarding distribution list — subject "Offboarding (full name)",
#      body the "please remove from any apps you manage" courtesy reminder.
#   2. a CASE-NOTE email to internalsupport@core.tech with "RE: <INC#> …" in the subject; ServiceNow's
#      inbound email action matches the INC# and appends the body as a work note (no SN API write — works
#      despite the read-only SN key; retire this once a write-capable SN account exists).
# Onboarding is a no-op. Sends only on offboard. Relies on the ambient Microsoft.Graph context that the
# m365 Connect established (Send-MgUserMail uses the process-wide Mg session).
#
# NOTE: email send is not idempotent (each run sends). The offboard notify step runs once per case at
# the end of the run; a re-run would re-send — acceptable for a courtesy notice, but keep it last.

Set-StrictMode -Version Latest

function Get-CtgProp {
    param($Object, [Parameter(Mandatory)][string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $p = $Object.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Expand-CtgNoticeTemplate {
    # Substitute {fullName} / {department} / {caseNumber} tokens. Pure — unit-testable.
    param([string]$Template, [hashtable]$Values)
    $out = [string]$Template
    foreach ($k in $Values.Keys) { $out = $out -replace ("\{" + [regex]::Escape($k) + "\}"), [string]$Values[$k] }
    $out
}

function Send-CtgGraphMail {
    # Single send seam (mocked in tests). Wraps Send-MgUserMail with a plain-text body.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)][string[]]$To,
        [Parameter(Mandatory)][string]$Subject,
        [Parameter(Mandatory)][string]$Body
    )
    $toRecipients = @($To | Where-Object { $_ } | ForEach-Object { @{ emailAddress = @{ address = $_ } } })
    $params = @{
        message = @{
            subject       = $Subject
            body          = @{ contentType = 'Text'; content = $Body }
            toRecipients  = $toRecipients
        }
        saveToSentItems = $true
    }
    Send-MgUserMail -UserId $From -BodyParameter $params -ErrorAction Stop
}

function Invoke-CtgNotifyOnboarding {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)
    [pscustomobject]@{ System = 'notify'; Status = 'ok'; Actions = @("no onboard notification configured — nothing to send") }
}

function Invoke-CtgNotifyOffboarding {
    <#
    .SYNOPSIS
        Send the offboard Communication email (to the offboarding list) and the ServiceNow case-note
        email (to internalsupport@core.tech with "RE: INC..." so it threads). Each is independent and
        best-effort: a failed send WARNs but does not fail the step (the offboard work already happened).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][pscustomobject]$User, [Parameter(Mandatory)][pscustomobject]$Config)

    $actions = [System.Collections.Generic.List[string]]::new()

    $sender = [string]((Get-CtgProp $Config 'sender') ?? (Get-CtgProp $Config 'from'))
    if (-not $sender) {
        $actions.Add("WARN no sender mailbox configured (notify.sender) — no offboard email sent")
        return [pscustomobject]@{ System = 'notify'; Status = 'ok'; Actions = $actions.ToArray() }
    }

    $fullName   = [string]((Get-CtgProp $User 'DisplayName') ?? (Get-CtgProp $User 'FullName') ?? "$((Get-CtgProp $User 'FirstName')) $((Get-CtgProp $User 'LastName'))").Trim()
    $department = [string]((Get-CtgProp $User 'Department') ?? (Get-CtgProp $Config 'department'))
    $caseNumber = [string]((Get-CtgProp $User 'CaseNumber') ?? (Get-CtgProp $Config 'caseNumber'))
    $tokens = @{ fullName = $fullName; department = $department; caseNumber = $caseNumber }

    # 1. Communication email to the offboarding distribution list.
    $recipients = @(Get-CtgProp $Config 'recipients' | Where-Object { $_ })
    if ($recipients.Count) {
        $subject = Expand-CtgNoticeTemplate ([string]((Get-CtgProp $Config 'subjectTemplate') ?? 'Offboarding ({fullName})')) $tokens
        $body    = Expand-CtgNoticeTemplate ([string]((Get-CtgProp $Config 'bodyTemplate') ?? 'Hello! Just a reminder to please remove {fullName} ({department}) from any applications that you manage.')) $tokens
        if ($PSCmdlet.ShouldProcess(($recipients -join ', '), "Send offboard communication email")) {
            try {
                Send-CtgGraphMail -From $sender -To $recipients -Subject $subject -Body $body
                $actions.Add("sent offboard communication email to $($recipients.Count) recipient(s)")
            }
            catch { $actions.Add("WARN could not send communication email: $($_.Exception.Message)") }
        }
    }
    else {
        $actions.Add("no recipients configured (notify.recipients) — communication email skipped")
    }

    # 2. ServiceNow case-note email (RE: <INC#> so the inbound email action threads it).
    $caseNoteAddr = [string]((Get-CtgProp $Config 'caseNoteAddress') ?? 'internalsupport@core.tech')
    if ($caseNumber -and (Get-CtgProp $Config 'postCaseNote') -ne $false) {
        $noteSubject = "RE: $caseNumber Offboarding $fullName"
        $deptSuffix = if ($department) { " ($department)" } else { '' }
        $noteBody = [string]((Get-CtgProp $Config 'caseNoteBody') ?? "Offboarding automation completed for $fullName$deptSuffix. See the run report for the per-step result.")
        if ($PSCmdlet.ShouldProcess($caseNoteAddr, "Email case note for $caseNumber")) {
            try {
                Send-CtgGraphMail -From $sender -To @($caseNoteAddr) -Subject $noteSubject -Body $noteBody
                $actions.Add("emailed case note to $caseNoteAddr (RE: $caseNumber)")
            }
            catch { $actions.Add("WARN could not email case note: $($_.Exception.Message)") }
        }
    }
    elseif (-not $caseNumber) {
        $actions.Add("no case number on the job — case-note email skipped")
    }

    [pscustomobject]@{ System = 'notify'; Status = 'ok'; Actions = $actions.ToArray() }
}

function Confirm-CtgNotify {
    # No read-back for a fire-and-forget notification — always passes.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][pscustomobject]$User,
        [Parameter(Mandatory)][pscustomobject]$Config,
        [Parameter(Mandatory)][ValidateSet('onboard', 'offboard')][string]$Action
    )
    [pscustomobject]@{ ok = $true; checks = @(@{ name = 'notification is fire-and-forget — nothing to verify'; expected = $true; actual = $true; pass = $true }) }
}

Export-ModuleMember -Function Get-CtgProp, Expand-CtgNoticeTemplate, Send-CtgGraphMail, Invoke-CtgNotifyOnboarding, Invoke-CtgNotifyOffboarding, Confirm-CtgNotify
