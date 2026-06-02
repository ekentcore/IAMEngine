@{
    RootModule        = 'Coretelligent.Mimecast.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'd5c3f4e6-2f7a-4c8d-ae9f-3a4b5c6d7e8f'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Mimecast email-security lifecycle via the Mimecast 2.0 API (cloud-gateway). No external module dependencies (uses Invoke-RestMethod).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgMimecast', 'Invoke-CtgMimecastApi', 'Invoke-CtgMimecastOnboarding', 'Invoke-CtgMimecastOffboarding', 'Confirm-CtgMimecast')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
