# M365 attribute rules — implementation plan (FR #0000104 + #0000087)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make role/rule attributes (`Config.attributes`) actually apply on the Microsoft 365 /
Entra lane, translating the LDAP-style names operators really use into Graph property names, so an
attribute configured in the UI lands on the user instead of being silently ignored.

**Architecture:** The AD lane already applies `Config.attributes` generically through
`Set-CtgADAttributes`. The M365 lane never reads `Config.attributes` at all — it builds a hardcoded
ten-field map from the intake and writes that. This plan adds two pure helpers to
`Coretelligent.M365.psm1` (a name translator and a map resolver) and merges their output over the
intake-derived map, with the rule winning and the disagreement reported. No web change: the planner
already delivers `attributes` onto the m365/entra job config.

**Tech Stack:** PowerShell 7, Pester 5, Microsoft.Graph PowerShell SDK (`Update-MgUser`).

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (Tier 1, item 1)

## Global Constraints

- **Both feature requests close on this one fix.** #0000087 (empty body) and #0000104 (the detail)
  are the same defect; each gets its own resolution note naming the shared fix.
- **Rule wins over the intake, and the override is shown on the case.** Where a rule and the
  ServiceNow ticket both supply an attribute, the rule value lands and an action line records that
  the two disagreed. **Exception:** `manager` — the intake manager keeps precedence, and a rule
  manager only fills the gap (see Task 4).
- **Unmappable attributes skip with a visible warning**, naming the attribute, never silently.
- **Idempotent.** A re-run after a partial failure must be safe (`CLAUDE.md`); every write here is
  an `Update-MgUser` set of the same value.
- **Backward compatible with un-upgraded runners.** The web half ships on merge, the runner half
  does not. Nothing in this plan changes the job config contract, so an old runner keeps its current
  behaviour rather than erroring.
- **Existing behaviour that must survive:** the AD-synced on-prem-mastered path reports an
  informational skip rather than a warning; the `$hasVal` guard refuses empty values and unresolved
  `{token}` strings.
- Runner module change ⇒ `runner/VERSION` bump and a runner deploy.
- Test baseline is **2132 tests, 2126 pass, 6 fail** on `web/`; the six known failures are listed in
  the spec and are not in scope. Runner tests run via `Invoke-Pester`.

## Background: why a straight port of the AD pattern is wrong

Fleet scan of all 192 `Client` rows (2026-08-17) found 30 distinct attribute names in use,
overwhelmingly LDAP spellings — including on cloud lanes. Breakthrough Energy Ventures (`core397`),
the client in the request, has this on `globals.m365.attributes`:

```json
{
  "city": "{location.city}",  "state": "{location.state}",  "title": "{title}",
  "mobile": "{mobile}",       "company": "Breakthrough Energy Ventures",
  "country": "{country.name}","department": "{department}", "postalCode": "{location.zip}",
  "streetAddress": "{location.street}", "physicalDeliveryOfficeName": "{location.city}"
}
```

Six of those are valid Graph property names. Four are not: `title`, `mobile`, `company`,
`physicalDeliveryOfficeName`. Looping the map straight onto `Update-MgUser` — the naive "mirror the
AD lane" fix — would leave 4 of BEV's 10 attributes failing. That is why Task 1 exists.

## File structure

- **Modify** `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1`
  - add `ConvertTo-CtgGraphAttributeName` (pure name translator) near the other small helpers
  - add `Resolve-CtgM365AttributeUpdate` (pure map resolver) directly below it
  - wire both into `Invoke-CtgM365Onboarding` step 1b (line ~1002) and step 1c (line ~1040)
  - add offboard parity in `Invoke-CtgM365Offboarding` (line ~1450)
- **Modify** `runner/tests/Coretelligent.M365.Tests.ps1` — new `Describe` block for the helpers, new
  `It` cases in the onboarding block
- **Modify** `runner/VERSION` — bump minor
- **Create** `web/lib/changelog/entries/m365-attribute-rules.ts`
- **Modify** `web/lib/changelog/entries/_registry.ts` — one id-ordered export line

