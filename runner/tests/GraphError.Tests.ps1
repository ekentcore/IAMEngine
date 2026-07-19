BeforeAll { Import-Module "$PSScriptRoot/../modules/Coretelligent.M365/Coretelligent.M365.psd1" -Force }
Describe 'Get-CtgGraphError' {
    It 'extracts code + message from a Graph JSON error body in ErrorDetails' {
        $err = $null
        try {
            $e = [System.Management.Automation.ErrorRecord]::new(
                [Exception]::new('BadRequest'), 'x', 'InvalidOperation', $null)
            $e.ErrorDetails = [System.Management.Automation.ErrorDetails]::new('{"error":{"code":"invalidRequest","message":"The recipient is invalid."}}')
            throw $e
        } catch { $err = $_ }
        $g = Get-CtgGraphError $err
        $g.Code    | Should -Be 'invalidRequest'
        $g.Message | Should -Be 'The recipient is invalid.'
    }
    It 'falls back to the exception message when there is no body' {
        $err = $null
        try { throw [Exception]::new('boom') } catch { $err = $_ }
        (Get-CtgGraphError $err).Message | Should -Match 'boom'
    }
}
