@{
    RootModule        = 'Coretelligent.Slack.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b3d1e7a4-9f28-4c65-8a10-2e5c7b4d9f31'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Slack user lifecycle via the SCIM API (deactivate on offboard, never delete). No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgSlack', 'Invoke-CtgSlackScim', 'Test-CtgSlackNoScim', 'Find-CtgSlackUser', 'Test-CtgSlackActive', 'Invoke-CtgSlackOnboarding', 'Invoke-CtgSlackOffboarding', 'Confirm-CtgSlack', 'Resolve-CtgSlackConsoleLogin', 'Invoke-CtgSlackConsoleSetup')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
