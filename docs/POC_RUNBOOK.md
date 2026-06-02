# POC runbook — running the engine end-to-end for a few clients

This is the operator guide to take iam-engine from "brain + data" to **executing real
onboarding/offboarding** for a small set of POC clients. It assumes Phases 1–3 are up (DB
seeded, clients list, case planning, runner API) and the automation modules in `runner/` are
present. See `docs/ARCHITECTURE.md` and `docs/RUNNER_PROTOCOL.md` for the why.

The modules are unit-tested (`runner/tests/`, 24 Pester tests with mocked Graph/AD/Mimecast
cmdlets) but **final validation is on a real host with a test user** — that's what this guide
sets up.

---

## 0. Topology

| Host | Runs | Reaches | Modules it needs |
|---|---|---|---|
| **Central runner** (cloud) | cloud-only systems | M365 Graph, Mimecast (outbound HTTPS) | `Coretelligent.M365`, `Coretelligent.Mimecast` |
| **Client-network agent** (on-prem) | AD + on-prem | the local DC; polls the app outbound | `Coretelligent.ActiveDirectory` (+ the above for hybrid) |

`entra`-backbone clients need only the central runner. `ad-synced` clients (e.g. Six One)
need the client-network agent too.

---

## 1. Prerequisites (per host)

- **PowerShell 7+** (`pwsh`).
- Central runner: `Install-Module Microsoft.Graph -Scope AllUsers` (the `m365` manifest pins
  `Microsoft.Graph.Authentication/Users/Users.Actions/Groups`). Mimecast needs nothing extra
  (it uses `Invoke-RestMethod`).
- Client-network agent: **RSAT `ActiveDirectory`** module on the DC/management host.
- Pester 5 only on a host where you want to run the test/smoke suite (not required to run jobs).

---

## 2. Secrets (Delinea — never values in the app or profiles)

The app only ever holds **references**; the runner resolves them to real credentials at
execution time (`runner/lib/Coretelligent.Secrets`).

1. In each POC client's profile (`profiles/<client>.json`), replace every `"id": "REPLACE_ME"`
   under `secrets` with the real Delinea secret id. The keys used by the POC modules:
   - `m365-admin` — Graph app registration (see §3).
   - `mimecast` — Mimecast 2.0 API app (client id/secret).
   - `ad-dc` — domain admin / delegated service account (agent host).
2. Re-seed so the references reach the DB: `cd web && npm run db:seed`.
3. On the runner host, set the Delinea bootstrap identity (a machine identity, ideally):
   ```bash
   export DELINEA_BASE_URL="https://coretelligent.secretservercloud.com"
   export DELINEA_USER="<svc-account>"
   export DELINEA_PASSWORD="<secret>"
   ```
   The runner calls `Connect-CtgSecretStore` at startup, then `Get-CtgSecret` per job.

---

## 3. Per-system app setup

**M365 (`m365-admin`)** — an Entra app registration with **application** permissions
`User.ReadWrite.All`, `Group.ReadWrite.All`, `Organization.Read.All` (admin-consented). Store
`UserName = <appId>`, `Password = <client secret>` in the Delinea secret. Prefer certificate
auth in production; `Connect-CtgM365` uses the client-secret flow for the POC. Tenant id is the
client's `primaryDomain`.

**Mimecast (`mimecast`)** — a Mimecast **2.0** API application (cloud-gateway). Store
`UserName = <client_id>`, `Password = <client_secret>`. `Connect-CtgMimecast` does the
OAuth2 client-credentials exchange (`POST /oauth/token`). The onboard lane triggers a directory
sync and verifies the client's internal domain.

**Active Directory (`ad-dc`)** — a delegated service account on the client network with rights
to create/disable users, manage groups, and move objects in the relevant OUs. Used only by the
client-network agent.

---

## 4. App environment (`web/.env`)

Already needed by the app, relevant to execution:

