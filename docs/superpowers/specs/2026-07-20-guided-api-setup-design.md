# Guided API setup for Mimecast / Spanning / Proofpoint — design

Status: **approved design, ready for implementation plan**
Date: 2026-07-20

## Summary

Give each API-credential system a **"Setup <system> API"** item in the client
Actions menu — shown only when the client actually has that system — that walks
the operator through obtaining the vendor's API credential, **live-verifies it by
connecting**, then **vaults it to Delinea and wires it onto the client**.

This is a single generic, per-system-configured engine (not three bespoke
buttons). It ships for **Mimecast, Spanning, and Proofpoint**, and adding a
fourth later (Adobe, Zoom, …) is one config entry. It reuses the existing
create-in-Delinea route, the value-probe registry, and the Delinea write
primitives — very little new plumbing.

The same change **gates the existing "Set up M365 automatically"** item on the
client being an M365/Entra client (it currently always shows).

## Why guided, not browser automation

M365's automation works because after the admin sign-in it **mints** the
credential via the Graph API — the browser never touches a secret. Mimecast,
Spanning and Proofpoint have **no equivalent**: their API credentials can only be
created by clicking through the vendor admin console, and the generated secret is
shown once. Fully automating that means a browser bot navigating each vendor's
console UI to create an app and scrape the one-time secret — brittle against
vendor UI changes, **untestable in this environment** (Playwright browser flows
can't be exercised here; even the M365 device-code flow is "live-validation
pending"), and unprecedented (the connector browser lane harvests session
cookies, not vendor-generated API keys). Mimecast's console isn't even
Microsoft-SSO.

**Decision (approved):** guided **verify-then-vault**. The operator creates the
API app in the vendor console (the modal gives per-vendor steps + a console
link); the tool verifies the resulting credential by connecting, then vaults it.
Robust, its logic is unit-testable, and it works today.

## Goals

- One reusable "guided API setup" engine, parameterized per system.
- Ship Mimecast, Spanning, Proofpoint.
- Conditional menu visibility: "Setup X API" shows **only** when the client has
  system X; gate "Set up M365 automatically" on m365/entra/exchange.
- Two input modes: **paste the raw credential fields**, or **give an existing
  Delinea secret id**. Either way, **live-verify before saving**.
- On success: vault (create the Delinea secret, or reuse the existing id) + wire
  the reference onto the client + stamp an "(auto)" label (mirroring M365).

## Non-goals

- No browser automation / console scraping.
- No new Delinea plumbing (reuse createSecret/updateSecretFields/templates).
- No runner-module auth changes for Mimecast/Spanning (they already read these
  secrets). The **only** possible runner touch is a one-line Proofpoint region
  read **if** the plan picks region option A (see §2) — decided after reading the
  module, not assumed here.

## Components

### 1. Per-system catalog — `web/lib/secrets/api-setup-catalog.ts` (new)

A small pure registry, one entry per setup-able system:

```ts
type ApiSetupEntry = {
  systemKey: string;      // e.g. "mimecast" — gates the menu item on sysByKey.has(systemKey)
  secretName: string;     // the Delinea secret name to create/verify/wire (e.g. "mimecast")
  label: string;          // menu + modal title, e.g. "Mimecast"
  consoleUrl: string;     // "Open console ↗" deep-link
  steps: string[];        // vendor instructions shown in the modal
  regionField?: {         // Proofpoint: a required region the probe needs (no region in the secret)
    label: string;
    options: string[];    // e.g. ["us1","us2","us3","us4","us5","eu1","au1"]
    // maps to the field the create route stores + the probe reads
    fieldLabel: string;
  };
};
export const API_SETUP_CATALOG: ApiSetupEntry[];       // mimecast, spanning, proofpoint
export function apiSetupFor(systemKey: string): ApiSetupEntry | undefined;
```

