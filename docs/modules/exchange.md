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

`hideFromGal` is **default-on** for every offboard — the planner injects it even when the
client's exchange offboard config doesn't mention it, so no per-client opt-in is required.
The runner runs `Set-Mailbox -HiddenFromAddressListsEnabled $true` against the EXO mailbox,
skips the write if the mailbox is already hidden (idempotent), and reads the attribute back
before reporting the step done. To opt a client out entirely, set `hideFromGal: false` on
its exchange offboard config; to keep one specific leaver listed, use the case-level "Keep
in global address list" checkbox on the offboard form (`skipGalHide`).

Directory-synced mailboxes can't be hidden directly from Exchange Online — the attribute is
owned on-prem. For those clients, hiding is instead performed by the `active-directory`
offboard lane's own `hideFromGal: { attribute, value }` config (e.g.
`{ attribute: "msExchHideFromAddressLists", value: true }`), and this Exchange step WARNs
rather than fails if it's asked to hide a mailbox it detects is synced.

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
