# Admin attention modal — design

**Date:** 2026-07-24
**Status:** Approved (brainstorming session with Evan)

## What

When a global admin or super admin loads the app and there are items needing
their attention — pending user access requests and/or untriaged feature
requests — a modal pops up telling them so, with links to the relevant pages.
A gated test page lets admins exercise every state of the modal without
touching real data.

## Decisions made during brainstorming

- **Frequency:** once per *new items* — dismissing the modal remembers what
  the admin has been shown; it re-pops only when something new arrives (not
  on every login, not on every page load).
- **Shape:** one combined modal covering both categories, single dismissal.
- **Feature-request scope:** only `status: "new"` (untriaged) FRs trigger the
  popup. Planned/building items are already acknowledged and must not nag.
  (The nav badge keeps its existing broader "open" count — unchanged.)
- **Seen-state storage:** localStorage high-water marks, per browser, keyed
  per user. No migration, no dismiss API. A second browser re-shows once;
  acceptable for a review nag.

## Data flow (server)

In `web/app/layout.tsx`, when `loggedIn && !onLogin`, the **real** user
(`acting.realUser`, not the possibly-impersonated `acting.user`) has
`ROLE_RANK[role] >= ROLE_RANK.global_admin`, and not impersonating, run two
indexed aggregates alongside the existing layout queries:

- `db.accessRequest.aggregate({ where: { status: "pending" }, _count: true, _max: { lastRequestedAt: true } })`
- `db.featureRequest.aggregate({ where: { status: "new" }, _count: true, _max: { number: true } })`

Both wrapped in try/catch; on failure pass zeros — the layout must never
break because of this feature. Results are passed as props to a new
always-mounted client component rendered next to `ServerWatchdog`.

When auth is disabled (`authEnabled()` false, dev mode), treat the viewer as
an admin and use the storage key suffix `local`.

## Modal component (client)

`web/app/_components/admin-attention-modal.tsx`

- Native `<dialog>` self-opening from a `useEffect` (the `ServerWatchdog`
  pattern). Global dialog styles from `globals.css`; CSS tokens only
  (`--bg`, `--line`, …), no raw hexes.
- Title: **Needs your attention**. One row per non-zero category:
  - "N user request(s) awaiting approval" with **Review →** linking `/users`
  - "N new feature request(s)" with **View →** linking `/feature-requests`
- Dismissal paths: Dismiss button, Esc/cancel, or clicking either link. All
  of them record the seen marks before closing/navigating.
- Approved mockup:

```
┌──────────────────────────────────┐
│  Needs your attention            │
│                                  │
│  👤 3 user requests awaiting     │
│     approval        [Review →]   │
│                                  │
│  💡 5 new feature requests       │
│                     [View →]     │
│                                  │
│                      [Dismiss]   │
└──────────────────────────────────┘
```

## Show/dismiss logic (pure helper)

`web/lib/attention/seen.ts` — pure, unit-testable, no DOM/Prisma imports.

- Marks shape: `{ requestsAt: string | null, frMax: number }` (ISO timestamp
  of the newest pending request's `lastRequestedAt`; highest `new` FR
  `number`).
- Show when `pendingCount > 0 && latestRequestAt > stored.requestsAt`
  **or** `newFrCount > 0 && maxFrNumber > stored.frMax`. Missing/invalid
  stored state counts as never-seen (show).
- Identifiers, not counts: if a request is approved (3→2) and a new one
  arrives (2→3), a count comparison stays silent; the timestamp/number
  comparison pops. This asymmetry is the reason the helper exists.
- Storage: `localStorage["admin_attention_seen:<userId>"]` (or `:local`).
  All reads/writes wrapped in try/catch; storage failure means the modal may
  show again, which is harmless.

## Edge cases

- **Impersonation:** never shown while a super admin is impersonating —
  mutations are blocked in that state, so Review/approve would 403 anyway.
- **Login page:** never shown (`onLogin` guard already exists in layout).
- **Below global_admin:** no queries run, no props passed, component not
  rendered.
- **FR status regression:** an FR moved back to `new` with a number below
  the stored mark won't re-pop. Accepted — rare, and the nav badge still
  shows it.

## Test page

`web/app/tools/popup-test/page.tsx` + `_components/popup-test-view.tsx`

- Server component, `export const dynamic = "force-dynamic"`, redirect-gated
  to `ROLE_RANK >= global_admin` exactly like `/tools/db-copy`.
- Linked in the Tools group of `menuGroups()` in
  `web/app/_components/nav.tsx` (mobile nav shares `menuGroups`, no extra
  wiring).
- The client view renders the *same* `AdminAttentionModal` component with a
  `forceOpen` controlled prop (bypasses seen-state) and scenario buttons:
  - **Both pending** (fake counts, e.g. 3 requests + 5 FRs)
  - **Only user requests**
  - **Only feature requests**
  - **None** (verifies the modal refuses to open with zero items)
  - **Live data** — real counts passed from the server page
  - **Clear seen memory** — deletes the localStorage key so the natural
    on-load flow can be re-tested by navigating away
- No DB writes anywhere on the page.

## Testing

- Unit tests for `lib/attention/seen.ts`: never-seen shows; dismiss then
  same data hides; approve-then-new-arrival pops (the count-vs-identifier
  case); FR-only and requests-only trigger independently; corrupt stored
  JSON treated as never-seen.
- Manual verification of the modal and all scenarios via `/tools/popup-test`.

## Housekeeping

- One changelog entry file (repo convention: one file per entry under
  `web/lib/changelog/entries/`, registered in `_registry.ts`, Eastern time
  on a 15-minute boundary).

## Out of scope (deliberate)

- No polling / live re-check after page load — the next navigation
  re-evaluates server-side anyway.
- No per-category dismissal.
- No server-side seen state (Approach B, rejected).
- No change to the existing FR nav-badge count semantics.
