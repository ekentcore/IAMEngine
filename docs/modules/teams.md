## Teams phone (`teams`)

`Module: Coretelligent.Teams` · `Mode: api` · `Build tier: 3` · `Appears in: ~6%` · `Lanes: onboard`

Calling/phone-number provisioning with write-back to other systems.

### Auth
Secret: `teams-admin` (Teams Admin / Graph with Teams calling rights).

### Onboard lane
`on-request`. Assign a phone number based on the office area code (e.g. Stamford 203,
Houston 346, Singapore +65). Then write the number back: ServiceNow contact business phone,
AD `telephoneNumber`, and case notes.

### Config keys
`phoneByAreaCode{office:code}`, `writeBack[]` (servicenow/ad/case-notes).

### Functions
`Invoke-CtgTeamsPhone`, `Set-CtgPhoneWriteBack`.

### Depends on
`m365` (licensed with Teams Phone/Calling Plan), `servicenow`, `active-directory` (writeback).

### Variants & gotchas
Geo-based number selection; the write-back to three systems is part of the step, not optional.

### Manual fallback
Number assignment via Teams Admin portal.
