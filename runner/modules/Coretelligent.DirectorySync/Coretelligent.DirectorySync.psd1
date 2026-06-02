@{
    RootModule        = 'Coretelligent.DirectorySync.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'e6d4a5b7-3a8c-4d9e-bf0a-4b5c6d7e8f90'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Triggers an Azure AD Connect delta sync after on-prem AD changes (ADSync ships with Azure AD Connect; runs on the AAD Connect host).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Invoke-CtgDirectorySync')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
