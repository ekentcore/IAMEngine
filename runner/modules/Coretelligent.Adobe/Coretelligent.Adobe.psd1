@{
    RootModule        = 'Coretelligent.Adobe.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b9a7d8ea-6d1f-4a2b-bfc3-7e8f90123456'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Adobe entitlement lifecycle via the User Management API (UMAPI) v2. No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgAdobe', 'Invoke-CtgAdobeAction', 'Invoke-CtgAdobeOnboarding', 'Invoke-CtgAdobeOffboarding', 'Get-CtgAdobeUser', 'Confirm-CtgAdobe')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
