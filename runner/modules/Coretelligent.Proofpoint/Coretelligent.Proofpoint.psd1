@{
    RootModule        = 'Coretelligent.Proofpoint.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b2c4e6a8-1d3f-4b5c-8e7a-9f0a1b2c3d4e'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Proofpoint Essentials API (read-only): verify whether a user has synced in from Azure AD / Entra ID. Reads Azure sync settings, last successful sync, exemptions, and the user record, and returns a clear status object. No on-demand sync trigger exists, so onboarding verifies-and-waits (auto-retry until the scheduled sync imports the user). X-User / X-Password admin auth.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Get-CtgProp', 'Connect-CtgProofpoint', 'Invoke-CtgProofpointApi', 'Get-CtgProofpointAzureSync', 'Get-CtgProofpointExemptions', 'Find-CtgProofpointUser', 'Get-CtgProofpointSyncStatus', 'Invoke-CtgProofpointOnboarding', 'Invoke-CtgProofpointOffboarding', 'Confirm-CtgProofpoint')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
