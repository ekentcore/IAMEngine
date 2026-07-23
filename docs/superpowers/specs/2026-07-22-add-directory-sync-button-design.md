# Add "directory-sync" button in the hybrid-client warning box

Date: 2026-07-22
Status: approved for implementation

## Problem

A hybrid client (on-prem `active-directory` **plus** a cloud identity system —
`m365`/`entra`/`exchange`) that has **no** `directory-sync` system row gets a warning under
the Systems heading on the client detail page:

> ⚠ Hybrid client with on-prem Active Directory **and** cloud systems, but **no
> directory-sync step**. New AD accounts won't be pushed to Entra before the cloud steps
> run — they can race or fail. Add **directory-sync** (depends on `active-directory`) in
> **Edit systems**.

The warning tells the user to go to **Edit systems** and add it by hand. That is friction
for what is always the same fix. `core1561` (Agostino Food) is a live example.

## Goal

Turn the nudge into a one-confirm action: a button in the warning box that adds a correctly
shaped `directory-sync` system to the client, via a **prefilled confirmation dialog** (user
reviews, adjusts a couple of fields, confirms).

## Non-goals / scope guardrails

- No new API endpoint — reuse the existing `PUT /api/clients/[slug]/systems`.
- No change to the planner, orchestrator, or runner.
- No change to the detection condition that decides when the warning shows.
- No change to the full `SystemsEditor`; this is a focused shortcut, not a rewrite.

## Current behavior (as-built, verified)

- **Warning render + detection:** inline JSX in
  `web/app/clients/[slug]/page.tsx:342-346`. Condition:
  `sysByKey.has("active-directory") && (has m365||entra||exchange) && !has("directory-sync")`.
  `sysByKey` is built at `page.tsx:198` from `client.systems` keyed by `systemKey`. This is
  a server component.
- **Only write path:** `PUT /api/clients/[slug]/systems`
  (`web/app/api/clients/[slug]/systems/route.ts`). It is a **full replace**:
  `repo.replaceSystems(slug, deduped, backbone)` upserts every system in the payload and
  **deletes any systemKey not present**. Guarded by `client.edit_systems` +
  `clientSlugInScope`. Body: `{ systems: EditableSystem[], backbone?: Backbone|null }`.
- **`EditableSystem`** (`web/lib/clients/types.ts`), after route `sanitize()`:
  `{ systemKey, mode, onboardWhen, offboardWhen, dependsOn[], requiresApproval,
  captureEvidence, secretNames[], config }`. `GET /api/clients/[slug]` returns each system in
  this same field shape (see `SystemsEditor.load` at `systems-editor.tsx:167-183`), so
  existing systems round-trip without re-derivation.
- **Canonical `directory-sync` shape:**
  - Catalog default (`web/lib/generator/system-map.ts:21`): `mode:"api"`,
    onboard/offboard `always`, secret `ad-dc`, dependsOn `["active-directory"]`.
  - Simple profile (`profiles/six-one.json`): dependsOn `["active-directory"]`, no config.
  - Exchange-aware profile (`profiles/coretelligent.json`): dependsOn `["exchange"]`,
    onboard config `{ command: "Start-ADSyncSyncCycle -PolicyType Delta",
    waitForMailbox: true }`.
- **`ad-dc` is an OPTIONAL secret** — a DC agent authenticates as ambient SYSTEM; the cred is
  only the member-server fallback (see `orchestrator.ts` `wiredOptional` note and the
  `ad-dc-optional-secret` memory). So the added system needs no credential wiring to run.
- **Backbone:** presence of `active-directory` + `directory-sync` is what `inferBackbone`
  (`system-map.ts:128-140`) calls `ad-synced`. The orchestrator identity-pipeline ordering
  keys off the *systems present*, not `Client.backbone`, but the field should stay consistent.

## Design

### 1. New client component — `AddDirectorySyncButton`

File: `web/app/clients/_components/add-directory-sync-button.tsx` (`"use client"`).

Props:
```ts
{
  slug: string;
  hasExchange: boolean;   // sysByKey.has("exchange")
  backbone: string | null; // client.backbone
}
```

It renders the existing warning `<p className="note" ...>` box **plus** an
**"Add directory-sync"** button inside/under it (styled like the sibling `SyncSystemsButton`).
The warning text is preserved verbatim except the trailing "Add … in **Edit systems**."
sentence, which becomes redundant with the button — reword to "Add it below, or in **Edit
systems**."

