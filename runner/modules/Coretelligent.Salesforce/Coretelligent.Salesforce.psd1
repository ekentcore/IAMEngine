@{
    RootModule        = 'Coretelligent.Salesforce.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'a1c2e3f4-5b6d-4e70-8f91-0a1b2c3d4e5f'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Salesforce user lifecycle via the REST API (Connected App JWT bearer auth). Onboard creates/adopts a user; offboard deactivates (never deletes). No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgSalesforce', 'Invoke-CtgSalesforceApi', 'Get-CtgSalesforceUser', 'Invoke-CtgSalesforceOnboarding', 'Invoke-CtgSalesforceOffboarding', 'Confirm-CtgSalesforce')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
