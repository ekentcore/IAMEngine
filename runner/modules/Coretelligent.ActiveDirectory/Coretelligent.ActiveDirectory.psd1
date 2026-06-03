@{
    RootModule        = 'Coretelligent.ActiveDirectory.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'c4b2e3d5-1e6f-4b7c-9d8e-2f3a4b5c6d7e'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent on-prem Active Directory onboarding/offboarding for the client onboarding engine. Runs on the client-network agent.'
    PowerShellVersion = '7.0'

    # The on-prem AD cmdlets (RSAT). Present on the client agent host, not the central runner.
    RequiredModules   = @('ActiveDirectory')

    FunctionsToExport = @('Invoke-CtgADOnboarding', 'Invoke-CtgADOffboarding', 'Set-CtgADAttributes', 'Test-CtgCondition', 'Resolve-CtgOuPath', 'Confirm-CtgAD')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