Field shapes come from the existing `SECRET_FIELD_REQUIREMENTS` (field-requirements.ts):
- **mimecast** — client id + client secret (OAuth2 client-credentials).
- **spanning** — account/api user + api token + region-or-base-url.
- **proofpoint** — admin email (X-User) + admin password (X-Password) + org
  domain (defaults to the client's primary domain).

### 2. Verification — extend the value-probe registry — `web/lib/secrets/value-probe.ts`

Add **blocking, app-side** provers (cloud SaaS HTTP; fully unit-testable with an
injected `fetch`, exactly like the existing `m365-admin` prover). A failed probe
**refuses** the vault write.

- **mimecast**: `POST https://api.services.mimecast.com/oauth/token`
  (`grant_type=client_credentials`, client_id/secret) → a token = ✓.
- **spanning**: `GET https://o365-api-{region}.spanningbackup.com/external/…`
  with Basic auth (id:token) → 2xx = ✓. Region from the secret's region field
  (default `us`); a full base-url field overrides.
- **proofpoint**: `GET https://{region}.proofpointessentials.com/api/v1/orgs/{domain}/settings/azure`
  with `X-User`/`X-Password` headers → 200 = ✓. The credential carries **no
  region** field today, so the region needs a home (see the Proofpoint region
  decision below).

**Proofpoint region — decision to confirm in the plan.** The Explore pass found
Proofpoint's secret has no region field, yet the API base is region-specific
(`us1..us5`, `eu1`, `au1`). Two options:
  - **(A, recommended) Store it.** Add a `region` field to the `proofpoint`
    entry in `SECRET_FIELD_REQUIREMENTS` and its Delinea template, so the region
    is vaulted with the credential. The app-side probe reads it, **and** the
    runner can read it too (fixing "how does the runner know the region?" if it
    currently guesses). Small: one field-requirements entry + a template-map key;
    verify the runner's Proofpoint module reads the region field (it may need a
    one-line change — the only place this feature would touch the runner).
  - **(B) Transient-only.** The form's region is passed to the app-side probe as
    a one-off input and never stored; the runner keeps whatever region mechanism
    it uses today. Simpler here, but leaves the runner's region source unchanged
    and unverified.
  The plan must pick one after reading `Coretelligent.Proofpoint.psm1` to see how
  the runner resolves the region today. Mimecast (fixed base URL) and Spanning
  (region already a field) have no such question.

`isProbeable`/`probeSecretValues` already dispatch by secretName — no interface
change, just three new entries.

### 3. UI — one generic modal + menu wiring

**Menu (`web/app/clients/_components/client-actions-menu.tsx`):**
- The page passes the client's `systemKeys` to the menu.
- For each `API_SETUP_CATALOG` entry whose `systemKey` the client has, render a
  **"Setup <label> API"** menu item that opens the guided modal for that entry.
- **Gate M365**: render "Set up M365 automatically" only when the client has
  `m365`, `entra`, or `exchange`.

**Guided modal (`web/app/clients/_components/guided-api-setup.tsx`, new — one
component, parameterized by the catalog entry):**
1. Header: the vendor's steps + an **"Open console ↗"** link.
2. Input toggle:
   - **Paste fields** — one input per `SECRET_FIELD_REQUIREMENTS` field (+ the
     region picker for Proofpoint).
   - **Use an existing Delinea id** — a single secret-id input.
3. **Verify & save**:
   - Paste mode → POST the existing `POST /api/clients/[slug]/secrets/create`
     (which shape-checks → value-probes → creates in Delinea → wires + can label).
   - Existing-id mode → a verify-then-wire path (resolve the secret's field
     values via `resolveSecretFields`, run the same value-probe, then
     `upsertSecrets` to wire — no create).
   - Show the verdict (✓ "connected to <vendor>" / ✗ reason), like the M365
     value-probe result. Stamp an **"(auto)"** wiring label on save.
   - On success `router.refresh()` so the Secrets panel reflects the wiring
     (same pattern just shipped for M365).

### 4. Route work

- **Paste mode reuses** `POST /api/clients/[slug]/secrets/create` unchanged
  (it already: field-shape gate → `probeSecretValues` (blocking refuses) →
  `createSecret` → wire). The new value-probe entries make it verify
  mimecast/spanning/proofpoint.
