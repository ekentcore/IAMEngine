@{
    RootModule        = 'Coretelligent.HubSpot.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'd4f5b6c7-8e90-41a3-bc4d-5e6f70819203'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent HubSpot user lifecycle via the User Provisioning API (settings/v3/users, private-app token). Onboard creates/invites with a role + team; offboard removes. No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgHubSpot', 'Invoke-CtgHubSpotApi', 'Get-CtgHubSpotUser', 'Invoke-CtgHubSpotOnboarding', 'Invoke-CtgHubSpotOffboarding', 'Confirm-CtgHubSpot')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