The two new functions are pure (no Graph calls), which is what makes the name-mapping table
testable without mocking anything.

---

### Task 1: Graph attribute-name translation

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (insert after `Get-CtgProp`, ~line 60)
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: nothing
- Produces: `ConvertTo-CtgGraphAttributeName -Name <string>` → `[string]` Graph property name in the
  `Update-MgUser` parameter spelling (e.g. `JobTitle`), or `$null` when the name has no writable
  Graph equivalent.

- [ ] **Step 1: Write the failing tests**

Add at the end of `runner/tests/Coretelligent.M365.Tests.ps1`:

```powershell
Describe 'ConvertTo-CtgGraphAttributeName' {
    It 'translates the LDAP spellings operators actually use' {
        InModuleScope Coretelligent.M365 {
            ConvertTo-CtgGraphAttributeName -Name 'title'                      | Should -Be 'JobTitle'
            ConvertTo-CtgGraphAttributeName -Name 'mobile'                     | Should -Be 'MobilePhone'
            ConvertTo-CtgGraphAttributeName -Name 'company'                    | Should -Be 'CompanyName'
            ConvertTo-CtgGraphAttributeName -Name 'physicalDeliveryOfficeName' | Should -Be 'OfficeLocation'
            ConvertTo-CtgGraphAttributeName -Name 'telephoneNumber'            | Should -Be 'BusinessPhones'
            ConvertTo-CtgGraphAttributeName -Name 'l'                          | Should -Be 'City'
            ConvertTo-CtgGraphAttributeName -Name 'st'                         | Should -Be 'State'
            ConvertTo-CtgGraphAttributeName -Name 'co'                         | Should -Be 'Country'
        }
    }

    It 'passes valid Graph names through, case-insensitively' {
        InModuleScope Coretelligent.M365 {
            ConvertTo-CtgGraphAttributeName -Name 'department'   | Should -Be 'Department'
            ConvertTo-CtgGraphAttributeName -Name 'streetAddress'| Should -Be 'StreetAddress'
            ConvertTo-CtgGraphAttributeName -Name 'PostalCode'   | Should -Be 'PostalCode'
            ConvertTo-CtgGraphAttributeName -Name 'jobtitle'     | Should -Be 'JobTitle'
        }
    }

    It 'returns null for attributes with no writable Graph equivalent' {
        InModuleScope Coretelligent.M365 {
            foreach ($n in @('extensionAttribute4','msDS-cloudExtensionAttribute1','proxyAddresses',
                             'ipPhone','homePhone','description','mail','countryCode','usernamePattern')) {
                ConvertTo-CtgGraphAttributeName -Name $n | Should -BeNullOrEmpty -Because "$n is not settable via Update-MgUser"
            }
        }
    }

    It 'maps every attribute Breakthrough Energy Ventures has configured' {
        InModuleScope Coretelligent.M365 {
            foreach ($n in @('city','state','title','mobile','company','country',
                             'department','postalCode','streetAddress','physicalDeliveryOfficeName')) {
                ConvertTo-CtgGraphAttributeName -Name $n | Should -Not -BeNullOrEmpty -Because "core397 configured $n"
            }
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: FAIL — `The term 'ConvertTo-CtgGraphAttributeName' is not recognized`.

- [ ] **Step 3: Write the implementation**

Insert into `Coretelligent.M365.psm1` immediately after `Get-CtgProp` (~line 60):

```powershell
# Translate a client-configured attribute NAME to the Graph property name Update-MgUser expects.
#
# Attribute maps are authored once and used on BOTH lanes, and profiles/_schema.json tells authors to
# use "the exact directory attribute name (e.g. title, department, company, extensionAttribute4…)" —
# i.e. LDAP spellings. The AD lane takes those verbatim; Graph will not. A fleet scan on 2026-08-17
# found 30 distinct names across 192 clients, LDAP-dominated even on cloud lanes, so translating here
# is what makes an existing attribute rule work without anyone re-entering their config.
#
# Returns $null when the attribute has no writable Graph equivalent — the caller reports that by name
# rather than silently dropping it (FR #104: silence is the whole complaint).
function ConvertTo-CtgGraphAttributeName {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Name)
    $k = ([string]$Name).Trim().ToLowerInvariant()
    if (-not $k) { return $null }
    # Writable single-value user properties on Update-MgUser, keyed by their lowercase spelling.
    $graph = @{
        'jobtitle' = 'JobTitle'; 'department' = 'Department'; 'companyname' = 'CompanyName'
        'officelocation' = 'OfficeLocation'; 'mobilephone' = 'MobilePhone'; 'streetaddress' = 'StreetAddress'
        'city' = 'City'; 'state' = 'State'; 'postalcode' = 'PostalCode'; 'country' = 'Country'
        'businessphones' = 'BusinessPhones'; 'employeeid' = 'EmployeeId'; 'employeetype' = 'EmployeeType'
        'displayname' = 'DisplayName'; 'givenname' = 'GivenName'; 'surname' = 'Surname'
        'mailnickname' = 'MailNickname'; 'faxnumber' = 'FaxNumber'; 'preferredlanguage' = 'PreferredLanguage'
    }
    if ($graph.ContainsKey($k)) { return $graph[$k] }
    # LDAP/AD spellings, mapped to their Graph equivalent. `c` (ISO-2 country code) and `co` (country
    # name) both land on Country: Graph has one free-text country field, and usageLocation — which
    # drives LICENSING — is deliberately NOT a target here, so a rule cannot silently change it.
    $alias = @{
        'title' = 'JobTitle'; 'mobile' = 'MobilePhone'; 'company' = 'CompanyName'
        'physicaldeliveryofficename' = 'OfficeLocation'; 'telephonenumber' = 'BusinessPhones'
        'l' = 'City'; 'st' = 'State'; 'co' = 'Country'; 'c' = 'Country'; 'sn' = 'Surname'
    }
    if ($alias.ContainsKey($k)) { return $alias[$k] }
    return $null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: PASS — all four new `It` blocks green, no previously-passing test broken.

