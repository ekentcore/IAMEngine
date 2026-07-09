@{
    RootModule        = 'Coretelligent.Notify.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '2d08f776-d87f-455f-9f2e-d12cf8f8b625'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'Offboard notifications via Microsoft Graph sendMail: the communication email to the offboarding list + the ServiceNow case-note email (RE: INC#) to internalsupport@core.tech. Uses the ambient m365-admin Graph context.'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Get-CtgProp', 'Expand-CtgNoticeTemplate', 'Send-CtgGraphMail', 'Invoke-CtgNotifyOnboarding', 'Invoke-CtgNotifyOffboarding', 'Confirm-CtgNotify')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
