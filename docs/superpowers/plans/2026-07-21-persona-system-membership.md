# Personas & Systems: persona membership for by-persona systems — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In the Roles & Rules editor, let an operator see which systems are in "by persona" mode and explicitly choose which personas receive each — without having to add a throwaway group/OU. (FR #0000022.)

**Architecture:** UI + read-API only. The planner already gates a `by_persona` system on `persona.systems[systemKey]` key presence (`web/lib/orchestrator.ts:104`, `web/lib/profiles/plan-resolve.ts:19-28`); this plan surfaces and edits that membership. No migration, no planner change.

**Tech Stack:** Next.js (App Router, TypeScript); web tests use `node:test` + `node:assert` (`cd web && npx tsx --test <file>`). Static gate: `npx tsc --noEmit`. Do NOT run `next lint`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-persona-system-membership-design.md`. Implements it in full.
- Membership = key presence in `persona.systems` (onboard) / `persona.offboardSystems` (offboard). An empty `{}` fragment is valid membership-with-no-config; `validateRules()` already accepts it.
- The rules editor loads the whole `personas`/`globals`/`globalsOffboard` and PUTs them back wholesale (`rules-editor.tsx:130-147`); the route partial-merges. New UI writes into the same `personas` state — never a separate save.
- Scope: manage membership only. Do NOT move the `by_persona` lane toggle out of the Systems editor.
- Ship convention: one-file-per-entry changelog under `web/lib/changelog/entries/` + register in `_registry.ts`; `time` from `TZ=America/New_York date +%H:%M` on a 15-min boundary.

---

### Task 1: Expose each system's lane to the rules payload (read API)

**Files:**
- Modify: `web/lib/clients/repository.ts` — `getRules` (`:460-474`)
- Test: `web/lib/clients/repository.rules.test.ts` (add or extend)

**Interface:** `getRules(slug)` return gains `systemLanes: Record<string, { onboard: string; offboard: string }>` keyed by `systemKey`, sourced from each `ClientSystem`'s `onboardWhen`/`offboardWhen`.

- [ ] Step 1: Failing test — a client with an `active-directory` system whose `onboardWhen="by_persona"` yields `systemLanes["active-directory"].onboard === "by_persona"`.
- [ ] Step 2: Add `onboardWhen, offboardWhen` to the `clientSystem` select in `getRules`; build and return `systemLanes`.
- [ ] Step 3: Green. `tsc --noEmit` clean.

### Task 2: Rules editor — badge by-persona systems + explicit membership checklist

**Files:**
- Modify: `web/app/clients/_components/rules-editor.tsx`
- Test: `web/app/clients/_components/rules-editor.membership.test.ts` (logic-level test of the toggle helpers)

**Interfaces:**
- Consume `systemLanes` from the load effect (`:52-64`).
- New helpers: `addSystemToPersona(personaKey, systemKey, scope)` → sets `persona[scope][systemKey] = existing ?? {}`; `removeSystemFromPersona(personaKey, systemKey, scope)` → deletes the key. `scope` is `"systems" | "offboardSystems"`.

- [ ] Step 1: Failing test — toggling a by-persona system on adds `{}`; toggling off removes the key; a system with an existing `{groups:[...]}` fragment is preserved when toggled (idempotent add).
- [ ] Step 2: Render a "by persona" badge on systems whose lane is `by_persona` (mirror `systems-editor.tsx:45` `LANE_STYLE.by_persona`).
- [ ] Step 3: Add a per-persona "Systems this persona receives" checklist of the by-persona systems (onboard scope; offboard scope where the editor shows offboard rules). Wire the add/remove helpers. Writes land in the existing `personas` state → existing PUT.
- [ ] Step 4: Green; `tsc --noEmit` clean; manual smoke via the web dev recipe (optional).

### Task 3: Read-only mirror + changelog

**Files:**
- Modify: `web/app/clients/_components/roles-rules-view.tsx` (`:118-122`)
- Create: `web/lib/changelog/entries/persona-system-membership.ts` + register in `_registry.ts`

- [ ] Step 1: Label membership-only (empty-fragment) systems in the read-only view so a reader sees a persona receives a system with no group/OU/attr.
- [ ] Step 2: Changelog entry (Eastern time, 15-min boundary).
- [ ] Step 3: Full touched-test run green; `tsc --noEmit` clean. Regression: `planning-persona-lane.test.ts` still green.

## Deploy notes

Web-only. No migration. No runner change.
