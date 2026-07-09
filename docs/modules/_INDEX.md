# Module index — the complete plan

Every system the engine can act on, with build priority, lanes, frequency (share of
clients from the corpus analysis), and status. Specs live alongside this file.

## Build tiers

- Tier 1 — universal core, build first: present in 70–91% of clients.
- Tier 2 — high-leverage, build next: 18–37%, includes the on-prem AD path.
- Tier 3 — long tail, build as clients need them: ≤15%, mostly `on-request`/manual.

## Catalog

| Module / key | Mode | Tier | Lanes | ~Clients | Status | Notes |
|---|---|:--:|---|---|---|---|
| ServiceNow `servicenow` | api | 1 | both | 90% | spec | root: contact + worknotes + task closure |
| Microsoft 365 `m365` | api | 1 | both | 90% | built | create/license/groups/alias |
| Entra `entra` | api | 1 | mostly off | 90% | spec | disable, app access, MFA/session revoke |
| Exchange `exchange` | api | 1 | off | 90% | spec | mailbox convert/forward/OOO/delegate |
| Case resolution `case-resolution` | api | 1 | both | 90% | spec | deliver creds, verify MFA, close tasks |
| Active Directory `active-directory` | api | 2 | both | 37% | spec | create+attrs+groups; evidence+disable |
| Directory sync `directory-sync` | api | 2 | both | 37% | spec | Start-ADSyncSyncCycle + verify |
| Mimecast `mimecast` | api | 2 | both | 88% | spec | email security (vendor variant) |
| Proofpoint `proofpoint` | api | 3 | both | 2% | built | read-only sync verify (no API trigger) |
| Adobe `adobe` | api | 2 | both | 18/37% | spec | license assign/remove/transfer |
| Google Workspace `google-workspace` | api | 2 | both | 25% | spec | identity origin for google clients |
| KnowBe4 `knowbe4` | api | 2 | both | 27% | spec | usually AD-group-driven |
| Spanning `spanning` | api | 3 | both | 28/15% | spec | backup; archive license swap on offboard |
| SharePoint `sharepoint` | api | 3 | both | 15% | spec | site membership |
| Zoom `zoom` | api | 3 | both | 14/34% | spec | license; deactivate |
| Slack `slack` | api | 3 | both | 7% | spec | multi-workspace |
| Egnyte `egnyte` | api | 3 | both | 12/30% | spec | power user + SSO + groups |
| Egnyte Sync Server `egnyte-sync-server` | browser | 3 | onboard | few | spec | appliance, no API |
| MDM `mdm` | api | 3 | both | 7% | spec | Addigy/Jamf/Intune (vendor variant) |
| Dropbox `dropbox` | api | 3 | mostly off | 19% off | spec | data custody on offboard |
| Perimeter 81 `perimeter81` | api | 3 | both | 1% | spec | VPN; license downtick on offboard |
| Teams phone `teams` | api | 3 | onboard | 6% | spec | phone by area code + writeback |
| AVD `avd` | api | 3 | both | 1% | spec | session-host assign/unassign |
| 1Password `1password` | api | 3 | both | 1% | spec | two secrets (login + security key) |
| Notion `notion` | api | 3 | onboard | 1% | spec | Google-SSO invite |
| Tableau `tableau` | manual | 3 | onboard | <1% | spec | champion-driven licensing |
| Printix `printix` | api | 3 | onboard | 3% | spec | geo-group driven |
| Address book `address-book` | browser | 3 | onboard | few | spec | printer web UI |
| Data transfer `data-transfer` | api | 2 | off | — | spec | cross-system custody pattern |
| Archive `archive` | api | 3 | off | — | spec | deferred 30–90 day step |
| Hardware `hardware` | manual | 3 | off | — | spec | device backup/wipe |
| Workstation `workstation` | manual | 3 | onboard | — | spec | device setup, onsite check |
| Welcome letter `welcome-letter` | manual | 3 | onboard | few | spec | filled template + emails |
| First-day call `first-day-call` | manual | 3 | onboard | few | spec | scheduled day-1 login check |
| Equipment return `equipment-return` | manual | 3 | off | few | spec | shipping logistics |

## Cross-cutting patterns (apply to every module)

- Idempotency — every action checks state before changing it; re-runs converge. The
  `m365` module is the reference.
- Email security is a capability with a vendor variable — `mimecast` (dominant) or
  `proofpoint`. A client has one; the orchestrator treats them as the same slot.
- License procurement — many systems support "if no license, procure" via different
  channels (procurement case, Kaseya, SYNNEX/Ingram, in-console purchase). Modeled per
  license as `procureIfUnavailable`; offboarding has the inverse (`downtick`/reclaim),
  sometimes with ordering (Spanning runs after mailbox conversion + license removal).
- Group-driven provisioning — some systems aren't provisioned directly; membership in an
  AD/365 security group drives them (KnowBe4, Printix, sometimes Perimeter 81). Those
  modules verify rather than create, and offboarding cascades on group removal.
- Evidence + approval + guardrails (offboard) — `captureEvidence` snapshots membership/app
  access to the case before removal; `requiresApproval` gates destructive steps server-side
  (no device wipe / no account delete without recorded POC approval); `guardrails`
  (`do-not-move-ou`, `do-not-delete`, `no-device-wipe-without-approval`) encode the
  client-specific traps that are catastrophic to get wrong.
- Scheduling — some offboard steps are deferred (archive after 30–90 days). `immediateTermination`
  in the case payload collapses scheduled steps to run now.
- Dynamic vs assigned groups — dynamic (rule-based) groups are verified, never added to.

## Build order (volume-weighted)

1. `servicenow`, `m365`, `case-resolution` — covers the entra-backbone top-20 clients.
2. `active-directory` + `directory-sync` + `entra` + `exchange` — the AD/hybrid path and
   the offboard teardown; unlocks the AD top-20 clients end to end.
3. `mimecast` — near-core, needed by most.
4. `adobe`, `google-workspace`, `knowbe4`, `spanning` — the tier-2/high-tail cluster.
5. The remaining tier-3 modules + the `egnyte-sync-server`/`address-book` browser fallback.
