# AD email write-back (`ad-email-writeback`)

`Module: Coretelligent.ActiveDirectory` (rides the AD module) · `Mode: api (agent)` ·
`Build tier: 2` · `Appears in: every Active-Directory client` · `Lanes: onboard`

Write the user's mailbox email back into on-prem AD's `mail` attribute after the cloud
account/mailbox exists, so AD (and the GAL/downstream that read `mail`) reflect the real
address. The AD create step sets `proxyAddresses = SMTP:<upn>` but never `mail`; this
closes that gap.

Backbone relevance — on-prem-origin only (`ad_synced` / `ad_standalone`). It's a
synthetic, planner-injected step (no per-client `ClientSystem` row): `planCase` adds it
for any onboard whose plan has `active-directory` + a cloud consumer (`m365`/`exchange`).

### Auth
`ad-dc` (the domain-controller / RSAT credential the AD module already uses). **No cloud
credential** — the assigned address is resolved app-side (see below) and handed to the
agent in the payload, so client-network agents need no Graph/EXO modules.

### Onboard lane
`when: always` (for AD clients). Depends on `m365` (and `exchange` when present) so it
runs after the mailbox exists. Steps (idempotent):
1. Resolve the address: `writebackEmail` from the payload → fall back to `workEmail` →
   `userPrincipalName`.
2. Resolve the AD user: `SamAccountName` → `UserPrincipalName` → unique `DisplayName`.
3. Read the current `mail`; if it differs, `Set-ADUser -EmailAddress <addr>`. No-op when
   already equal.

Post-condition: `mail == <assigned primary SMTP>`; the following `directory-sync` (if the
client has one) pushes the attribute up. `Confirm-CtgADEmailWriteback` re-reads `mail` and
checks it equals the target.

### How the address reaches the agent (B1)
Not known at plan time (the mailbox doesn't exist yet), so it's injected at **dispatch**:
the M365 onboard executor returns `PrimarySmtpAddress` (read from Graph `mail`, falling
back to the UPN); `runner-service.claim` reads the sibling `m365`/`exchange` **succeeded**
job's result (exchange preferred), and injects it into this job's payload as
`writebackEmail`. If no result carries an address (older runner), the executor's fallback
to `workEmail`/`upn` — the same value AD's `proxyAddresses` already used — keeps it correct.

### Offboard lane
None.

### Config keys
None currently. (Future: `mailAttribute` if a client records email somewhere other than
`mail`; `alsoProxyAddresses` to also normalize the primary `SMTP:` proxy.)

### Functions
- `Invoke-CtgADEmailWriteback -User <payload> -Config <config> -AdConnection <splat>` →
  `{ System='ad-email-writeback'; Status='ok'; Sam; Mail; Actions[] }`.
- `Confirm-CtgADEmailWriteback` (read-only verify) → `{ ok; checks[] }`.
- `Resolve-CtgWritebackEmail` helper (writebackEmail → workEmail → UPN).

### Depends on
`m365`, `exchange` (whichever are active on onboard). Routed on-prem via
`ALWAYS_ON_PREM_SYSTEMS`; its capability maps to `active-directory` (rides the AD module),
so an AD-capable agent runs it with no new capability to advertise.

### Variants & gotchas
- **Hybrid mail authority:** in a synced tenant `mail`/`proxyAddresses` are on-prem
  authoritative, so writing `mail` here and letting `directory-sync` push it up is correct;
  the cloud won't have changed it. For these clients the assigned address usually equals the
  UPN, so the fallback path is already right.
- **UPN domain ≠ mail domain:** when the AD/UPN domain is a subdomain of the mail domain,
  the M365-returned `PrimarySmtpAddress` (mail domain) is preferred over the raw UPN.
- **Idempotent / re-runnable:** a re-run after the address is set is a no-op.
- **Exchange is offboard-only** for most AD clients, so on onboard the address comes from
  the `m365` result — that's why M365 returns `PrimarySmtpAddress`.

### Manual fallback
If the agent can't resolve the user or no address is available, it returns `ok` with a
WARN action and writes nothing — an operator sets `mail` by hand (rare).
