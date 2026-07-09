@{
    RootModule        = 'Coretelligent.SentinelOne.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b2f4c6a8-1d3e-4f5a-8b9c-0e1d2f3a4b5c'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'SentinelOne endpoint containment on offboard: network-isolate (quarantine) the departed user''s endpoint, and shut it down only when explicitly requested. Management API v2.1, ApiToken auth. Onboarding is out of band (MSI/RMM).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgSentinelOne', 'Invoke-CtgSentinelOneApi', 'Resolve-CtgS1MachineName', 'Find-CtgS1Agents', 'Test-CtgS1Isolated', 'Invoke-CtgSentinelOneOnboarding', 'Invoke-CtgSentinelOneOffboarding', 'Invoke-CtgSentinelOneReconnect', 'Confirm-CtgSentinelOne')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
