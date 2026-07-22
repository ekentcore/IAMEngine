# Guided setup: step-by-step automation wizard + reusable Delinea credential suggestions

**Requested by:** Evan (internallicensing@core.tech), 2026-07-22, as two enhancements to the
in-app guided credential setup (`GuidedApiSetup`).

## Goals

1. **Make the automatic (browser) setup a step-by-step wizard** — walk the operator through
   the automation as visibly and easily as possible: what the automation will do, where the
   credential will land, provide the login, then a live run whose progress advances step by
   step, then a clear "done" with the vaulted secret.
2. **A reusable "Suggest from Delinea" affordance** — anywhere the operator must supply a
   credential reference (the API cred *or* the console login), a button searches the client's
   own Delinea folders and suggests which existing secrets to use, ranked, showing name, note,
   folder path + id, template, and why it matched — so the operator picks instead of hunting.

Non-goal (phase 2): pausing a running browser flow to prompt for an interactive 2FA/OTP code.
Most console logins use the stored OTP field; a live pause/resume handshake is deferred.

## Current state (post-#200)

- `web/app/clients/_components/guided-api-setup.tsx` is a modal with three tabs (paste fields,
  existing Delinea id, Automatic browser). The Automatic action is already catalog-driven:
  each `ApiSetupEntry` carries `autoBrowser`, `autoCreateEndpoint`, `autoConsoleSecret` and one
  generic `createApiApp()` POSTs `entry.autoCreateEndpoint` and polls its GET `{done, ok, externalId}`.
- `web/lib/secrets/api-setup-catalog.ts` — 8 vendor entries; `steps[]` are the console
  instructions; `SECRET_FIELD_REQUIREMENTS` defines each secret's fields.
- Delinea search primitives already exist in `web/lib/secrets/delinea-search.ts`:
  `listFolderSecrets(cfg, folderId, token)` returns every secret under a folder tree
  (`{ id, name, folderPath, secretTemplateId, secretTemplateName }`, names/metadata only,
  restricted included) and `listAllFolders`. `deriveClientFolderId` / `Client.delineaFolderId`
  locate the client's root folder. Notes are NOT in the listing — a per-secret `/summary`
  fetch is needed for a note.

## Design

### Component 1 — `DelineaSuggestions` (reusable) + its route

A read-only, self-contained component that, given a `slug` and a target `secretName`, shows
ranked existing-secret suggestions and calls back with the chosen `externalId`. Used in BOTH
the API-cred step and the Automatic login step (and anywhere else a secret ref is entered).

**Route:** `GET /api/clients/[slug]/delinea-suggestions?secret=<name>`
- Guard `client.edit_secrets` + client scope (out-of-scope → 404). Requires Delinea read config.
- Resolve the client folder: `Client.delineaFolderId` → `deriveClientFolderId` fallback. If none,
  return `{ suggestions: [], folderResolved: false }` (the UI shows "no client folder known").
- `listFolderSecrets(clientFolderId)` → candidate set (names/metadata only).
- **Rank** each candidate (pure function `rankDelineaSuggestions`, unit-tested):
  - **template match** — candidate `secretTemplateName` equals the target's template
    (`DEFAULT_TEMPLATE_NAMES[secretName]`, e.g. "Automation - API"): strong signal.
  - **name/keyword match** — candidate name contains a vendor alias for the target
    (`SUGGESTION_ALIASES[secretName]`, e.g. adobe → [adobe, umapi], mimecast → [mimecast],
    egnyte, knowbe4, slack, zoom, spanning; plus the console-login variants). Also matches the
    literal secret name / "(auto)" label the write path stamps.
  - **folder match** — candidate `folderPath` ends in the module's target subfolder
    ("Vendor") or "Identity Services": moderate signal.
  - **recency** — if the listing/summary exposes a usable date, newer ranks higher (tie-break only).
  - Each contributing signal is recorded as a human `reason` string ("template: Automation - API",
    "name matches 'adobe'", "in Vendor subfolder").
- Keep candidates with score > 0, sort desc, cap at ~25. **Fetch the note for the top ~5**
  (per-secret `/summary` or detail; best-effort, never fails the request) and attach.