- **Existing-id mode**: extend `POST /api/clients/[slug]/secrets/test` (or a small
  new endpoint) to, on success, also **wire** the id (upsertSecrets) — i.e.
  "verify this existing Delinea id and, if it authenticates, wire it." Decision:
  add a `wireOnPass: true` option to the existing test route rather than a new
  route, to keep the surface small.

### 5. Conditional visibility (the cross-cutting requirement)

- "Setup <label> API" ⇔ `sysByKey.has(systemKey)` for a catalog system.
- "Set up M365 automatically" ⇔ `sysByKey.has("m365") || has("entra") || has("exchange")`.
- A Google-Workspace-only client shows neither M365 nor Mimecast/Spanning/
  Proofpoint setup; a Proofpoint client shows only "Setup Proofpoint API"; etc.

## Data flow

```
Actions ▾ → "Setup Mimecast API"
  → GuidedApiSetup(entry = catalog["mimecast"])
    → operator creates the 2.0 app in the Mimecast console (steps + Open console)
    → paste Client ID + Client Secret     OR     enter an existing Delinea id
    → Verify & save
       paste:      POST /secrets/create { name:"mimecast", values } → probe → create → wire (+label)
       existing:   POST /secrets/test  { name:"mimecast", externalId, wireOnPass:true } → resolve → probe → wire (+label)
    → verdict shown; router.refresh() → Secrets panel shows the wired id
```

## Error handling

- **Probe fails** (bad creds / can't reach vendor): the create route already
  refuses the write on a blocking probe failure and returns the reason; the modal
  shows it. Nothing is vaulted.
- **Existing-id verify fails**: surface the reason; do **not** wire.
- **Delinea write not configured** for the client: the create route already
  returns a config-needed signal → the modal points to Secret wiring, same as the
  M365 flow.
- **Proofpoint region unknown**: the region is required in the form, so the probe
  always has one; if a client's region is genuinely unknown, the operator can
  still paste-and-save (the probe is skippable only if we choose to make
  Proofpoint advisory — default is blocking with a chosen region).

## Testing

- **value-probe** unit tests for mimecast/spanning/proofpoint (injected fetch:
  200/401 → ✓/✗, missing fields → refuse).
- **catalog** test (one entry per intended system; secretName matches
  field-requirements).
- **menu visibility** — items render iff the client has the system; M365 gated.
- **route** — existing-id verify-then-wire wires only on a passing probe.
- No browser/runner in any test (all app-side).

## Rollout / config

- Delinea template names for `mimecast`/`spanning` are **already** mapped
  (`DEFAULT_TEMPLATE_NAMES` → "Automation - API"); Proofpoint needs its template
  mapped (`DELINEA_TEMPLATE_PROOFPOINT` or the default map) — a config item, not
  code.
- No migration. No runner change for Mimecast/Spanning; a possible one-line
  Proofpoint region read only under region option A (see §2).

## Open decisions (resolved)

- **Approach**: guided verify-then-vault (not browser automation). ✔
- **Genericity**: one engine; ship Mimecast + Spanning + Proofpoint. ✔
- **Input**: both paste-raw and existing-Delinea-id, both live-verified. ✔
- **Proofpoint region**: the form asks the operator to pick it (blocking probe
  with the chosen region). Whether it's **stored** (option A) or **transient**
  (option B) is the one thing left for the implementation plan to settle after
  reading the runner's Proofpoint module. ✔ (approach), ⏳ (storage detail)
- **Placement**: in the client Actions ▾ menu, per the M365 pattern. ✔
- **M365 gate**: show "Set up M365 automatically" only for m365/entra/exchange
  clients. ✔

## Out of scope (possible follow-ups)

- Modeling **Exchange app-only** (`Exchange.ManageAsApp` + Exchange Administrator
  role) as an explicit capability in the rights display for Exchange-Online
  clients (today it's verified implicitly by the exchange connection test).
- Any vendor whose API credential genuinely can't be created without console
  automation (none of Mimecast/Spanning/Proofpoint fall here).
