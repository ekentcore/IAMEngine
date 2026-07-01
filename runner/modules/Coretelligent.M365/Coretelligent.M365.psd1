@{
    RootModule        = 'Coretelligent.M365.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b3a1f2c4-0d5e-4a6b-8c7d-1e2f3a4b5c6d'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Microsoft 365 onboarding actions for the client onboarding engine.'
    PowerShellVersion = '7.0'

    # Pin the Graph submodules actually used so re-runs are reproducible.
    RequiredModules   = @(
        @{ ModuleName = 'Microsoft.Graph.Authentication'; ModuleVersion = '2.0.0' },
        @{ ModuleName = 'Microsoft.Graph.Users';          ModuleVersion = '2.0.0' },
        @{ ModuleName = 'Microsoft.Graph.Users.Actions';  ModuleVersion = '2.0.0' },
        @{ ModuleName = 'Microsoft.Graph.Groups';         ModuleVersion = '2.0.0' }
    )

    FunctionsToExport = @('Connect-CtgM365', 'New-CtgCompliantPassword', 'Resolve-CtgSkuId', 'Set-CtgSeatAwareLicense', 'Invoke-CtgM365CloudMirror', 'Invoke-CtgM365Onboarding', 'Invoke-CtgM365Offboarding', 'Confirm-CtgM365', 'Invoke-CtgEntraTap')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
