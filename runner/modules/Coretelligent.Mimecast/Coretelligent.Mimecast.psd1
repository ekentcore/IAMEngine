@{
    RootModule        = 'Coretelligent.Mimecast.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'd5c3f4e6-2f7a-4c8d-ae9f-3a4b5c6d7e8f'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Mimecast email-security lifecycle via the Mimecast 2.0 API (OAuth2 client-credentials; classic data/fail envelope): directory sync trigger, user visibility check, optional Internal Directory cloud-user creation, group removals on offboard.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgMimecast', 'Invoke-CtgMimecastApi', 'Get-CtgMimecastProfile', 'Test-CtgMimecastPermissionForbidden', 'Find-CtgMimecastGroup', 'Invoke-CtgMimecastOnboarding', 'Invoke-CtgMimecastOffboarding', 'Confirm-CtgMimecast', 'Resolve-CtgMimecastConsoleLogin', 'Invoke-CtgMimecastConsoleSetup')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