- Return `{ folderResolved: true, suggestions: [{ secretId, name, folderPath, folderId,
  template, note?, score, reasons[] }] }`. Names/notes/metadata only — never a value.

**UI:** a "🔎 Suggest from Delinea" button next to any secret-ref input. Clicking it opens the
panel: top suggestions first, each a row with name, folder path + id, template, note (top few),
and "why" chips; a "browse all N in this client's folders" expander for the rest. Selecting a
row fills the field with its `externalId` and (in the existing-id flow) runs the existing
test-then-wire path. Purely additive — typing an id by hand still works.

### Component 2 — the automatic setup **wizard** (rework `guided-api-setup.tsx`)

Replace the tabbed modal with a linear stepper, catalog-driven. Steps for an automatic vendor:

1. **Overview** — vendor name, target Delinea folder (client's "Vendor" subfolder), and the
   source choice: **Automatic (browser)** (default), **Paste fields**, **Use existing Delinea id**.
   The chosen source decides which later steps show.
2. **Console prep** — the vendor's `steps[]` as a numbered checklist (what the automation does /
   what to have ready). Read-only; "Next".
3. **Login** — supply the console login (`autoConsoleSecret`). The `DelineaSuggestions` button is
   here; the operator picks an existing login secret or confirms the wired one. (Paste-source
   vendors instead show the field inputs here, also with the Suggest button.)
4. **Run** — launch `POST entry.autoCreateEndpoint`; poll its GET. The console checklist from
   step 2 **advances by coarse stage** (sign-in → create app → harvest → vault) as the runner
   reports progress. Errors surface inline with the stage they failed at.
5. **Done** — the vaulted Delinea secret id + provenance (from `ModuleSetupCredential`), and a
   "Test connection" link.

Non-automatic vendors (Proofpoint) show steps 1–3 with paste/existing only (no Run/Done-run).
The stepper reads everything from the catalog entry; a new vendor needs no wizard code.

### Component 3 — coarse live progress (runner + job)

The vendor browser flows already log stages internally. Make them **emit** those stages on the
job's progress channel (`Job.progress` / the dispatch job the create-api route polls), and have
the create-api **GET** return the current stage. The wizard maps stage → checklist item:
`signin → create → harvest → vault → done`. If a flow doesn't emit a stage yet, the Run step
shows an indeterminate "working…" until the terminal `{done, ok, externalId}` — no regression.
No screenshots, no per-selector detail.

## Data flow

Wizard (client) → `GET /delinea-suggestions` (login/cred pick) → operator selects → field holds
`externalId` → `POST /<vendor>-setup/create-api` (dispatch browser job) → runner flow signs in
with the login secret, creates the app, harvests, and the create-api result-poll vaults the API
secret to the Vendor subfolder + writes `ModuleSetupCredential` → GET poll streams stage → wizard
advances → Done shows the vaulted id.

## Error handling

- No Delinea read config / no resolvable client folder → suggestions route returns empty with a
  clear reason; wizard still allows manual entry.
- Note fetch failure for a candidate → omit the note, keep the suggestion.
- Browser run failure → Run step shows the failing stage + error; the paste/existing sources
  remain available as the fallback (and are the reliable path for org-SSO tenants).
- All routes gate on `client.edit_secrets` + client scope; suggestions never expose values.

## Testing

- `rankDelineaSuggestions` — pure unit tests: template-only, name-only, folder-only, combined
  ranking order; alias matching per vendor; reasons emitted; score>0 filter; cap.
- Suggestions route — folder resolved vs not; scope/config gates; top-N note attach is best-effort.
- Wizard — source selection gates later steps; stage→checklist advancement; done shows the id;
  non-automatic vendor skips the Run step. (Logic-level tests over the stepper helpers.)

## Scope / phasing

- **v1:** the reusable `DelineaSuggestions` component + route + ranking; the step-by-step
  automatic wizard; coarse stage progress.
- **Phase 2:** inline OTP/2FA pause-resume during the Run step.

## Deploy notes

Web-only for the wizard + suggestions + route. The coarse-progress emit is a small runner change
(bump `runner/VERSION`) — but it degrades gracefully, so the wizard ships without waiting on it.
No DB migration (`ModuleSetupCredential` already exists from P0a).
