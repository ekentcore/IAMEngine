## KnowBe4 (`knowbe4`)

`Module: Coretelligent.KnowBe4` (often none — group-driven) · `Mode: api` · `Build tier: 2` · `Appears in: ~27%` · `Lanes: both`

Security-awareness training. Usually provisioned via an AD/365 security group
(`KnowBe4_Users`) rather than directly, so onboarding is "add to the group" (handled by the
AD/M365 module) and offboarding cascades when groups are removed.

### Auth
Secret: `knowbe4-admin` (KnowBe4 API) — only if direct provisioning is used.

### Onboard lane
`always` for KnowBe4 clients — typically just ensure the `KnowBe4_Users` group membership is
applied upstream; verify the user syncs into KnowBe4. Direct API create only if no group sync.

### Offboard lane
`always` — removal cascades on group removal/AD disable; verify deactivation.

### Config keys
`provisioning` (group-driven | api), `group`, `verify`.

### Functions
`Confirm-CtgKnowBe4User`, (optional) `Invoke-CtgKnowBe4Provision`/`Disable`.

### Depends on
`active-directory` / `m365` (group membership + sync).

### Variants & gotchas
Mostly verify-only because it's group-driven; note the cascade so offboarding doesn't
double-handle it.

### Manual fallback
Verify/deactivate in the KnowBe4 console.
