@{
    RootModule        = 'Coretelligent.Zoom.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'a8f6c7d9-5c0e-4f1a-bfb2-6d7e8f901234'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Zoom user lifecycle via the Zoom REST API v2 (server-to-server OAuth). No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgZoom', 'Invoke-CtgZoomApi', 'Get-CtgZoomUser', 'Invoke-CtgZoomOnboarding', 'Invoke-CtgZoomOffboarding', 'Confirm-CtgZoom')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