### 2. Warning site swap in `page.tsx`

Replace the inline JSX block at `page.tsx:342-346` with:
```tsx
{sysByKey.has("active-directory") && (sysByKey.has("m365") || sysByKey.has("entra") || sysByKey.has("exchange")) && !sysByKey.has("directory-sync") && (
  <AddDirectorySyncButton slug={client.slug} hasExchange={sysByKey.has("exchange")} backbone={client.backbone} />
)}
```
The detection condition is unchanged — it stays in the server component (the button island
only renders when the server decides to show it).

### 3. Prefilled confirmation dialog

A `<dialog>` (matching the app's existing modal pattern, e.g. `SystemsEditor`) opened on
button click, showing what will be added:

- Fixed, shown read-only: systemKey `directory-sync`, mode `api`, onboard `always`,
  offboard `always`, secret `ad-dc` (with the "optional — no wiring needed" note).
- **"Order after" select** (the one meaningful choice):
  - `active-directory` — dependsOn `["active-directory"]`, `config: null`.
  - `exchange (wait for mailbox)` — dependsOn `["exchange"]`, onboard config
    `{ command: "Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox: true }`.
  - **Default:** `exchange (wait for mailbox)` when `hasExchange`, else `active-directory`.
    The `active-directory` option is disabled/hidden only if AD somehow absent (it never is,
    given the warning's condition).
- **"Also set backbone to ad-synced" checkbox** — **checked by default** when
  `backbone !== "ad_synced"`; if already `ad_synced`, the checkbox is shown checked +
  disabled (nothing to change).
- Buttons: **Add directory-sync** (primary) and **Cancel**.

### 4. Confirm action (client-side)

1. `GET /api/clients/${slug}` → read `systems` (already in `EditableSystem` field shape) and
   `backbone`.
2. Build the new set with the pure helper `withDirectorySync(current, opts)` (below).
3. `PUT /api/clients/${slug}/systems` with `{ systems, backbone }` where `backbone` =
   `"ad_synced"` if the checkbox is on, otherwise the client's current backbone (unchanged).
4. On ok → `router.refresh()` + close. On error → show `data.error` in the dialog (covers 403
   for a user without `client.edit_systems`, 404 out-of-scope, etc.).

Idempotency: if `current` already contains a `directory-sync` row (race / double-click),
`withDirectorySync` returns it unchanged and the action still succeeds as a no-op.

### 5. Pure, unit-tested core — `withDirectorySync`

File: `web/lib/clients/directory-sync-row.ts`.

```ts
export type DirectorySyncOpts = { orderAfter: "active-directory" | "exchange" };

// The canonical directory-sync EditableSystem, shaped by the chosen ordering.
export function directorySyncRow(opts: DirectorySyncOpts): EditableSystem;

// Append directory-sync to a system set; idempotent (returns input unchanged if present).
export function withDirectorySync(systems: EditableSystem[], opts: DirectorySyncOpts): EditableSystem[];
```

`directorySyncRow`:
- Always: `systemKey:"directory-sync"`, `mode:"api"`, `onboardWhen:"always"`,
  `offboardWhen:"always"`, `secretNames:["ad-dc"]`, `requiresApproval:false`,
  `captureEvidence:false`.
- `orderAfter:"active-directory"` → `dependsOn:["active-directory"]`, `config:null`.
- `orderAfter:"exchange"` → `dependsOn:["exchange"]`,
  `config:{ onboard:{ command:"Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox:true } }`.

This keeps the shape logic out of the UI and lets it be tested without a browser.

## Testing

- **Unit (Jest/vitest per repo convention)** for `directory-sync-row.ts`:
  - `directorySyncRow` shape for both `orderAfter` values (dependsOn, config, secretNames).
  - `withDirectorySync` appends exactly one row and preserves all existing systems.
  - `withDirectorySync` is idempotent when `directory-sync` already present.
- **Manual verification** on the worktree dev server against `core1561` (Agostino Food):
  warning shows the button → dialog prefilled (exchange default if it has exchange) → confirm
  → directory-sync row appears in Edit systems, backbone reads `ad-synced`, warning gone.

## Rollout

- Web-only. No runner bump, no migration.
- Changelog entry (one-file-per-entry, Eastern time on a 15-min boundary) per repo convention.