- [ ] **Step 5: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "M365: translate LDAP attribute names to Graph property names

Attribute maps are authored once and used on both lanes, and the schema tells
authors to use LDAP spellings. AD takes those verbatim; Graph will not. A pure
translator, so the mapping table is testable without touching Graph."
```

---

### Task 2: Resolve a config attribute map into a Graph update

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (immediately after `ConvertTo-CtgGraphAttributeName`)
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: `ConvertTo-CtgGraphAttributeName` (Task 1)
- Produces: `Resolve-CtgM365AttributeUpdate -Attributes <hashtable|pscustomobject>` → a
  `[pscustomobject]` with three members:
  - `.Update` — `[hashtable]` of Graph property name → value, splattable onto `Update-MgUser`
  - `.Manager` — `[string]` or `$null`, the manager value lifted out of the map
  - `.Skipped` — `[string[]]` of attribute names with no writable Graph equivalent

- [ ] **Step 1: Write the failing tests**

Append to the same file:

```powershell
Describe 'Resolve-CtgM365AttributeUpdate' {
    It 'builds a splattable Graph update from an LDAP-named map' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ title='Analyst'; company='BEV'; city='Boston' }
            $r.Update['JobTitle']    | Should -Be 'Analyst'
            $r.Update['CompanyName'] | Should -Be 'BEV'
            $r.Update['City']        | Should -Be 'Boston'
            $r.Update.Count          | Should -Be 3
        }
    }

    It 'accepts a JSON-deserialized pscustomobject as well as a hashtable' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes ([pscustomobject]@{ title='Analyst' })
            $r.Update['JobTitle'] | Should -Be 'Analyst'
        }
    }

    It 'drops empty values and unresolved {token} strings' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ title=''; department='  '; city='{location.city}'; state='MA' }
            $r.Update.Count    | Should -Be 1
            $r.Update['State'] | Should -Be 'MA'
        }
    }

    It 'lifts manager out of the map instead of sending it to Update-MgUser' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ manager='Jim Goodmiller'; title='Analyst' }
            $r.Manager                     | Should -Be 'Jim Goodmiller'
            $r.Update.ContainsKey('Manager') | Should -BeFalse
            $r.Update['JobTitle']          | Should -Be 'Analyst'
        }
    }

    It 'reports unmappable attributes by name rather than dropping them silently' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ extensionAttribute4='X'; proxyAddresses='smtp:a@b.com'; title='Analyst' }
            $r.Skipped        | Should -Contain 'extensionAttribute4'
            $r.Skipped        | Should -Contain 'proxyAddresses'
            $r.Update.Count   | Should -Be 1
        }
    }

    It 'wraps businessPhones in an array, because Graph types it as a collection' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes @{ telephoneNumber='+1 555 0100' }
            ,$r.Update['BusinessPhones'] | Should -BeOfType [System.Object[]]
            $r.Update['BusinessPhones'][0] | Should -Be '+1 555 0100'
        }
    }

    It 'returns an empty result for a null map' {
        InModuleScope Coretelligent.M365 {
            $r = Resolve-CtgM365AttributeUpdate -Attributes $null
            $r.Update.Count  | Should -Be 0
            $r.Manager       | Should -BeNullOrEmpty
            @($r.Skipped).Count | Should -Be 0
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: FAIL — `The term 'Resolve-CtgM365AttributeUpdate' is not recognized`.

- [ ] **Step 3: Write the implementation**

Insert directly below `ConvertTo-CtgGraphAttributeName`:

```powershell
# Turn a client-configured attribute map (globals / persona / location `attributes`) into something
# the cloud lane can apply: a splattable Graph update, the manager lifted out, and the names that
# have no Graph equivalent reported back so the caller can say so on the case.
#
# Pure — no Graph calls — so the precedence and mapping rules are unit-testable.
function Resolve-CtgM365AttributeUpdate {
    [CmdletBinding()]
    param($Attributes)
    $result = [pscustomobject]@{
        Update  = @{}
        Manager = $null
        Skipped = [System.Collections.Generic.List[string]]::new()
    }
    if (-not $Attributes) { return $result }
    # Works for a JSON-deserialized pscustomobject (production) or a hashtable (tests) — same shape
    # handling Set-CtgADAttributes uses on the AD lane.
    $names = if ($Attributes -is [hashtable]) { @($Attributes.Keys) } else { @($Attributes.PSObject.Properties.Name) }
    foreach ($name in $names) {
        $value = if ($Attributes -is [hashtable]) { $Attributes[$name] } else { $Attributes.$name }
        # The same guard the intake path uses: Graph rejects an empty string, and an unresolved
        # {token} means the planner had nothing to fill it with — writing it literally is worse
        # than skipping it.
        if ([string]::IsNullOrWhiteSpace([string]$value) -or ([string]$value) -match '\{') { continue }
        if ($name -ieq 'manager') { $result.Manager = [string]$value; continue }
        $graphName = ConvertTo-CtgGraphAttributeName -Name $name
        if (-not $graphName) { $result.Skipped.Add([string]$name); continue }
        if ($graphName -eq 'BusinessPhones') { $result.Update[$graphName] = @([string]$value) }
        else { $result.Update[$graphName] = [string]$value }
    }
    return $result
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: PASS — all seven new `It` blocks green.

- [ ] **Step 5: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "M365: resolve a config attribute map into a Graph update

Splits a client's attribute map into the splattable Graph update, the manager
(a relationship, not a property), and the names Graph cannot write — which the
caller reports rather than dropping."
```

---

### Task 3: Apply rule attributes on onboarding, rule winning over the intake

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1:1002-1042` (step 1b)
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: `Resolve-CtgM365AttributeUpdate` (Task 2)
- Produces: `$ruleAttrs` in `Invoke-CtgM365Onboarding` scope, hoisted above the `if ($userId)` block
  so Task 4's manager step can read `$ruleAttrs.Manager`.

- [ ] **Step 1: Write the failing tests**

Add inside the existing onboarding `Describe`/`Context`, next to
`'writes profile attributes (department, office location, address) from the intake'`:

```powershell
    It 'applies Config.attributes on the cloud lane, translating LDAP names (FR #104)' {
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; UsageLocation='US' }
        $cfg = [pscustomobject]@{ licenses = @(); attributes = @{ title='Analyst'; company='BEV'; physicalDeliveryOfficeName='Boston' } }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        Invoke-CtgM365Onboarding -User $u -Config $cfg -InitialPassword $pwd | Out-Null
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter {
            $JobTitle -eq 'Analyst' -and $CompanyName -eq 'BEV' -and $OfficeLocation -eq 'Boston'
        } -Times 1
    }

    It 'lets the rule win over the ticket, and says so on the case' {
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; UsageLocation='US'; JobTitle='Engineer' }
        $cfg = [pscustomobject]@{ licenses = @(); attributes = @{ title='Analyst' } }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $u -Config $cfg -InitialPassword $pwd
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $JobTitle -eq 'Analyst' } -Times 1
        ($r.Actions -join ' ') | Should -Match "JobTitle.*Analyst.*rule.*Engineer.*ticket"
    }

    It 'names an attribute Graph cannot write instead of dropping it silently' {
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; UsageLocation='US' }
        $cfg = [pscustomobject]@{ licenses = @(); attributes = @{ extensionAttribute4='X'; title='Analyst' } }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        $r = Invoke-CtgM365Onboarding -User $u -Config $cfg -InitialPassword $pwd
        ($r.Actions -join ' ') | Should -Match 'extensionAttribute4'
    }
