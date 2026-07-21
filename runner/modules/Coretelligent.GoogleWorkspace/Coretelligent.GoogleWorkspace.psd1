@{
    RootModule        = 'Coretelligent.GoogleWorkspace.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b3d1e4f2-7a9c-4d6e-9f0b-2c4e6a8d0123'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Google Workspace user lifecycle via the Admin SDK Directory API. Offboard suspends (never deletes) and captures evidence. No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgGoogle', 'Get-CtgGoogleSessionScopes', 'Invoke-CtgGoogleApi', 'Get-CtgGoogleUser', 'Get-CtgGoogleUserGroups', 'Invoke-CtgGoogleOnboarding', 'Invoke-CtgGoogleOffboarding', 'Confirm-CtgGoogle', 'Invoke-CtgGooglePasswordReset', 'Invoke-CtgGoogleChange', 'Invoke-CtgGoogleOAuthSignin', 'Invoke-CtgGoogleDwdGrant')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
