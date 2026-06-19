@{
    RootModule        = 'Coretelligent.Duo.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '62045f4a-df1a-454e-af81-e64457ed1e22'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Duo Security MFA offboarding: deactivate (default) or delete the departed user via the Duo Admin API (HMAC-SHA1 signed). Onboarding is out of band (directory sync / self-enrolment).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgDuo', 'Get-CtgDuoSignature', 'Invoke-CtgDuoApi', 'Find-CtgDuoUser', 'Invoke-CtgDuoOnboarding', 'Invoke-CtgDuoOffboarding', 'Confirm-CtgDuo')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
