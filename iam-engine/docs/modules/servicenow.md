## ServiceNow (`servicenow`)

`Module: Coretelligent.ServiceNow` · `Mode: api` · `Build tier: 1` · `Appears in: ~90%` · `Lanes: both`

The root of every case: the ServiceNow contact must exist before any system is provisioned,
and the case is the audit trail (work notes) and the closeout. Backbone-independent.

### Auth
Secret: `servicenow-admin` (instance URL + service account; Basic or OAuth). Table API.

### Onboard lane
`always`. (1) Ensure the case is UM-converted; if not a UM, convert so the contact is
created. (2) Confirm/create the contact and populate email, phone, location, title from the
case payload. The contact is a hard prerequisite for downstream jobs.
Post: contact exists and is active.

### Offboard lane
`always`. UM cases auto-mark the contact inactive and lock it at the End Date; if not
converted (urgency), find the user and mark inactive manually. Mark case Action Required
per the offboarding form.

### Config keys
`requiredFields` (default email/phone/location/title), `convertNonUmCases` (bool),
`contactTable` (instance-specific), `caseTable`.

### Functions
`Get-CtgServiceNowCase`, `ConvertTo-CtgOnboardingUser` (case → normalized user),
`New-CtgServiceNowContact`, `Set-CtgContactInactive`, `Add-CtgCaseWorkNote`,
`Close-CtgCaseTasks`. (Skeletons exist in `runner/lib/Coretelligent.ServiceNow`.)

### Depends on
None (root). Every other job posts a work note here; `case-resolution` closes tasks.

### Variants & gotchas
UM vs non-UM conversion logic; catalog-item variable names differ by client form (most
match the uploaded New User / Offboard forms — reconcile deviations from `otherNeeds`);
contact table name varies by instance (`customer_contact` / `csm_consumer`).

### Manual fallback
If conversion fails, the contact step is surfaced as a manual checklist item.
