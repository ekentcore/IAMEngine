BeforeAll { . "$PSScriptRoot/../lib/CtgMigrate.ps1" }

Describe 'Set-CtgAppUrlInArgString' {
  It 'replaces a quoted -AppUrl value, preserving other args' {
    $in = '-NoProfile -ExecutionPolicy Bypass -File "C:\iam-runner\Start-IamRunner.ps1" -AppUrl "https://old.kentassociates.org" -AgentId "abc" -StallTimeoutSeconds 600'
    $out = Set-CtgAppUrlInArgString -ArgString $in -NewUrl 'https://iam.core.tech'
    $out | Should -BeLike '*-AppUrl "https://iam.core.tech"*'
    $out | Should -Not -BeLike '*kentassociates*'
    $out | Should -BeLike '*-AgentId "abc"*'
    $out | Should -BeLike '*-StallTimeoutSeconds 600*'
  }
  It 'replaces an unquoted -AppUrl value' {
    $in = '-File x -AppUrl https://old -AgentId abc'
    (Set-CtgAppUrlInArgString -ArgString $in -NewUrl 'https://new') | Should -BeLike '*-AppUrl "https://new"*'
  }
  It 'is idempotent (running twice yields the same)' {
    $once = Set-CtgAppUrlInArgString -ArgString '-AppUrl "https://old" -AgentId a' -NewUrl 'https://new'
    (Set-CtgAppUrlInArgString -ArgString $once -NewUrl 'https://new') | Should -Be $once
  }
}

Describe 'Set-CtgAppUrlInPlist' {
  It 'replaces the string element after -AppUrl only' {
    $in = @'
<array>
<string>-File</string>
<string>/opt/iam/Start-IamRunner.ps1</string>
<string>-AppUrl</string>
<string>https://old.kentassociates.org</string>
<string>-AgentId</string>
<string>abc</string>
</array>
'@
    $out = Set-CtgAppUrlInPlist -PlistXml $in -NewUrl 'https://iam.core.tech'
    $out | Should -BeLike '*<string>https://iam.core.tech</string>*'
    $out | Should -Not -BeLike '*kentassociates*'
    $out | Should -BeLike '*<string>abc</string>*'
  }
}
