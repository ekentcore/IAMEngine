# What "Refresh AD objects from DC" enumerates.
#
# The bug this pins (case UM0029706, PureTech): discovery used Get-ADOrganizationalUnit, which returns
# ONLY organizationalUnit objects — never containers. PureTech has no user OU; its users live in the
# default CN=Users container, so the folder picker had nothing valid to offer and the operator was
# stuck. Invoke-CtgAdDiscovery must enumerate the WHOLE tree: OUs, containers, CN=Builtin, and the
# domain root — and report every DN in the `ous` field the app stores.
#
# Start-IamRunner.ps1 is not dot-sourceable (mandatory param block + main loop), so — like the
# AdConnection / AdobeSecret suites — we parse it as text and lift the one function under test.

BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    $script:Runner = Get-Content "$Root/Start-IamRunner.ps1" -Raw

    $fn = [regex]::Match($script:Runner, "(?ms)^function Invoke-CtgAdDiscovery\s*(\([^)]*\))?\s*\{.*?^\}")
    $fn.Success | Should -BeTrue -Because "Start-IamRunner.ps1 must declare Invoke-CtgAdDiscovery"
    . ([scriptblock]::Create($fn.Value))

    # The RSAT AD cmdlets and the runner's own Invoke-AppApi aren't installed in the test host, so stub
    # them globally — Pester can only Mock a command that already exists. Params mirror how the function
    # calls them (Get-ADObject -LDAPFilter …), so the mock can inspect what was passed.
    function global:Get-ADObject { [CmdletBinding()] param($LDAPFilter, $Filter, $Server, $Credential) }
    function global:Get-ADGroup { [CmdletBinding()] param($Filter, $Server, $Credential) }
    function global:Invoke-AppApi { param([string]$Method, [string]$Path, $Body) }
}

Describe "Invoke-CtgAdDiscovery" {
    BeforeEach {
        $script:posted = $null
        $script:capturedFilter = $null
        $AgentId = "agent-1"

        Mock Get-Module { [pscustomobject]@{ Name = "ActiveDirectory" } }
        Mock Get-ADObject {
            $script:capturedFilter = $LDAPFilter
            @(
                [pscustomobject]@{ DistinguishedName = "DC=ad,DC=x,DC=com" },
                [pscustomobject]@{ DistinguishedName = "CN=Users,DC=ad,DC=x,DC=com" },
                [pscustomobject]@{ DistinguishedName = "CN=Builtin,DC=ad,DC=x,DC=com" },
                [pscustomobject]@{ DistinguishedName = "OU=Servers,DC=ad,DC=x,DC=com" }
            )
        }
        Mock Get-ADGroup { @([pscustomobject]@{ Name = "Domain Admins" }) }
        Mock Invoke-AppApi { $script:posted = $Body }
        Mock Write-Host {}
    }

    It "queries every folder object class — OUs, containers, builtinDomain and the domain root" {
        Invoke-CtgAdDiscovery
        $script:capturedFilter | Should -Match "organizationalUnit"
        $script:capturedFilter | Should -Match "container"
        $script:capturedFilter | Should -Match "builtinDomain"
        $script:capturedFilter | Should -Match "domainDNS"
    }

    It "reports every discovered folder DN — containers as well as OUs — in the `ous` field" {
        Invoke-CtgAdDiscovery
        $script:posted.ous | Should -Contain "CN=Users,DC=ad,DC=x,DC=com"
        $script:posted.ous | Should -Contain "CN=Builtin,DC=ad,DC=x,DC=com"
        $script:posted.ous | Should -Contain "OU=Servers,DC=ad,DC=x,DC=com"
        $script:posted.ous | Should -Contain "DC=ad,DC=x,DC=com"
        @($script:posted.ous).Count | Should -Be 4
    }

    It "skips silently when the ActiveDirectory module is absent (no post)" {
        Mock Get-Module { $null }
        Mock Write-Warning {}
        Invoke-CtgAdDiscovery
        $script:posted | Should -BeNullOrEmpty
    }
}
