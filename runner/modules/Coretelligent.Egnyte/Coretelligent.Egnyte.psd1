@{
    RootModule        = 'Coretelligent.Egnyte.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'e8f1a2b3-4c5d-4e6f-8a9b-0c1d2e3f4a5b'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Egnyte user lifecycle via the User Management API v2: create with the configured license tier (power/standard/admin) on onboard; deactivate (retention-safe) or delete on offboard. OAuth2 bearer (long-lived token, or password grant from API key + service account).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgEgnyte', 'Invoke-CtgEgnyteApi', 'Find-CtgEgnyteUser', 'Invoke-CtgEgnyteOnboarding', 'Invoke-CtgEgnyteOffboarding', 'Confirm-CtgEgnyte', 'Resolve-CtgEgnyteConsoleLogin', 'Invoke-CtgEgnyteConsoleSetup')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
