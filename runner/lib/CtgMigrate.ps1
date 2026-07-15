# Pure helpers for app-URL self-migration: rewrite the -AppUrl value inside a supervisor definition
# (Scheduled Task argument string / systemd ExecStart line / launchd plist). No OS calls here so they
# are Pester-unit-testable; the OS-touching Invoke-CtgMigrate lives in Start-IamRunner.ps1 and calls
# these. Dot-sourced by Start-IamRunner.ps1 and by tests/CtgMigrate.Tests.ps1.

function Set-CtgAppUrlInArgString {
  # Replace the value following -AppUrl (quoted or bare) with a quoted new URL. Leaves every other arg
  # intact. Idempotent: re-running with the same new URL yields the same string. Used for the Windows
  # Scheduled Task argument string and the systemd ExecStart line.
  param([Parameter(Mandatory)][string]$ArgString, [Parameter(Mandatory)][string]$NewUrl)
  $repl = '-AppUrl "' + $NewUrl + '"'
  # Match -AppUrl then either a "double-quoted" value or a bare (whitespace-delimited) token.
  return [regex]::Replace($ArgString, '-AppUrl\s+("[^"]*"|\S+)', $repl)
}

function Set-CtgAppUrlInPlist {
  # In a launchd plist's ProgramArguments the value is the <string> element immediately AFTER the
  # <string>-AppUrl</string> element. Replace only that one (XML-escape the new URL).
  param([Parameter(Mandatory)][string]$PlistXml, [Parameter(Mandatory)][string]$NewUrl)
  $pattern = '(<string>-AppUrl</string>\s*<string>)[^<]*(</string>)'
  return [regex]::Replace($PlistXml, $pattern, ('${1}' + [System.Security.SecurityElement]::Escape($NewUrl) + '${2}'))
}
