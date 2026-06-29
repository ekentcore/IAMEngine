@{
    RootModule        = 'Coretelligent.1Password.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'fca0abb9-1f3e-46e5-9e33-6b27406faa53'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = '1Password user lifecycle: invite (provision) the new user on onboard and suspend them on offboard. Method-aware (scim / api / browser / manual). The api method shells out to the 1Password CLI (op user provision / op user suspend) signed in as a brokered admin account — there is no app-only REST API for user management.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-Ctg1Password', 'Invoke-Ctg1PasswordCli', 'Get-Ctg1PasswordUser', 'Invoke-Ctg1PasswordOnboarding', 'Invoke-Ctg1PasswordOffboarding', 'Confirm-Ctg1Password')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
