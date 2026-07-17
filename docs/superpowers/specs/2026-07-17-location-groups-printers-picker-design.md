# Location groups picker + printers box (client page polish)

Date: 2026-07-17
Status: approved for planning

## Problem

On the client detail page, the Locations section lets a tech attach AD/Entra
groups (and, in practice, printers) to a location so that a hire matching that
location gets them at plan time. Today all of that is a single free-text chip
list per location (`location-targets-editor.tsx` → `Client.locations[name].groups:
string[]`): groups and printer names are jammed into one array with no
distinction, entered as free text with autocomplete from discovered group names.

We want to:

1. Turn group entry into a **structured multi-select** that pulls the client's
   already-discovered AD and 365 groups, sectioned by type (DL / Security / 365 /
   AD), with multiple selectable.
2. Give **printers their own free-text box**, separate from groups.
3. Make the locations table **double-line** so the two editors sit clearly on a
   second row per location.
4. Do a **full visual polish pass** on both the `/clients` list page and the
   client detail page, owned by the `frontend-design` skill.

Key context that shapes the design: **group enumeration from AD and 365 already
exists** and is not net-new work.

- AD: the per-client agent runs `Get-ADGroup -Filter *` during AD discovery and
  stores names in `Client.adObjects.groups: string[]`
  (`runner-service.recordAdObjects`; triggered by `ad-objects` route →
  `requestAdDiscovery`, consumed via the heartbeat `discover` flag).
- 365/Entra: the central runner runs `Get-MgGroup` during cloud-group discovery
  and stores `Client.cloudGroups.groups: { name, type }[]` where `type` is
  already classified `dl` | `security` | `m365`
  (`reportCloudGroups`; triggered by `cloud-groups` route →
  `requestCloudGroupDiscovery`, consumed via the claim/report endpoints).

Both feeds already surface as autocomplete options in the current editor. The
work is a **UI/data-shape upgrade over existing discovery**, plus a change to
what a "printer" means at execution time.

## Decisions (locked with the user)

1. **Existing data split — auto-classify, then editable.** On first render, a
   location's existing `groups[]` is split against the discovered group names:
   names that match a discovered AD/365 group stay in **Groups**; everything else
   becomes **Printers**. Guarded: only classify when the client actually has
   discovery data; otherwise leave everything in Groups (never guess). Lazy — not
   persisted until the location is next saved, so it is fully editable first.
2. **Group picker — sectioned by type.** One searchable multi-select with
   headers: 365 Distribution, 365 Security, 365 Groups, AD.
3. **Visual polish — full pass on list + detail.**
4. **Printers — manual checklist item.** Printers no longer union into the
   AD/Entra group-add. Each matched location emits one first-class manual step
   on the case; groups keep unioning into the group-add exactly as today.

## Data model

No Prisma migration. The change lives inside the existing `Client.locations`
JSON.

### Location shape

Per-location object (`Client.locations[name]`) today:

```ts
{ address?, city?, state?, zip?, timezone?, country?: {short,name,code},
  groups?: string[], ou?: string }
```

becomes:

```ts
{ address?, city?, state?, zip?, timezone?, country?: {short,name,code},
  groups?: string[],     // groups ONLY (AD/365 group names)
  printers?: string[],   // NEW — free-text printer names
  ou?: string }
```

`printers === undefined` means "un-migrated" (pre-feature data). `printers`
present (even `[]`) means the split has been persisted.

### Auto-classify function

A single pure helper, `classifyLocationTargets(existingGroups, discovered)`:

- `discovered` = the deduped set of names from `Client.adObjects.groups` ∪
  `Client.cloudGroups.groups.map(g => g.name)`.
