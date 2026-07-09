@{
    RootModule        = 'Coretelligent.XMatters.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'c7efebde-3732-476e-b4be-4f4c14dffd7a'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'xMatters offboarding: deactivate (default) or delete the departed person via the xMatters REST API (HTTP Basic). Onboarding is out of band (directory sync).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgXMatters', 'Invoke-CtgXMattersApi', 'Find-CtgXMattersPerson', 'Invoke-CtgXMattersOnboarding', 'Invoke-CtgXMattersOffboarding', 'Confirm-CtgXMatters')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
