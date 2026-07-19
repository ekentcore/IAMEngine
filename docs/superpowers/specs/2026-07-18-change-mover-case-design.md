# Unified Change/Mover case — design spec

**Date:** 2026-07-18
**Status:** Approved (brainstorming). Implementation plan: `docs/superpowers/plans/2026-07-18-change-mover-case.md`.

## Context

iam-engine is today a two-action machine: `enum Action { onboard offboard }`. Every
group/DL/mailbox/license/OU operation lives inside one of those two flows. There is no
"mover"/change case type and no standalone "add existing user X to group/DL Y" action, even
though the runner already holds every low-level primitive (add/remove group member for AD,
Entra/Graph, Exchange DLs, Google; OU move; license add/remove; attribute writes).

**Insight:** a mover and an ad-hoc "add to group" are the same capability at different
granularities. A **change case** carries atomic access deltas (add/remove
group · DL · shared mailbox · license · OU move · attribute). A **mover** is a change case whose
deltas are *computed* from a persona/location/dept transition. An **ad-hoc grant** is a change
case with hand-picked deltas. One machinery, reusing the runner primitives and most of planning.

## Decisions (locked with the user)

- **Removal scope** is an operator choice made in the preview modal, per case:
  **scoped-to-managed** vs **full-reconciliation** vs **add-only**.
- **v1 triggers:** manual in-app **and** bulk/CSV. ServiceNow "user change" intake mapping deferred.
- **Directory scope:** every directory the runner supports (AD, Entra/M365, Exchange DLs +
  shared mailboxes, Google). Long-tail SaaS without a group primitive → manual checklist step.
- **v1 preview is rule-derived** (single-phase). Exact adds and exact scoped-removal candidates
  are computed app-side from the client's persona/location/global rules. **Full reconciliation**
  (remove anything not in the target) is executed authoritatively on the runner, which reads live
  membership. Live per-user current-state *preview* is a documented fast-follow, not v1 — it would
  require new per-user discovery jobs and plumbing that the client-level cloud-groups flag does not
  provide.

## Architecture

1. **`change` Action** added to the Prisma enum; a change case's intent rides `CaseRequest.payload`.
2. **Diff engine** (`web/lib/cases/change-plan.ts`, pure): given the target per-directory config
   (reusing `resolvePlannedConfigs(client, targetPayload, "onboard", …)`), the *from* persona's
   managed groups, the protected-group denylist, and the chosen removal mode → produce per-system
   `ChangeDiff`s (adds, scoped removes, reconcile flag + desired keep-list, OU move, attrs, licenses).
3. **Change planner** turns diffs into `PlannedJob[]` — one job per directory system carrying a
   documented change-config contract; injects a `directory-sync` job after AD on synced backbones
   and a trailing `case-resolution`; defaults `requiresApproval` on any job that removes/reconciles.
   No identity pipeline (that is onboard/offboard-specific).
4. **API routes:** `POST /api/cases/change` (create + plan), `POST /api/cases/[id]/change/confirm`
   (apply removal mode + finalized deltas → (re)plan execution jobs), `POST /api/cases/change/bulk`.
5. **Runner `Change` lane:** a `change` branch in the job loop selects `$handler.Change`; each
   directory module gets an `Invoke-Ctg*Change` function reusing existing add primitives, a new
   by-name removal path (M365/Exchange/Google), full-reconciliation, shared-mailbox add/remove
   (new), and a post-AD directory-sync trigger. Systems with no `Change` scriptblock fall back to a
   manual checklist step.
6. **UI:** a change-case dialog (pick user; mover transition or hand-picked deltas, reusing
   `GroupMultiselect`/`M365GroupsEditor`/`OuTreePicker`) and a preview modal with the
   scoped/full/add-only toggle. Execution monitoring reuses `run-report-view` unchanged.

## Approval / audit / RBAC (all reuse)

Removal/reconcile/OU-move jobs default `requiresApproval:true` (`StepIntent="destructive"`), gated
server-side by the existing `approveJob` path and `case.approve_destructive` permission. Adds are
`case.dispatch`. Every job writes `AuditLog` + a ServiceNow work note via the existing `recordResult`
path (new `case.change.*` event labels). Protected-group denylist blocks privileged groups on both
add and remove.

## Non-goals (v1)

ServiceNow user-change intake mapping; live per-user current-membership preview; SaaS systems with no
group primitive (manual checklist); time-boxed/auto-expiring grants (roadmap item #4).

## Verification

Diff-engine unit tests (adds/scoped/full/add-only; protected exclusion; empty-diff no-op); planning
test that a change case emits per-directory change jobs with the correct config and no
identity-pipeline steps; runner Pester per `Invoke-Ctg*Change` (idempotent add/remove, protected-group
refusal, reconcile keep-list); end-to-end mover on a v2.1 client in an isolated dev DB.
