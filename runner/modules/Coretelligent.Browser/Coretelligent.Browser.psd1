@{
    RootModule        = 'Coretelligent.Browser.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b7c9d3e1-4f5a-4b2c-8d6e-9a0b1c2d3e4f'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Bridge from the PowerShell runner to the Node/Playwright browser sidecar (runner/browser). Shells out to run headless-Chromium flows for the few systems with no API. Reports the browser capability (Test-CtgBrowserAvailable) and runs a named flow (Invoke-CtgBrowserFlow).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Test-CtgBrowserAvailable', 'Install-CtgBrowser', 'Invoke-CtgBrowserFlow', 'Resolve-CtgNodeTool', 'ConvertFrom-CtgStageLine')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
