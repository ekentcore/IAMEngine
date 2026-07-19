@{
    RootModule        = 'Coretelligent.SharePoint.psm1'
    ModuleVersion     = '0.1.0'
    GUID              = '52979215-0fd7-43bc-bf50-a296e3384f84'
    Author            = 'Coretelligent Remote Operations'
    CompanyName       = 'Coretelligent'
    Description       = 'App-only SharePoint/OneDrive access via PnP.PowerShell, reusing the m365-admin certificate — offboard hand-off (grant a manager/delegate full access to a leaver''s content).'
    PowerShellVersion = '7.0'

    FunctionsToExport = @('Connect-CtgSharePointPnP', 'Grant-CtgSharePointSiteAccess', 'Get-CtgOneDriveSiteUrl', 'Test-CtgOffboardResolved', 'Invoke-CtgSharePointOffboardGrant', 'Test-CtgDelegateUnambiguous')
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}
