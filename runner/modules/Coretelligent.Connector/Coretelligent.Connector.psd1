@{
    RootModule        = 'Coretelligent.Connector.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '8f4b2e6a-9c1d-4f7e-b3a5-2d6c8e0f1a3b'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Generic executor for low-code connectors: interprets declarative http definitions (docs/CONNECTOR_BUILDER.md) injected by the app as config.connector — templated requests, host allowlist, expect/extract, per-lane steps. One module runs every custom-* system.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @(
        'Get-CtgConnectorPath', 'Resolve-CtgConnectorTemplate', 'Resolve-CtgConnectorValue',
        'Test-CtgConnectorCondition', 'Invoke-CtgConnectorApi', 'Get-CtgConnectorAuthHeaders',
        'Get-CtgConnectorBrowserSession',
        'Assert-CtgConnectorHost', 'Invoke-CtgConnectorOperation', 'Invoke-CtgConnectorLane',
        'Initialize-CtgConnectorContext', 'Get-CtgConnectorDefinition',
        'Invoke-CtgConnectorOnboarding', 'Invoke-CtgConnectorOffboarding', 'Test-CtgConnectorConnection',
    'Invoke-CtgConnectorBrowserLane',
        'Hide-CtgConnectorSecrets'
    )
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
