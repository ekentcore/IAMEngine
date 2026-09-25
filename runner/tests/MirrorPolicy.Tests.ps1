# FR #0000119: LogicSource wants only SECURITY groups mirrored from a reference user, and the ChatGPT
# group never mirrored (it grants a paid app seat per member). A client mirror policy on the job config:
#   mirrorPolicy = @{ securityOnly = $true; exclude = @('ChatGPT*') }
# The same Get-CtgMirrorSkipReason lives in the three modules that mirror (AD, M365, Exchange) so a
# group held back in one lane isn't copied by another.
BeforeAll {
    $Root = Split-Path $PSScriptRoot -Parent
    # Thin stubs for the cmdlets mocked below (the real Graph/AD modules aren't on a test host), and the
    # .psm1 directly — the same way the per-module test files load them.
    function global:Get-MgUserMemberOf { param($UserId, [switch]$All) }
    foreach ($m in 'ActiveDirectory', 'M365', 'Exchange') {
        Import-Module "$Root/modules/Coretelligent.$m/Coretelligent.$m.psm1" -Force -DisableNameChecking -ErrorAction Stop
    }
    $script:Policy = [pscustomobject]@{ securityOnly = $true; exclude = @('ChatGPT*') }
}

AfterAll {
    foreach ($m in 'ActiveDirectory', 'M365', 'Exchange') { Remove-Module "Coretelligent.$m" -Force -ErrorAction SilentlyContinue }
}

Describe 'Get-CtgMirrorSkipReason — the same rule in AD, M365 and Exchange' {
    BeforeAll {
        $script:Mods = @('Coretelligent.ActiveDirectory', 'Coretelligent.M365', 'Coretelligent.Exchange')
        $script:Ask = { param($Mod, $Policy, $Name, $IsSecurity) & (Get-Module $Mod) { param($P, $N, $S) Get-CtgMirrorSkipReason -Policy $P -Name $N -IsSecurity $S } $Policy $Name $IsSecurity }
    }
    It 'mirrors everything when there is no policy' {
        foreach ($m in $script:Mods) { & $script:Ask $m $null 'ChatGPT Users' $false | Should -BeNullOrEmpty -Because $m }
    }
    It 'holds back an excluded group by wildcard, case-insensitively, even when it is a security group' {
        foreach ($m in $script:Mods) { & $script:Ask $m $script:Policy 'chatgpt enterprise' $true | Should -Match 'excluded' -Because $m }
    }
    It 'holds back a non-security group when securityOnly is set' {
        foreach ($m in $script:Mods) { & $script:Ask $m $script:Policy 'All Staff DL' $false | Should -Match 'security groups only' -Because $m }
    }
    It 'mirrors a security group that is not excluded' {
        foreach ($m in $script:Mods) { & $script:Ask $m $script:Policy 'Finance-RW' $true | Should -BeNullOrEmpty -Because $m }
    }
    It 'with only an exclude list, still mirrors non-security groups' {
        $p = [pscustomobject]@{ exclude = @('ChatGPT*') }
        foreach ($m in $script:Mods) { & $script:Ask $m $p 'All Staff DL' $false | Should -BeNullOrEmpty -Because $m }
    }
}

Describe 'Invoke-CtgM365CloudMirror with a policy' {
    It 'copies the security group, holds back ChatGPT and the Microsoft 365 group, and says why' {
        InModuleScope Coretelligent.M365 -Parameters @{ P = $script:Policy } {
            param($P)
            Mock Write-CtgM365Step { }
            Mock Resolve-CtgEntraUser { [pscustomobject]@{ Id = 'ref'; UserPrincipalName = 'ref@x.com' } }
            Mock Get-MgUserMemberOf -ParameterFilter { $UserId -eq 'ref' } {
                @(
                    [pscustomobject]@{ Id = 'g1'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Finance-RW'; securityEnabled = $true; mailEnabled = $false; groupTypes = @() } }
                    [pscustomobject]@{ Id = 'g2'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'ChatGPT Enterprise'; securityEnabled = $true; mailEnabled = $false; groupTypes = @() } }
                    [pscustomobject]@{ Id = 'g3'; AdditionalProperties = @{ '@odata.type' = '#microsoft.graph.group'; displayName = 'Marketing Team'; securityEnabled = $true; mailEnabled = $true; groupTypes = @('Unified') } }
                )
            }
            Mock Get-MgUserMemberOf -ParameterFilter { $UserId -eq 'new' } { @() }
            Mock Add-CtgGroupMember { $null }
            $actions = Invoke-CtgM365CloudMirror -MirrorUser 'ref@x.com' -UserId 'new' -Policy $P
            Should -Invoke Add-CtgGroupMember -Times 1 -Exactly -ParameterFilter { $GroupId -eq 'g1' }
            Should -Invoke Add-CtgGroupMember -Times 0 -Exactly -ParameterFilter { $GroupId -in @('g2', 'g3') }
            ($actions -join "`n") | Should -Match 'not mirrored: ChatGPT Enterprise — excluded'
            ($actions -join "`n") | Should -Match 'not mirrored: Marketing Team — not a security group'
        }
    }
}
