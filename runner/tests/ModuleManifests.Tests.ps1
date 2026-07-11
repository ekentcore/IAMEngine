#Requires -Modules @{ ModuleName='Pester'; ModuleVersion='5.0.0' }
# Manifest drift guard. The runner imports every Coretelligent.* module via its .psd1, and a
# manifest's FunctionsToExport FILTERS whatever the .psm1's Export-ModuleMember says — a function
# added to the module but not to the manifest loads fine yet is invisible at execution time
# ("Invoke-CtgADEmailWriteback isn't loaded on this host", INC0858516). Unit tests import the
# .psm1 directly, so only this test sees the manifest the way production does.

BeforeDiscovery {
    $script:ModuleDirs = Get-ChildItem "$PSScriptRoot/../modules" -Directory | Where-Object {
        (Test-Path "$($_.FullName)/$($_.Name).psd1") -and (Test-Path "$($_.FullName)/$($_.Name).psm1")
    } | ForEach-Object { @{ Name = $_.Name; Dir = $_.FullName } }
}

Describe 'module manifest <Name>' -ForEach $script:ModuleDirs {
    BeforeAll {
        $psd1 = Import-PowerShellDataFile "$Dir/$Name.psd1"
        $ast = [System.Management.Automation.Language.Parser]::ParseFile("$Dir/$Name.psm1", [ref]$null, [ref]$null)

        # Function names Export-ModuleMember publishes — both the bare comma list and @() array
        # forms show up as StringConstantExpressionAst arguments under the CommandAst.
        $emm = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Export-ModuleMember' }, $true)
        $exported = @($emm | ForEach-Object {
            $_.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true) |
                ForEach-Object Value | Where-Object { $_ -ne 'Export-ModuleMember' }
        })

        $defined = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object Name)
        $manifest = @($psd1.FunctionsToExport)
    }

    It 'lists every Export-ModuleMember function in FunctionsToExport' {
        $missing = @($exported | Where-Object { $_ -notin $manifest })
        $missing | Should -BeNullOrEmpty -Because "the manifest filters exports; these functions would be invisible in production: $($missing -join ', ')"
    }

    It 'only lists functions that exist in the psm1' {
        $stale = @($manifest | Where-Object { $_ -notin $defined })
        $stale | Should -BeNullOrEmpty -Because "FunctionsToExport names functions the module no longer defines: $($stale -join ', ')"
    }
}
