# Reset a child client's systems (and optionally credentials) to the parent

**Feature request:** #0000023 "Ability to Reset Child's systems to parent" (author
ccyr@core.tech, filed 2026-07-21 from `/clients/core870`). Requestor's exact ask:

> I accidentally made changes to a child client and it's not reflecting the credentials
> found in the parent.

## Goal

Give the operator a safe, auditable way to **revert a child client back to inheriting from
its parent** after an accidental edit — for the whole child at once, or one system at a
time — with a choice of how far the reset goes.

## Background: how inheritance works (and breaks)

A `Client` has a self-relation `parentId` (`web/prisma/schema.prisma:88-93`) plus a
`inheritParentSystems` boolean (`schema.prisma:136-140`). Two independent inheritance axes,
both keyed on "the child has none of its own":

- **Systems / modeling** — `clientForPlanning` (`web/lib/cases/repository.ts:156-174`): a
  child with **zero** `ClientSystem` rows and `inheritParentSystems=true` plans from the
  parent's systems; the modeling JSON fields (`identity`, `personas`, `globals`,
  `globalsOffboard`, `locations`) fall back **per-field** when null. **Any** child
  `ClientSystem` row disables systems inheritance entirely.
- **Credentials** — a child's own `Secret` row (`@@unique([clientId, name])`) shadows the
  parent's in every resolver (`web/lib/jobs/runner-service.ts:1128-1145`,
  `web/lib/cases/repository.ts:97-105`, `web/lib/clients/repository.ts:73-82`); otherwise
  the parent's secret is brokered.

So a child that "isn't reflecting the parent" has one or more of: (1) its own
`ClientSystem` rows, (2) its own `Secret` rows, (3) `inheritParentSystems=false`, (4)
non-null modeling overrides.

## The pattern to mirror

The **inverse** action already exists — "break inheritance / keep a copy":
`action:"set-parent-inheritance"` on `PATCH /api/clients/[slug]/route.ts:205-230` →
`setInheritParentSystems` + `copyParentModeling` (`web/lib/clients/repository.ts:384-437`),
with the confirm + "keep copy vs start empty" UX in `ParentInheritanceControl`
(`web/app/clients/_components/parent-inheritance-control.tsx`). A "reset to parent" is
`copyParentModeling` run **backwards**: delete the child's own rows instead of copying the
parent's down.

## Design decisions (confirmed with requestor)

1. **Scope is a choice in the dialog:** each reset picks **Full** (systems + credential
   wiring + modeling overrides) or **Systems only** (keep the child's own Delinea
   references) — mirroring the existing keep-copy/start-empty choice.
2. **Both granularities:** a **whole-child** reset action, and a **per-system** revert.

### API

Extend `PATCH /api/clients/[slug]/route.ts` with `action:"reset-to-parent"`, body:

```
{ scope: "full" | "systems", systemKey?: string }   // systemKey present = per-system revert
```

Guard `client.edit_systems` + client-in-scope (as `systems/route.ts:35-37`). Validate
`existing.parentId` (422 "not a child" — same shape as `:210`). In one `db.$transaction`:

- Delete the child's `ClientSystem` rows — **all**, or the single `systemKey` — and their
  dependent `SystemSetupState` (mirror `replaceSystems`, `repository.ts:577-581`).
- Clear now-orphaned `ConnHealthState` / `ConnectionTest` rows for the removed
  `systemKey`(s) (they are keyed by `(clientId, systemKey)` and are not cascaded by
  `ClientSystem` deletion).
- If `scope === "full"`: delete the child's own `Secret` rows (all, or the ones a
  per-system reset covers), and on a whole-child reset null the modeling overrides
  (`identity`, `personas`, `globals`, `globalsOffboard`, `locations`).
- On a whole-child reset set `inheritParentSystems = true`.
- Write audit `client.reset_to_parent` with **counts only** (systems removed, secrets
  removed, scope, systemKey) — never secret ids/values (`secrets/route.ts:64-69`).

### Repo

`resetToParent(slug, { scope, systemKey })` beside `copyParentModeling`
(`web/lib/clients/repository.ts`), returning a discriminated `{ ok, code, removed }` result
like `copyParentModeling` (`:399`).

### UI

- **Whole-child:** a destructive item in `ClientActionsMenu`
  (`web/app/clients/_components/client-actions-menu.tsx`), shown only when `parentId != null`.
  Opens a confirm dialog with the Full-vs-Systems-only choice (reuse the confirm pattern at
  `parent-inheritance-control.tsx:76`). Copy states plainly that Full deletes the child's
  own Delinea credential references (the vault secrets survive; re-wiring is manual).
- **Per-system:** a "revert to parent" affordance per row in the Systems editor
  (`web/app/clients/_components/systems-editor.tsx`), shown only when `parentId != null`,
  posting `{ action:"reset-to-parent", scope, systemKey }`.

## Safety & edge cases

- **Destructive, confirm required.** Deleting a child `Secret` row loses the Delinea
  *reference*, not the vault secret; re-wiring is manual. The dialog must say so.
- **Out of scope for revert:** `intakeRules`, `RunbookSection`, and `notifyOverride` are
  **child-only** (never inherited from a parent), so a whole-child Full reset clears them to
  empty rather than to a parent value — surface this in the confirm copy.
- **Orphan cleanup** of `ConnHealthState`/`ConnectionTest` prevents stale red checks after
  the systems are gone.
- **No parent → 422.** A client with no `parentId` cannot reset to a parent.

## Testing

- API: whole-child Full reset deletes ClientSystem + SystemSetupState + Secret rows, nulls
  modeling, sets `inheritParentSystems=true`, writes audit with counts.
- API: `scope:"systems"` keeps the child's Secret rows.
- API: per-system revert removes only that `systemKey` (+ its setup/health rows) and leaves
  others intact.
- API: no `parentId` → 422; out-of-scope client → 404.
- Repo `resetToParent` result codes.
- Regression: after a Full whole-child reset, `clientForPlanning` re-inherits the parent's
  systems/credentials.

## Deploy notes

Web-only. **No migration** (deletes + flag/JSON updates on existing tables). No runner change.