```

`$r.Actions` is correct and verified: `Invoke-CtgM365Onboarding` returns a `[pscustomobject]` whose
last member is `Actions = $actions.ToArray()` (`Coretelligent.M365.psm1:1362`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: FAIL — `Update-MgUser` is invoked without `JobTitle`/`CompanyName`/`OfficeLocation`,
because `Config.attributes` is never read.

- [ ] **Step 3: Write the implementation**

In `Invoke-CtgM365Onboarding`, hoist the resolve above the `if ($userId) {` that opens step 1b:

```powershell
    # Rule/role attributes from the client's config (globals, personas, locations). Resolved BEFORE
    # the 1b block so step 1c can read $ruleAttrs.Manager.
    $ruleAttrs = Resolve-CtgM365AttributeUpdate -Attributes (Get-CtgProp $Config 'attributes')
```

Then inside step 1b, after the `BusinessPhones` line and *before* the
`if ($update.Count -and $PSCmdlet.ShouldProcess(...))` guard, insert:

```powershell
        # The AD lane has always honoured Config.attributes generically; the cloud lane never read it,
        # so every attribute rule authored for a cloud client was silently ignored (FR #104/#87). The
        # RULE WINS over the intake-derived value — an attribute deliberately configured on the client
        # beats whatever the ticket happened to carry — and a disagreement is reported, never silent.
        foreach ($k in @($ruleAttrs.Update.Keys)) {
            $ruleVal = $ruleAttrs.Update[$k]
            if ($update.ContainsKey($k) -and "$($update[$k])" -ne "$ruleVal") {
                $actions.Add("$k = '$ruleVal' (rule) overrode '$($update[$k])' (ticket)")
            }
            $update[$k] = $ruleVal
        }
        foreach ($s in $ruleAttrs.Skipped) {
            $actions.Add("WARN attribute '$s' is not settable on the cloud lane — the AD lane masters it; skipped")
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: PASS — the three new cases green, and
`'writes profile attributes (department, office location, address) from the intake'` still green
(a config with no `attributes` must behave exactly as before).

- [ ] **Step 5: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "FR #104/#87: apply role and rule attributes on the M365 lane

The cloud lane built a hardcoded ten-field map from the intake and never read
Config.attributes, so every attribute rule authored for a cloud client was
silently ignored. Rule wins over the ticket and the override is reported;
attributes Graph cannot write are named rather than dropped."
```

---

### Task 4: Route a rule `manager` into the existing manager step

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1:1040` (step 1c)
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: `$ruleAttrs.Manager` (Task 3)
- Produces: nothing new

`manager` appears in 123 clients' attribute maps. Graph sets manager as a *relationship*, not a
property, so it must not reach `Update-MgUser` — Task 2 already lifts it out. Here it feeds the
manager step that already exists.

**Precedence differs from every other attribute, deliberately:** the intake manager wins and a rule
manager only fills the gap. A ticket names the actual hiring manager for this specific person; a
client-wide rule cannot know that.

- [ ] **Step 1: Write the failing tests**

```powershell
    It 'uses a rule manager when the ticket did not name one' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith {
            param($UserId, $Filter)
            if ($Filter -like "*Jim Goodmiller*") { return [pscustomobject]@{ Id = 'mgr-1'; DisplayName = 'Jim Goodmiller' } }
            return $null
        }
        Mock Set-MgUserManagerByRef -ModuleName Coretelligent.M365 -MockWith { }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; UsageLocation='US' }
        $cfg = [pscustomobject]@{ licenses = @(); attributes = @{ manager='Jim Goodmiller' } }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        Invoke-CtgM365Onboarding -User $u -Config $cfg -InitialPassword $pwd | Out-Null
        Should -Invoke Set-MgUserManagerByRef -ModuleName Coretelligent.M365 -Times 1
    }

    It 'never sends manager to Update-MgUser (Graph types it as a relationship)' {
        Mock Get-MgUser -ModuleName Coretelligent.M365 -MockWith { return $null }
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ DisplayName='Jane Doe'; UserPrincipalName='jane.doe@x.com'; FirstName='Jane'; LastName='Doe'; UsageLocation='US' }
        $cfg = [pscustomobject]@{ licenses = @(); attributes = @{ manager='Jim Goodmiller'; title='Analyst' } }
        $pwd = ConvertTo-SecureString 'Pw!23456789abc' -AsPlainText -Force
        Invoke-CtgM365Onboarding -User $u -Config $cfg -InitialPassword $pwd | Out-Null
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter { $null -ne $Manager } -Times 0 -Exactly
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: FAIL on the first case — `Set-MgUserManagerByRef` invoked 0 times, because the rule
manager is never consulted.

- [ ] **Step 3: Write the implementation**

Change the `$mgr` line in step 1c from:

```powershell
    $mgr = (Get-CtgProp $User 'ManagerEmail') ?? (Get-CtgProp $User 'ManagerName') ?? (Get-CtgProp $User 'Manager')
```

to:

```powershell
    # A rule manager FILLS A GAP rather than overriding — the one attribute where the ticket wins.
    # A ticket names this specific hire's actual manager; a client-wide rule cannot know that.
    $mgr = (Get-CtgProp $User 'ManagerEmail') ?? (Get-CtgProp $User 'ManagerName') ?? (Get-CtgProp $User 'Manager') ?? $ruleAttrs.Manager
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: PASS, including the pre-existing
`'sets the manager, resolving a SNOW "First (Nick) Last" to the 365 "Nick Last"'`.

- [ ] **Step 5: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "M365: a rule manager feeds the manager step, not Update-MgUser

manager is in 123 clients' attribute maps, and Graph types it as a relationship.
It fills a gap the ticket left rather than overriding the ticket."
```

---

### Task 5: Offboard parity — `offboardAttributes`

**Files:**
- Modify: `runner/modules/Coretelligent.M365/Coretelligent.M365.psm1` (`Invoke-CtgM365Offboarding`, ~line 1450)
- Test: `runner/tests/Coretelligent.M365.Tests.ps1`

**Interfaces:**
- Consumes: `Resolve-CtgM365AttributeUpdate` (Task 2)
- Produces: nothing new

The AD lane applies `Config.offboardAttributes` at
`Coretelligent.ActiveDirectory.psm1:748`, and `plan-resolve.ts:85` already puts the key on the job
config for every directory lane. The cloud lane ignores it, so an offboard rule such as
`description = "Offboarded"` never lands in 365.

- [ ] **Step 1: Write the failing test**

```powershell
    It 'applies Config.offboardAttributes on the cloud lane' {
        Mock Update-MgUser -ModuleName Coretelligent.M365 -MockWith { }
        $u = [pscustomobject]@{ UserPrincipalName='jane.doe@x.com'; DisplayName='Jane Doe' }
        $cfg = [pscustomobject]@{ offboardAttributes = @{ title='Departed'; company='BEV' } }
        Invoke-CtgM365Offboarding -User $u -Config $cfg | Out-Null
        Should -Invoke Update-MgUser -ModuleName Coretelligent.M365 -ParameterFilter {
            $JobTitle -eq 'Departed' -and $CompanyName -eq 'BEV'
        } -Times 1
    }
```

The signature is verified: `Invoke-CtgM365Offboarding` takes `[Parameter(Mandatory)][pscustomobject]$User`,
`[Parameter(Mandatory)][pscustomobject]$Config`, and an optional `[System.Nullable[double]]$MailboxSizeGB`
(`Coretelligent.M365.psm1:1470-1475`), so the two-argument call above is correct.

- [ ] **Step 2: Run the test to verify it fails**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: FAIL — `Update-MgUser` never invoked with those properties.

- [ ] **Step 3: Write the implementation**

Insert into `Invoke-CtgM365Offboarding` **immediately after line 1552** (`$userId = $existing.Id`)
and the `$upn` reassignment on the line below it — that is the first point where `$userId`, `$upn`
and `$actions` are all in scope and authoritative, and it is ahead of the licence/mailbox work, so
an attribute write cannot be skipped by an early return on a later step:

```powershell
    # Offboard attribute rules (config.offboardAttributes) — the AD lane has applied these since
    # FR #37; the cloud lane ignored them, so e.g. description = "Offboarded" never landed in 365.
    $offAttrs = Resolve-CtgM365AttributeUpdate -Attributes (Get-CtgProp $Config 'offboardAttributes')
    if ($offAttrs.Update.Count -and $PSCmdlet.ShouldProcess($upn, "Set offboard attributes: $($offAttrs.Update.Keys -join ', ')")) {
        try {
            $offUpdate = $offAttrs.Update
            Invoke-CtgM365Write { Update-MgUser -UserId $userId @offUpdate -ErrorAction Stop }
            $actions.Add("set offboard attributes: $($offAttrs.Update.Keys -join ', ')")
        } catch {
            $om = [string]$_.Exception.Message
            if ($om -match 'on-premises mastered|Directory Sync objects') {
                $actions.Add("offboard attributes ($($offAttrs.Update.Keys -join ', ')) are on-prem-mastered (AD-synced) — the AD lane sets them on-prem; skipped in the cloud")
            } else {
                $actions.Add("WARN could not set offboard attributes ($($offAttrs.Update.Keys -join ', ')): $om")
            }
        }
    }
    foreach ($s in $offAttrs.Skipped) {
        $actions.Add("WARN offboard attribute '$s' is not settable on the cloud lane — the AD lane masters it; skipped")
    }
```

Verified in scope at that point: `$actions` (declared at `:1482`), `$upn` (`:1488`, reauthoritative
at `:1553`) and `$userId` (`:1552`). The names match the onboarding function's, but they are
separate locals — this was checked, not assumed.

- [ ] **Step 4: Run the test to verify it passes**

Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1 -Output Detailed`
Expected: PASS, with every pre-existing offboarding test still green.

- [ ] **Step 5: Commit**

```bash
git add runner/modules/Coretelligent.M365/Coretelligent.M365.psm1 runner/tests/Coretelligent.M365.Tests.ps1
git commit -m "M365: apply offboardAttributes on the cloud lane

The AD lane has applied these since FR #37 and plan-resolve already puts the key
on every directory job; only the cloud lane ignored it."
```

---

### Task 6: Version bump, changelog, and close both requests

**Files:**
- Modify: `runner/VERSION` (currently `1.107.0`)
- Create: `web/lib/changelog/entries/m365-attribute-rules.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

- [ ] **Step 1: Bump the runner version**

`runner/VERSION` → `1.108.0`. A module changed, so runners must be told to update; the web half
ships on merge and the runner half does not.

- [ ] **Step 2: Write the changelog entry**

Create `web/lib/changelog/entries/m365-attribute-rules.ts`:

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-attribute-rules",
  date: "2026-08-17",
  time: "12:00",
  title: "Attribute rules now actually apply on the Microsoft 365 lane",
  items: [
    "Attributes you configure with roles & rules (title, department, office, address…) are now written to the 365 account. Previously the 365 step built a fixed list of fields from the ticket and never read your attribute rules at all, so anything you configured for a cloud client was silently ignored",
    "Attribute names are translated to what Graph expects, so the names already in your clients' configs keep working with nothing to re-enter — title, mobile, company and physicalDeliveryOfficeName all land correctly",
    "Where a rule and the ticket disagree, the RULE wins and the run report says so — e.g. \"JobTitle = 'Analyst' (rule) overrode 'Engineer' (ticket)\"",
    "An attribute 365 cannot write (extensionAttribute4, proxyAddresses, ipPhone…) is now named in the run report as skipped, instead of disappearing without a word — those stay mastered by Active Directory",
    "A manager set as a rule now applies in 365 too. The ticket still wins when it names one: a ticket knows this specific hire's manager, a client-wide rule doesn't",
    "Offboard attribute rules (offboardAttributes) now apply on the 365 lane as well — they previously only worked on the Active Directory lane",
    "Closes feature requests #0000104 and #0000087, which were the same defect reported twice",
  ],
};
```

- [ ] **Step 3: Register the entry**

Add one line to `web/lib/changelog/entries/_registry.ts`, in id order (between the `m365…` entries
already present):

```ts
export { entry as m365AttributeRules } from "./m365-attribute-rules";
```

- [ ] **Step 4: Run the full test suites**

Run: `cd web && npm test` — expected: **2126 pass, 6 fail**, the same six as the recorded baseline
and no more. `registry.test.ts` must pass, which it only does if step 3 was done.
Run: `Invoke-Pester runner/tests/Coretelligent.M365.Tests.ps1` — expected: all green.

- [ ] **Step 5: Commit, PR, merge**

```bash
git add runner/VERSION web/lib/changelog/entries/m365-attribute-rules.ts web/lib/changelog/entries/_registry.ts
git commit -m "Changelog + runner bump for the M365 attribute-rules fix"
git push -u origin fr-104-m365-attribute-rules
gh pr create --title "FR #104/#87: role and rule attributes apply on the M365 lane" --body "..."
./scripts/prs.sh <n>
```

- [ ] **Step 6: Close both requests and announce**

```bash
# Dry-run each first.
npx tsx web/scripts/fr-status.ts 104 done --note "The 365 step now applies the attributes you configure with roles & rules. It previously built a fixed field list from the ticket and never read your attribute rules, so everything configured for a cloud client was ignored. Attribute names are translated to what Graph expects, so your existing config works unchanged. Where a rule and the ticket disagree the rule wins and the run report says so; an attribute 365 cannot write is now named as skipped rather than disappearing. Offboard attribute rules apply on the 365 lane too."
npx tsx web/scripts/fr-status.ts 87 done --note "Same defect as #0000104 and fixed by the same change: the 365 step never read your configured attribute rules. It now does. See #0000104 for the detail."
npx tsx web/scripts/announce-merged.ts --pr <n> --audience both --dry-run
npx tsx web/scripts/announce-merged.ts --pr <n> --audience both
```

---

## Verification

End-to-end, beyond the unit tests:

1. **Confirm the real client's config now maps cleanly.** All ten of `core397`'s configured
   attributes must resolve to a Graph name — Task 1's fourth test asserts exactly this, using BEV's
   real list.
2. **Run an onboard against a test account on a cloud-backbone client** with an attribute rule set,
   then read the user back in Graph and confirm the values landed. `web/scripts/sim-run-case.ts` is
   the existing harness for driving a case without touching a real client.
3. **Confirm the AD lane is untouched** — `Invoke-Pester runner/tests/Coretelligent.ActiveDirectory.Tests.ps1`
   must be green, since `Set-CtgADAttributes` is not modified by any task here.
4. **Confirm an AD-synced client still reports a clean skip** rather than a warning when Graph
   refuses an on-prem-mastered write; the existing catch block handles it and Task 3 must not
   bypass it.
5. **Confirm a client with no `attributes` behaves exactly as before** — the pre-existing intake
   attribute test is the regression guard.
