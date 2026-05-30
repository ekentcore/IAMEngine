# Module spec template

Every file in `docs/modules/` follows this shape so Claude Code can build each module
without re-deriving the contract. Keep specs dense; the detail is the point.

---

## <Module name> (`system-key`)

`Module: Coretelligent.<Name>` · `Mode: api | browser | manual` · `Build tier: 1|2|3`
· `Appears in: ~N% of clients` · `Lanes: onboard / offboard / both`

One-line purpose.

Backbone relevance — is this the identity origin (entra/google/ad), a downstream mirror,
or backbone-independent.

### Auth
Secret(s) consumed (logical names → Delinea refs), the API/SDK used, and the exact
scopes/permissions/service-account setup required.

### Onboard lane
`when`. Ordered, idempotent steps. Inputs (profile `config` keys + case payload fields).
Post-conditions / verification.

### Offboard lane
`when`. Ordered steps. Evidence capture, approval gates, guardrails, data-transfer
targets, lane-specific ordering.

### Config keys
The per-client `ClientSystem.config` keys this module reads, with types and meaning.

### Functions
PowerShell entry points to implement (`Invoke-Ctg<Name>Onboarding` / `...Offboarding`
plus helpers), with their inputs/outputs.

### Depends on
System keys that must complete first (and lane-specific differences).

### Variants & gotchas
Real behaviors observed across the corpus that the implementation must handle.

### Manual fallback
What stays manual / what the browser fallback covers if there's no clean API.
