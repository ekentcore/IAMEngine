@{
    RootModule        = 'Coretelligent.KnowBe4.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = 'b2d3f4a5-6c7e-4f81-9a2b-3c4d5e6f7081'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Idempotent KnowBe4 user lifecycle via SCIM 2.0 (KnowBe4 has no create-user REST API). Onboard creates/adopts; offboard deactivates. No external module dependencies.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgKnowBe4', 'Invoke-CtgKnowBe4Scim', 'Get-CtgKnowBe4User', 'Invoke-CtgKnowBe4Onboarding', 'Invoke-CtgKnowBe4Offboarding', 'Confirm-CtgKnowBe4', 'Resolve-CtgKnowBe4ConsoleLogin', 'Invoke-CtgKnowBe4ConsoleSetup')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
