# Personas & Systems: specify which personas a by-persona system applies to

**Feature request:** #0000022 "Personas and Systems" (author ccyr@core.tech, filed
2026-07-21 from `/clients/core870`). Requestor's exact ask:

> There is the By Persona option for a system, and a client like CVP clinics would have AD
> only setup for Practice Managers and Lead Vets, but there's no way to specify this in the
> Roles & Rules.

## Goal

Let an operator say, in the Roles & Rules editor, **which personas receive a system that
is in "by persona" mode** — e.g. CVP's `active-directory` runs only for the *Practice
Managers* and *Lead Vets* personas. Today the mechanism exists in the data model and the
planner, but there is no clear place in the UI to set it, and no indication of which
systems are even in "by persona" mode.

## What already works (do not rebuild)

The backend is complete. A system's per-lane inclusion is an enum column
`ClientSystem.onboardWhen` / `offboardWhen` (`web/prisma/schema.prisma:199-200`); one of
its values is `by_persona` (`Lifecycle` enum, `schema.prisma:37`; added in migration
`20260712000000_by_persona_lane`). The planner includes a `by_persona` system **iff its
`systemKey` is a key in the selected persona's bundle**:

- Gate: `web/lib/orchestrator.ts:104` — `if (when === "by_persona") return personaSystems?.has(cs.systemKey) ?? false;`
- Key set: `web/lib/profiles/plan-resolve.ts:19-28` (`personaSystemKeys`) — the keys of
  `persona.systems` (onboard) plus `persona.offboardSystems` (offboard).
- Personas live in `Client.personas` (JSON), keyed by persona name; each persona is
  `{ label?, titles?, match?, systems?: Record<systemKey, Fragment>, offboardSystems?: ... }`
  (`web/lib/clients/rules.ts`). Membership is **key presence**; the fragment value can be
  `{}` (membership only, no group/OU/attribute config).
- Confirmed end-to-end by `web/lib/cases/planning-persona-lane.test.ts`.

## The gap today

Membership can only be created **implicitly**: `rules-editor.tsx`'s `addSystem()`
(`web/app/clients/_components/rules-editor.tsx:178-183`), or adding any group/OU/attribute
fragment, writes `persona.systems[key]`. There is:

1. **No signal** in the rules editor of which systems are `by_persona`. `getRules`
   (`web/lib/clients/repository.ts:460-474`) returns `systemKeys` and OU hints but **not**
   `onboardWhen`/`offboardWhen`, so the editor cannot know a system's lane.
2. **No explicit membership control.** To make a persona "receive" a by-persona system
   with no extra config, an operator has to add a throwaway group/OU just to force the key
   to exist. The lane itself is set in a *different* editor
   (`web/app/clients/_components/systems-editor.tsx`), so the two are disconnected.

## Design decision: membership-only, in the rules editor

Scope (confirmed with requestor): the Roles & Rules editor manages **persona membership**;
the `by_persona` **lane stays set in the Systems editor** (keep the existing separation).
No data-model change, no planner change — this is a UI + read-API addition.

### 1. Expose each system's lane to the editor (API)

`getRules` (`web/lib/clients/repository.ts:460-474`) — add `onboardWhen`/`offboardWhen` to
the `clientSystem` select and return a `systemLanes: Record<systemKey, { onboard, offboard }>`
alongside the existing payload. No new route; `GET /api/clients/:slug/rules` carries it.

### 2. Rules editor: show lane + explicit membership (core work)

`web/app/clients/_components/rules-editor.tsx`:

- **Badge** each `by_persona` system in the system selector row (mirror the purple
  "by persona" style from `systems-editor.tsx:45` `LANE_STYLE.by_persona`), so the
  operator sees which systems are gated.
- Per persona, add a **"Systems this persona receives"** checklist of the by-persona
  systems (onboard uses `persona.systems`; the offboard scope uses `offboardSystems`).
  Checking a box writes `persona.systems[key] = existingFragment ?? {}`; unchecking
  **removes** the key (a new `removeSystemFromPersona` helper next to `addSystem`). This
  makes membership first-class and independent of adding a group/OU/attribute.
- All writes go into the same `personas` state that the editor already PUTs wholesale
  (`rules-editor.tsx:130-147`), so siblings are preserved and the merge route
  (`web/app/api/clients/[slug]/rules/route.ts`) needs no change.

### 3. Read-only mirror (client page)

`web/app/clients/_components/roles-rules-view.tsx:118-122` renders `persona.systems`; label
membership-only (empty-fragment) systems so a reader sees a persona receives a system even
with no group/OU/attr configured.

## Non-goals

- No change to the planner, the `Lifecycle` enum, or the `by_persona` semantics.
- Not moving the lane toggle into the rules editor (stays in the Systems editor).
- No persona *definition* changes — personas are still authored where they are today.

## Testing

- Rules-editor unit/interaction: checking a by-persona system adds `persona.systems[key]={}`;
  unchecking removes it; fragments already present are preserved on toggle.
- `getRules` returns `systemLanes` with the correct enum values.
- Regression: `planning-persona-lane.test.ts` still green (planner unchanged).

## Deploy notes

Web-only. **No migration.** No runner change.
