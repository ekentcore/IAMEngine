@{
    RootModule        = 'Coretelligent.Jira.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'c3e4a5b6-7d8f-4092-ab3c-4d5e6f708192'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent Atlassian Jira Cloud user lifecycle via the REST API (Basic email:token auth). Onboard invites/creates with product access; offboard removes site access. No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgJira', 'Invoke-CtgJiraApi', 'Get-CtgJiraUser', 'Invoke-CtgJiraOnboarding', 'Invoke-CtgJiraOffboarding', 'Confirm-CtgJira')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
