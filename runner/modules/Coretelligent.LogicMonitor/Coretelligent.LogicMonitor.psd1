@{
    RootModule        = 'Coretelligent.LogicMonitor.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'bf627331-1a08-4b2e-a00c-3d37f0780ce0'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'LogicMonitor offboarding: suspend (default) or delete the departed user (admin) via the LogicMonitor REST API (LMv1 HMAC-SHA256). Onboarding is out of band.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgLogicMonitor', 'Get-CtgLmSignature', 'Invoke-CtgLogicMonitorApi', 'Find-CtgLmAdmin', 'Test-CtgLmSuspended', 'Invoke-CtgLogicMonitorOnboarding', 'Invoke-CtgLogicMonitorOffboarding', 'Confirm-CtgLogicMonitor')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