```
DATABASE_URL=...                 # Postgres
RUNNER_API_TOKEN=<shared bearer> # interim auth until mTLS; same value on the runner
SN_INSTANCE_URL / SN_USER / SN_PASSWORD     # ServiceNow (work notes, contact, attachments)
AZURE_OPENAI_ENDPOINT / _KEY / _DEPLOYMENT  # group-resolver + KB enrichment (optional)
```

---

## 5. Enroll the agent

Use the Agents UI (`/agents` → **Enroll agent**) to create the agent row and copy its id +
the enrollment/bearer token. A **central** agent has no client; a **client-network** agent is
scoped to one client (it then only sees that client's jobs).

---

## 6. Run the runner

```bash
export RUNNER_API_TOKEN=<same as the app>
pwsh ./runner/Start-IamRunner.ps1 -AppUrl https://iam-engine.internal -AgentId <agentId>
```

It heartbeats, claims eligible jobs, brokers + resolves each named secret, connects once per
(system|tenant), executes the idempotent module function, and posts the result. Destructive
offboard steps gated by `requiresApproval` won't be claimed until approved in the UI.

---

## 7. Plan and execute a case

Create a case from a ServiceNow intake (or `POST /api/cases` with `{ clientSlug, action,
payload }`). Planning orders jobs by `dependsOn`; the runner executes them as their
dependencies clear. Watch the case in the UI: each job shows `succeeded` / `failed` /
`needs_manual` / `needs_approval`, with the module's `Actions` log and any captured `Evidence`.

Smallest entra POC: a client with `servicenow` → `m365` (→ `mimecast`). Smallest ad-synced
POC (Six One): `servicenow` → `active-directory` → `directory-sync` → `m365` → `mimecast`.

---

## 8. Smoke test + validation

Run the module/wiring suite on the host before the first real case:

```bash
~/.local/pwsh/pwsh -NoProfile -c "Invoke-Pester -Path runner/tests -Output Detailed"
```

`Smoke.Tests.ps1` confirms the runner parses, every dispatched function is exported, and the
manifests are well-formed. Then validate per system with a **test user**:

- **M365 onboard** — user created (correct UPN), licenses assigned by name→SkuId, in the right
  groups, alias if requested. Re-run → all "present/already" (idempotent).
- **M365 offboard** — sign-in blocked, groups captured in `Evidence` then removed, license
  removed only when mailbox ≤ threshold (kept + flagged when over).
- **AD onboard** — user in the configured OU, home drive mapped, base + conditional groups.
- **AD offboard** — password reset, groups captured + removed, hidden from GAL, disabled, and
  **not moved** when `do-not-move-ou` is set (verify the 365 account survives).
- **Mimecast onboard** — directory sync triggered, internal domain verified.
- **directory-sync** — a delta sync starts (or is skipped because one is already running).
- **Exchange offboard** — mailbox converted to shared only when ≤ threshold; ActiveSync/OWA
  disabled; returns `MailboxSizeGB` for the m365 keep-license decision.
- **Zoom onboard/offboard** — user created (licensed) / deactivated; re-run is idempotent.
- **Adobe onboard/offboard** — added to product profiles / removed from the org (UMAPI).
- **Perimeter 81 offboard** — user found by email and removed. ⚠ Onboard is group-driven (no
  direct add); the API endpoints are best-effort — verify against the Harmony SASE tenant.

Built modules: `m365`, `active-directory`, `mimecast`, `directory-sync`, `exchange`, `zoom`,
`adobe`, `perimeter81` — all with Pester tests (`runner/tests/`, 45 green).

---

## 9. Notes

- **Idempotency**: every module checks state before changing it; a re-run after a partial
  failure is safe. If a job fails mid-case, fix the cause and re-plan/retry — completed steps
  no-op.
- **Audit**: each job writes an `AuditLog` row and queues a ServiceNow work note.
- **Approvals**: offboarding destructive steps are gated server-side, not in the UI.
- **Adding a system**: write `Coretelligent.<System>` (idempotent funcs + a manifest), add a
  `runner/tests/Coretelligent.<System>.Tests.ps1`, and register it in the `$DISPATCH` map in
  `Start-IamRunner.ps1`. The smoke test will then cover its wiring.
