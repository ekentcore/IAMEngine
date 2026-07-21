# Reset a child client to its parent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A safe, auditable action to revert a child client back to inheriting from its parent — whole-child or per-system — with a Full (systems + credentials + modeling) vs Systems-only choice. (FR #0000023.)

**Architecture:** A new `action:"reset-to-parent"` on the existing client PATCH route + a `resetToParent` repo helper (the inverse of `copyParentModeling`) + UI (client actions menu for whole-child, Systems editor row for per-system). No migration, no runner change.

**Tech Stack:** Next.js (App Router, TypeScript); web tests use `node:test` + `node:assert` (`cd web && npx tsx --test <file>`). Static gate: `npx tsc --noEmit`. Do NOT run `next lint`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-reset-child-to-parent-design.md`. Implements it in full.
- Model to mirror: `set-parent-inheritance` at `web/app/api/clients/[slug]/route.ts:205-230` + `copyParentModeling` (`web/lib/clients/repository.ts:397-437`) + `ParentInheritanceControl`.
- Inheritance re-engages only when the child has **zero** `ClientSystem` rows (`web/lib/cases/repository.ts:156`) and (per-field) null modeling; credentials re-inherit when the child has no own `Secret` row.
- **Destructive.** Deleting a child `Secret` row loses the Delinea *reference*, not the vault secret — the confirm dialog must say so. Audit **counts/names only**, never secret ids/values (`secrets/route.ts:64-69`).
- Guard `client.edit_systems` + client-in-scope (`systems/route.ts:35-37`).
- Ship convention: one-file-per-entry changelog + register; Eastern time on 15-min boundary.

---

### Task 1: Repo — `resetToParent(slug, { scope, systemKey })`

**Files:**
- Modify: `web/lib/clients/repository.ts` (next to `copyParentModeling`)
- Test: `web/lib/clients/repository.reset-to-parent.test.ts`

**Interface:** `resetToParent(slug, { scope: "full" | "systems", systemKey?: string }): Promise<{ ok: boolean; code: "ok" | "no_parent" | "not_found"; removed: { systems: number; secrets: number } }>`. In one `db.$transaction`:
- Delete child `ClientSystem` (all, or the one `systemKey`) + dependent `SystemSetupState` (mirror `replaceSystems:577-581`).
- Delete now-orphaned `ConnHealthState`/`ConnectionTest` for the removed `systemKey`(s).
- If `scope==="full"`: delete child `Secret` rows (all, or the covered ones); on whole-child, null `identity/personas/globals/globalsOffboard/locations`.
- On whole-child: set `inheritParentSystems=true`.

- [ ] Step 1: Failing tests — (a) full whole-child deletes systems+setup+secrets, nulls modeling, sets flag; (b) `scope:"systems"` keeps Secret rows; (c) per-system removes only that key + its setup/health; (d) no `parentId` → `code:"no_parent"`, nothing deleted.
- [ ] Step 2: Implement in a transaction. Return `removed` counts.
- [ ] Step 3: Green; `tsc --noEmit` clean.

### Task 2: API — `action:"reset-to-parent"` on the client PATCH route

**Files:**
- Modify: `web/app/api/clients/[slug]/route.ts` (add branch alongside `:205`)
- Test: `web/app/api/clients/[slug]/route.reset.test.ts`

**Interface:** `PATCH { action:"reset-to-parent", scope:"full"|"systems", systemKey? }`. Validate body; `existing.parentId` required (422 "not a child"); out-of-scope → 404. Call `resetToParent`; write audit `client.reset_to_parent` with `{ scope, systemKey?, removedSystems, removedSecrets }`.

- [ ] Step 1: Failing tests — full/systems/per-system happy paths return counts + write audit; no parent → 422; bad `scope` → 422.
- [ ] Step 2: Implement the branch; map repo `code` → HTTP status.
- [ ] Step 3: Green; `tsc --noEmit` clean.

### Task 3: UI — whole-child action + per-system revert

**Files:**
- Modify: `web/app/clients/_components/client-actions-menu.tsx` (whole-child item, `parentId != null`)
- Modify: `web/app/clients/_components/systems-editor.tsx` (per-row "revert to parent", `parentId != null`)
- Reuse: confirm pattern at `parent-inheritance-control.tsx:76`

- [ ] Step 1: Whole-child menu item → confirm dialog with the Full vs Systems-only choice; copy states Full deletes the child's own Delinea references (vault secrets survive; re-wiring manual) and clears child-only `intakeRules`/runbook. POST the action; refresh on success.
- [ ] Step 2: Per-system "revert to parent" affordance in the Systems editor row → POST `{ action, scope, systemKey }` (scope inherited from a small inline choice or default Full). Confirm before delete.
- [ ] Step 3: Manual smoke via the web dev recipe; `tsc --noEmit` clean.

### Task 4: Changelog + regression

**Files:**
- Create: `web/lib/changelog/entries/reset-child-to-parent.ts` + register in `_registry.ts`

- [ ] Step 1: Changelog entry (Eastern time, 15-min boundary).
- [ ] Step 2: Regression — after a Full whole-child reset, `clientForPlanning` re-inherits the parent's systems/credentials (add/confirm a test). Full touched-test run green; `tsc --noEmit` clean.

## Deploy notes

Web-only. No migration. No runner change.