- If `discovered` is empty → return `{ groups: existingGroups, printers: [] }`
  (guard: no discovery data, don't guess — keep as groups).
- Else → `groups = existingGroups.filter(g => discovered.has(g))`,
  `printers = existingGroups.filter(g => !discovered.has(g))`.

This helper is the single definition used by both the loader/view-model (for
initial display of un-migrated locations) and plan-resolve (so execution behavior
matches what the UI shows before any save). One definition, imported in both
places — no divergent copies.

## Components & files

### New / changed — web

- `web/app/clients/_components/location-targets-editor.tsx` — reworked from a
  single `TagList` into two editors:
  - **Groups**: sectioned searchable multi-select (new component, below), value =
    `groups: string[]`.
  - **Printers**: free-text chip input (reuse `TagList` from
    `condition-builder.tsx`), placeholder `printer name…`, autocomplete from
    printer names already used at this client's other locations.
  - On save, PATCH `/api/clients/:slug` `{ action: "set-location-targets", name,
    groups, printers }`.
- `web/app/clients/_components/group-multiselect.tsx` — NEW. A searchable,
  sectioned multi-select. Props: `sections: { label: string; options: string[] }[]`,
  `value: string[]`, `onChange`, plus refresh affordances (below). Renders
  section headers (365 Distribution / 365 Security / 365 Groups / AD), deduped
  option names across sources, selected items as removable chips, an empty state
  that points to Refresh, and a `discoveredAt` staleness line.
- Inline **Refresh AD** / **Refresh cloud groups** controls in the group picker,
  reusing the existing endpoints (`/api/clients/:slug/ad-objects`,
  `/api/clients/:slug/cloud-groups`) and their request-timestamp pattern. No new
  discovery mechanism.
- `web/app/clients/[slug]/page.tsx` — pass the new inputs the editor needs
  (typed cloud groups with their `type`, AD group names, discoveredAt values)
  down through `RolesRulesView` instead of the current flattened
  `groupOptions: string[]`.
- `web/app/clients/_components/roles-rules-view.tsx` — the Locations table goes
  **double-line**: line 1 = Name/Address/City/State/Zip/Timezone/Country; line 2
  = a full-width row holding the Groups multi-select and the Printers box side by
  side. Section owned by `frontend-design`.
- `web/app/clients/_lib/loader.ts` and/or the client-detail view-model — build
  the per-location display split for un-migrated locations via
  `classifyLocationTargets`, and pass through the typed discovery data.

### Changed — API

- `web/app/api/clients/[slug]/route.ts`, `set-location-targets` action — accept
  and persist `printers: string[]` alongside `groups: string[]`. Validate both as
  string arrays. Continues to accept the existing `ou` field untouched.

### Changed — plan-resolve

- Wherever `Client.locations[name].groups` is currently unioned into the
  directory group-add for a matched hire:
  - Resolve the location's `{ groups, printers }` via `classifyLocationTargets`
    when `printers` is undefined (un-migrated), else use the stored split.
  - **Groups** union into the AD/Entra group-add exactly as today.
  - **Printers** emit **one** manual step per matched location — a `mode:
    manual` job / checklist item titled like `Map printers at <location>` listing
    the printer names — following this repo's first-class manual-step convention.
    One step per location (not per printer) to limit case noise.

### Optional follow-on (flagged, NOT on the critical path) — runner

AD discovery stores only group names, so AD groups can't be split into
Security/Distribution. A small runner change to `Invoke-CtgAdDiscovery` to also
capture `Get-ADGroup`'s `GroupCategory` (Security | Distribution) would let the
"AD" section split like the 365 sections.

- Back-compat: `Client.adObjects.groups` stays readable as either `string[]`
  (old) or `{ name, category }[]` (new); the picker buckets everything under a
  single "AD" header until enhanced data arrives, then splits.
- This is a separate, later change with its own runner version bump + deploy.
  **The feature ships without it.**

## Data flow

1. Tech opens the client detail page → loader reads `Client.locations`,
   `adObjects`, `cloudGroups`.
2. For each location: if `printers` is set, use the stored `{groups, printers}`;
   else compute the display split with `classifyLocationTargets`.
3. Group picker sections are built from `cloudGroups.groups` (by `type`) +
   `adObjects.groups` (AD bucket), deduped.
4. Tech edits Groups (from the picker) and Printers (free text), saves →
   `set-location-targets` persists `{ groups, printers }`. `printers` now defined
   → no further auto-classification for that location.
5. Onboarding plan for a hire matching the location: groups union into the
   directory group-add; printers become one manual "Map printers at <location>"
   checklist step on the case.
6. Refresh AD / Refresh cloud groups re-runs the existing discovery pipelines and
   repopulates the picker options.

## Error handling & edge cases

- **No discovery data**: picker shows an empty state pointing to Refresh; the
  auto-classify guard keeps existing entries in Groups so nothing is lost or
  mis-filed as a printer.
- **Stale discovery**: `discoveredAt` shown; a real group typed before discovery
  ran could land in Printers on the initial un-migrated split — the tech can move
  it back, and it's not persisted until save. Acceptable and reversible.
- **Selected group later disappears from discovery** (deleted upstream): it stays
  selected as a chip (value is authoritative), shown even if no longer an option,
  so plan-resolve still targets it; tech can remove it.
- **Duplicate names across AD and 365**: deduped in the option list; the selected
  value is just the name (existing behavior — group resolution is name-based).
- **Printers array validation**: reject non-string entries server-side; trim and
  drop blanks.

## Testing

Web (follows the existing web suite):

- Unit: `classifyLocationTargets` — matches → groups, non-matches → printers,
  empty-discovery guard, stored-split passthrough.
- Unit: loader/view-model builds the correct per-location split and typed
  sections.
- API: `set-location-targets` accepts and persists `{ groups, printers }`;
  rejects bad input.
- Plan-resolve: groups still union into the group-add (unchanged); a matched
  location with printers emits exactly one manual step listing them; un-migrated
  location behaves via the same classify path.
- Component: the editor renders sectioned groups, selecting adds a chip, and
  group vs printer entries live in their two boxes.

## Out of scope

- Any print-deployment executor (printers are manual steps).
- Printer discovery / enumeration (printers are free text).
- The AD `GroupCategory` runner enhancement (flagged optional follow-on).
- Prisma schema migration (change is inside the `locations` JSON).
