@{
    RootModule        = 'Coretelligent.Perimeter81.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'c0b8e9fb-7e2a-4b3c-bfd4-8f9012345678'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Perimeter 81 / Check Point Harmony SASE user lifecycle (group-driven onboard, find-then-remove offboard). Endpoint paths are best-effort and must be verified on the tenant.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgPerimeter81', 'Invoke-CtgP81Api', 'Find-CtgP81User', 'Invoke-CtgPerimeter81Onboarding', 'Invoke-CtgPerimeter81Offboarding')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
