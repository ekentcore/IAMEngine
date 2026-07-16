@{
    RootModule        = 'Coretelligent.Exchange.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'f7e5b6c8-4b9d-4e0f-bea1-5c6d7e8f9012'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Exchange Online offboarding (convert-to-shared with size threshold, CAS disable, OOO/forwarding) via the EXO V3 module.'
    PowerShellVersion = '7.0'

    RequiredModules   = @(@{ ModuleName = 'ExchangeOnlineManagement'; ModuleVersion = '3.0.0' })

    FunctionsToExport = @('Connect-CtgExchange', 'Connect-CtgExchangeOnPrem', 'Get-CtgMailboxSizeGB', 'Test-CtgConvertToShared', 'Test-CtgCloudMailboxShared', 'Invoke-CtgExchangeOnboarding', 'Invoke-CtgExchangeHybridOnboard', 'Invoke-CtgExchangeCloudOnboard', 'Invoke-CtgExchangeNamedGroups', 'Invoke-CtgExchangeDistListMirror', 'Invoke-CtgExchangeSharedMailboxMirror', 'Set-CtgMailboxRegional', 'Wait-CtgMailbox', 'Invoke-CtgExchangeOffboarding', 'Confirm-CtgExchange')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
