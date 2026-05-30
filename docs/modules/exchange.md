## Exchange (`exchange`)

`Module: Coretelligent.M365` (shared) · `Mode: api` · `Build tier: 1` · `Appears in: ~90%` · `Lanes: offboard`

Mailbox handling on departure. Shared Graph/Exchange Online module.

### Auth
Secret: `m365-admin`. Exchange Online management (Graph mail scopes or EXO PowerShell).

### Offboard lane
`always`. Hide from GAL, convert mailbox to shared (skip if over the size threshold — keep
the licensed mailbox). On request: set OOO, apply forwarding, add delegates. Block mobile
devices; disable Exchange ActiveSync and OWA (keep OWA if delegate access is needed).

### Config keys
`hideFromGal`, `convertToShared{value,skipIfMailboxOverGB,unless}`, `onRequest[]`
(ooo-message/email-forwarding/email-delegates), `blockMobileDevices`, `disable[]`.

### Functions
`Invoke-CtgExchangeOffboarding`, `Convert-CtgMailboxToShared`, `Set-CtgMailboxForwarding`,
`Set-CtgMailboxOoo`, `Add-CtgMailboxDelegate`.

### Depends on
`m365`. Must run before `m365` license removal and before `spanning` archive swap.

### Variants & gotchas
> 50 GB → do not convert; keep delegate via OWA; ordering vs license removal is load-bearing
(removing the license too early can orphan or delete the mailbox/account).

### Manual fallback
None expected.
