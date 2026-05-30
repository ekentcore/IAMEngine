## Welcome letter (`welcome-letter`)

`Module: none (manual / templated)` · `Mode: manual` · `Build tier: 3` · `Lanes: onboard`

Client-specific welcome communication (e.g. Six One).

### Onboard lane
`always` (for clients that require it). Fill the Welcome Letter template, export as PDF, send
to the new user's work email, CC the POC, the manager, and the pod manager. Email the manager
+ POC the MS Teams #, work email, PC serial, and PC name, and attach to the case.

### Config keys
`ccPoc`, `ccManager`, `ccPodManager`, `attachToCase[]`.

### Functions
None (templated email) — could later auto-fill the template and send; manual today.

### Depends on
`m365` (email), `teams` (Teams #), `workstation` (PC S/N + name).

### Variants & gotchas
Client-specific recipients and attached fields.

### Manual fallback
Manual by design (templated).
