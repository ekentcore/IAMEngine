@{
    RootModule        = 'Coretelligent.Spanning.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'd5e7a1c2-3b4f-4a6d-9c8e-1f2a3b4c5d6e'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Spanning Backup for Microsoft 365 user lifecycle: assign a Standard backup license on onboard; retain backups and swap to the Archive license on offboard. HTTP Basic (domain:access-token), region-scoped host.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgSpanning', 'Invoke-CtgSpanningApi', 'Test-CtgSpanning404', 'Test-CtgSpanningSeatError', 'Find-CtgSpanningUser', 'Set-CtgSpanningLicense', 'Invoke-CtgSpanningOnboarding', 'Invoke-CtgSpanningOffboarding', 'Confirm-CtgSpanning')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
