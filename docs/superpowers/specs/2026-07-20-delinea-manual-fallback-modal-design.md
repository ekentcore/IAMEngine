# Delinea manual-fallback modal — design

Date: 2026-07-20

## Problem

In the guided credential-setup flow, an operator types a credential's fields and the
app tests them, then writes the secret to Delinea (Secret Server) and wires the returned
id. When that WRITE can't happen — no write account / folder / template configured (409,
the common dev case) or Delinea auth/create fails (502) — the only feedback today is a
small inline red note in `create-in-delinea.tsx`. The operator is left with no path
forward and has to re-derive, by hand, which template and fields to create in Delinea.

## Goal

On a write/config failure, pop a modal that shows exactly how to create the secret by
hand in Delinea — the template, folder, secret name, and each field with the value the
operator already typed — and lets them paste the resulting Secret ID back to finish
wiring it. Same end state as the automatic path.

## Scope of the trigger

- **Open the modal** on failures where the app *could not write*: the **409** gate
  (missing write account / folder / template) and the **502** (Delinea auth or create
  failure).
- **Keep the inline red note** on **422**: missing required fields (fix the form) and a
  blocking live-test failure / `probeFailed` (the credential is proven bad — do not guide
  someone to vault it).
- The client decides via an explicit `manualFallback: true` flag added to the 409/502
  responses — no status-code or string matching in the UI.

## Pieces

### 1. `defaultTemplateName(secretName)` — `web/lib/secrets/delinea-templates.ts`
The app knows the template *id* (a number from env) but not its human name. Add a small
map from secret name to the Delinea template's display name, matching the names already
documented in `field-requirements.ts`:
- `m365-admin` → **Entra Azure AD Account**
- `ad-dc` → **Active Directory Account**
- `exchange-onprem` → **Active Directory Account** (service account) / configurable
- others (`adobe`, `mimecast`, `spanning`, `proofpoint`, …) → **Automation - API** default
Overridable via a `templateName` field on a `DELINEA_TEMPLATE_MAP` entry. Unknown/absent
→ `null` (modal falls back to "the appropriate template").

### 2. `CreateCapability` prop gains `templateName: string | null`
Built server-side wherever the prop is assembled (secrets-panel + setup-wizard loaders),
via `defaultTemplateName`. `folderId` is already on the prop.

### 3. `ManualDelineaModal` — `web/app/clients/_components/manual-delinea-modal.tsx`
Native `<dialog>` modeled on `cases/_components/resolution-modal.tsx`. Props:
`{ open, onClose, slug, secretName, clientName, templateName, folderId, fields, values,
onWired }` where `fields: FieldReq[]` (required fields) and `values: Record<label,value>`.
Renders:
- **Why**: the failure reason string passed in.
- **Where**: Template = `templateName ?? "the appropriate template"`; Folder =
  `folderId ?? "this client's Delinea folder"`; Secret name = `${clientName} — ${secretName}`.
- **Fields**: for each required field — the Delinea field name (`anyOf[0]`), the value the
  operator typed (copy button; secret-ish fields masked with a reveal toggle; reuse the
  `isSecretish` heuristic), and the hint.
- **Paste-back**: a "Secret ID" input + "Wire it" button → POST to the existing paste-id
  wiring endpoint (confirmed during implementation) → `onWired(id)` on success.

### 4. `create-in-delinea.tsx`
- Track a `manualHint` state; when a create response has `manualFallback`, open the modal
  instead of only setting the inline error.
- `onWired(id)` → `onCreated(id)` (same completion callback the automatic path uses).

### 5. Route change — `web/app/api/clients/[slug]/secrets/create/route.ts`
Add `manualFallback: true` to the 409 response and the two 502 responses (auth + create).
422 responses unchanged.

## Testing

- Lib test: `defaultTemplateName` returns "Entra Azure AD Account" for `m365-admin`, the
  documented names for the others, `null` for unknown, and honors an env `templateName`
  override.
- Route test: the 409 (no config) and 502 (create failure) responses carry
  `manualFallback: true`; a 422 (missing field / blocking probe) does not.

## Non-goals / unchanged

Happy path, probe/test behavior, the inline error for bad credentials, and the secret-
never-persisted invariant (the modal only re-displays the form's own in-memory values).
