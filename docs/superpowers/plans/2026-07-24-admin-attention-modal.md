# Admin Attention Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pop a "Needs your attention" modal for global/super admins when there are pending access requests or untriaged feature requests — once per *new* item — plus a `/tools/popup-test` page to exercise every state.

**Architecture:** A pure show/dismiss decision helper (`lib/attention/seen.ts`, unit-tested) compares DB high-water marks (newest pending-request timestamp, highest `new` FR number) against localStorage marks. A failure-safe server loader (`lib/attention/data.ts`) runs two indexed aggregates from `app/layout.tsx` only for real (non-impersonating) global_admin+ viewers. One client `<dialog>` component (`ServerWatchdog` pattern) is reused verbatim by the test page via a `forceOpen` prop that never writes seen-marks.

**Tech Stack:** Next.js App Router (server layout + client component), Prisma aggregates, native `<dialog>`, `node:test` via `npm test` (`tsx --test "lib/**/*.test.ts"`).

**Spec:** `docs/superpowers/specs/2026-07-24-admin-attention-modal-design.md` (approved).

## Global Constraints

- All commands run from `web/` inside the worktree (`.claude/worktrees/admin-attention-modal`).
- CSS: tokens only (`--bg`, `--line`, …) — **no raw hex colors** (dark-mode rule).
- Never run `next build` (broken on main for unrelated reasons); verify with `npm test` + `npx tsc --noEmit`.
- Do not run `prisma migrate` or touch the shared DB — this feature has **no migration**.
- Role gate is `ROLE_RANK[role] >= ROLE_RANK.global_admin` on the **real** user (`acting.realUser`), never the impersonated one.
- FR trigger scope is `status: "new"` only. The existing nav-badge "open" count is untouched.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Pure seen-state helper

**Files:**
- Create: `web/lib/attention/seen.ts`
- Test: `web/lib/attention/seen.test.ts`

**Interfaces:**
- Consumes: nothing (pure module — no DOM, no Prisma).
- Produces (used by Tasks 2–4):
  - `type AttentionData = { pendingRequests: number; latestRequestAt: string | null; newFeatureRequests: number; maxFrNumber: number }`
  - `type SeenMarks = { requestsAt: string | null; frMax: number }`
  - `attentionStorageKey(userId: string | null): string`
  - `parseSeenMarks(raw: string | null): SeenMarks | null`
  - `shouldShowAttention(data: AttentionData, stored: SeenMarks | null): boolean`
  - `marksAfterDismiss(data: AttentionData, prior: SeenMarks | null): SeenMarks`

- [ ] **Step 1: Write the failing test**

Create `web/lib/attention/seen.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attentionStorageKey,
  marksAfterDismiss,
  parseSeenMarks,
  shouldShowAttention,
  type AttentionData,
} from "./seen";

const NONE: AttentionData = { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 0, maxFrNumber: 0 };
const BOTH: AttentionData = { pendingRequests: 3, latestRequestAt: "2026-07-24T12:00:00.000Z", newFeatureRequests: 5, maxFrNumber: 41 };

test("never-seen viewer with pending items → show", () => {
  assert.equal(shouldShowAttention(BOTH, null), true);
});

test("nothing pending never shows, even never-seen", () => {
  assert.equal(shouldShowAttention(NONE, null), false);
});

test("dismiss then same data → hidden", () => {
  const marks = marksAfterDismiss(BOTH, null);
  assert.equal(shouldShowAttention(BOTH, marks), false);
});

test("approve-then-new-arrival pops even though the COUNT is back to what was seen", () => {
  // Seen 3 pending; one approved (3→2); a NEW one arrives (2→3, newer timestamp).
  const marks = marksAfterDismiss(BOTH, null);
  const after: AttentionData = { ...BOTH, pendingRequests: 3, latestRequestAt: "2026-07-24T13:30:00.000Z" };
  assert.equal(shouldShowAttention(after, marks), true);
});

test("categories trigger independently", () => {
  const marks = marksAfterDismiss(BOTH, null);
  const newFr: AttentionData = { ...BOTH, maxFrNumber: 42, newFeatureRequests: 6 };
  assert.equal(shouldShowAttention(newFr, marks), true);
  const newReq: AttentionData = { ...BOTH, latestRequestAt: "2026-07-25T00:00:00.000Z" };
  assert.equal(shouldShowAttention(newReq, marks), true);
});

test("a category emptying out does not lose its mark", () => {
  // Dismissed with 3 pending; all get approved (0 pending, null timestamp); dismiss again on an
  // FR-only popup must NOT reset requestsAt — the old requests were seen, only NEWER ones may pop.
  const first = marksAfterDismiss(BOTH, null);
  const emptied: AttentionData = { ...BOTH, pendingRequests: 0, latestRequestAt: null };
  const second = marksAfterDismiss(emptied, first);
  assert.equal(second.requestsAt, BOTH.latestRequestAt);
  assert.equal(second.frMax, 41);
});

test("corrupt or missing stored JSON counts as never-seen", () => {
  assert.equal(parseSeenMarks(null), null);
  assert.equal(parseSeenMarks("not json {"), null);
  assert.equal(parseSeenMarks('"just a string"'), null);
  const partial = parseSeenMarks('{"frMax":"nope"}');
  assert.deepEqual(partial, { requestsAt: null, frMax: 0 });
});

test("storage key is per user, with a dev fallback", () => {
  assert.equal(attentionStorageKey("u123"), "admin_attention_seen:u123");
  assert.equal(attentionStorageKey(null), "admin_attention_seen:local");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx tsx --test lib/attention/seen.test.ts`
Expected: FAIL — cannot find module `./seen`.

- [ ] **Step 3: Write the implementation**

Create `web/lib/attention/seen.ts`:

```ts
// Show-once-per-new-items logic for the admin attention modal
// (docs/superpowers/specs/2026-07-24-admin-attention-modal-design.md).
//
// Pure: no DOM, no Prisma. The caller supplies the current high-water marks from the DB and the
// stored marks from localStorage; this decides whether anything is NEW. Identifiers, not counts:
// approve one request (3→2) then receive one (2→3) and a count comparison stays silent — the
// timestamp/number comparison pops.

export type AttentionData = {
  pendingRequests: number; // AccessRequest rows with status "pending"
  latestRequestAt: string | null; // ISO timestamp of the newest pending request (null when none)
  newFeatureRequests: number; // FeatureRequest rows with status "new" (untriaged only, by design)
  maxFrNumber: number; // highest "new" FR number (0 when none)
};

export type SeenMarks = { requestsAt: string | null; frMax: number };

export function attentionStorageKey(userId: string | null): string {
  // null = auth disabled (dev); every viewer is the same "local" admin there.
  return `admin_attention_seen:${userId ?? "local"}`;
}

// Corrupt/missing stored state counts as never-seen (null → show). Field-level salvage: a valid
// requestsAt next to a garbage frMax keeps the good half rather than re-popping both categories.
export function parseSeenMarks(raw: string | null): SeenMarks | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const requestsAt = (v as { requestsAt?: unknown }).requestsAt;
    const frMax = (v as { frMax?: unknown }).frMax;
    return {
      requestsAt: typeof requestsAt === "string" ? requestsAt : null,
      frMax: typeof frMax === "number" && Number.isFinite(frMax) ? frMax : 0,
    };
  } catch {
    return null;
  }
}

// Date.toISOString() output is fixed-width UTC, so plain string comparison orders correctly.
export function shouldShowAttention(data: AttentionData, stored: SeenMarks | null): boolean {
  const newRequests =
    data.pendingRequests > 0 &&
    data.latestRequestAt !== null &&
    (stored?.requestsAt == null || data.latestRequestAt > stored.requestsAt);
  const newFrs = data.newFeatureRequests > 0 && data.maxFrNumber > (stored?.frMax ?? 0);
  return newRequests || newFrs;
}

// Marks to store on dismissal. Keeps the prior mark when the current data is lower or gone (a
// category emptied out) — an already-seen item must never be able to re-trigger.
export function marksAfterDismiss(data: AttentionData, prior: SeenMarks | null): SeenMarks {
  const requestsAt =
    prior?.requestsAt != null && (data.latestRequestAt == null || prior.requestsAt > data.latestRequestAt)
      ? prior.requestsAt
      : data.latestRequestAt;
  return { requestsAt, frMax: Math.max(prior?.frMax ?? 0, data.maxFrNumber) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test lib/attention/seen.test.ts`
Expected: all 8 tests PASS.

Then run the full suite to prove nothing else broke: `npm test` — expected: PASS (same pass/fail set as before this task).

- [ ] **Step 5: Commit**

```bash
git add lib/attention/seen.ts lib/attention/seen.test.ts
git commit -m "feat: seen-state helper for the admin attention modal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Server data loader + modal component

**Files:**
- Create: `web/lib/attention/data.ts`
- Create: `web/app/_components/admin-attention-modal.tsx`

**Interfaces:**
- Consumes (from Task 1): `AttentionData`, `attentionStorageKey`, `parseSeenMarks`, `shouldShowAttention`, `marksAfterDismiss` from `@/lib/attention/seen`.
- Produces (used by Tasks 3–4):
  - `adminAttentionData(): Promise<AttentionData>` from `@/lib/attention/data` (server-only; never throws — degrades to zeros).
  - `AdminAttentionModal(props: AttentionData & { userId: string | null; forceOpen?: boolean; onDismiss?: () => void })` from `@/app/_components/admin-attention-modal` (client component; renders nothing when both counts are 0; `forceOpen` bypasses the seen check and never writes marks).

- [ ] **Step 1: Write the server loader**

Create `web/lib/attention/data.ts`:

```ts
// Server half of the admin attention modal: the two indexed aggregates the layout runs for
// global_admin+ viewers (AccessRequest has @@index([status, lastRequestedAt]); FeatureRequest
// number is unique). Failure-safe by contract — the layout must never break because of this
// feature, so any DB error degrades to "nothing pending".
import { db } from "@/lib/db";
import type { AttentionData } from "./seen";

export async function adminAttentionData(): Promise<AttentionData> {
  try {
    const [req, fr] = await Promise.all([
      db.accessRequest.aggregate({
        where: { status: "pending" },
        _count: { _all: true },
        _max: { lastRequestedAt: true },
      }),
      db.featureRequest.aggregate({
        where: { status: "new" },
        _count: { _all: true },
        _max: { number: true },
      }),
    ]);
    return {
      pendingRequests: req._count._all,
      latestRequestAt: req._max.lastRequestedAt?.toISOString() ?? null,
      newFeatureRequests: fr._count._all,
      maxFrNumber: fr._max.number ?? 0,
    };
  } catch {
    return { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 0, maxFrNumber: 0 };
  }
}
```

- [ ] **Step 2: Write the modal component**

Create `web/app/_components/admin-attention-modal.tsx`:

```tsx
"use client";

// Login-time "needs your attention" popup for global/super admins: pending access requests and
// untriaged (status "new") feature requests. Pops once per NEW item — dismissal stores high-water
// marks in localStorage (per user, per browser); lib/attention/seen.ts owns the comparison.
//
// forceOpen is the /tools/popup-test hook: it bypasses the seen-state check AND never writes
// marks, so exercising the modal there can't mark real items as seen. Zero items never opens,
// forced or not — "None" on the test page verifies exactly that.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  attentionStorageKey,
  marksAfterDismiss,
  parseSeenMarks,
  shouldShowAttention,
  type AttentionData,
} from "@/lib/attention/seen";

type Props = AttentionData & {
  userId: string | null;
  forceOpen?: boolean;
  onDismiss?: () => void;
};

export function AdminAttentionModal({ userId, forceOpen = false, onDismiss, ...data }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  // Decide once on mount. Later navigations re-run the server layout, which re-mounts this with
  // fresh data — there is deliberately no client-side polling.
  useEffect(() => {
    if (data.pendingRequests <= 0 && data.newFeatureRequests <= 0) return;
    if (forceOpen) {
      setOpen(true);
      return;
    }
    let stored: ReturnType<typeof parseSeenMarks> = null;
    try {
      stored = parseSeenMarks(localStorage.getItem(attentionStorageKey(userId)));
    } catch {
      // Storage unavailable (privacy mode) — treated as never-seen; it may show again. Harmless.
    }
    if (shouldShowAttention(data, stored)) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open) ref.current?.showModal();
  }, [open]);

  // Every close path (Dismiss button, Esc, following a link) funnels through the dialog's own
  // close event, so the marks are recorded exactly once per dismissal.
  function handleClose() {
    if (!forceOpen) {
      try {
        const key = attentionStorageKey(userId);
        const prior = parseSeenMarks(localStorage.getItem(key));
        localStorage.setItem(key, JSON.stringify(marksAfterDismiss(data, prior)));
      } catch {
        // Storage write failed — it may show again next load, which is harmless.
      }
    }
    setOpen(false);
    onDismiss?.();
  }

  if (!open) return null;
  const reqs = data.pendingRequests;
  const frs = data.newFeatureRequests;
  return (
    <dialog ref={ref} style={{ maxWidth: 460 }} onClose={handleClose}>
      <h2>Needs your attention</h2>
      {reqs > 0 && (
        <div className="row-between" style={{ margin: "0.9rem 0" }}>
          <span>
            <span aria-hidden="true">👤</span> {reqs} user request{reqs === 1 ? "" : "s"} awaiting approval
          </span>
          <Link href="/users" onClick={() => ref.current?.close()}>
            Review →
          </Link>
        </div>
      )}
      {frs > 0 && (
        <div className="row-between" style={{ margin: "0.9rem 0" }}>
          <span>
            <span aria-hidden="true">💡</span> {frs} new feature request{frs === 1 ? "" : "s"}
          </span>
          <Link href="/feature-requests" onClick={() => ref.current?.close()}>
            View →
          </Link>
        </div>
      )}
      <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: "1rem" }}>
        <button type="button" className="primary" onClick={() => ref.current?.close()}>
          Dismiss
        </button>
      </div>
    </dialog>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exits 0, or only errors that already exist on `main` (if unsure, note the error list from a first run made before this task's edits and compare — no NEW errors allowed).

- [ ] **Step 4: Commit**

```bash
git add lib/attention/data.ts app/_components/admin-attention-modal.tsx
git commit -m "feat: admin attention modal component + failure-safe data loader

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Layout wiring

**Files:**
- Modify: `web/app/layout.tsx` (imports block lines 10–28; data block near line 64; body near line 117)

**Interfaces:**
- Consumes: `adminAttentionData` (Task 2), `AdminAttentionModal` (Task 2), existing `acting`, `loggedIn`, `onLogin`, `ROLE_RANK`.
- Produces: the modal mounted app-wide for eligible viewers.

- [ ] **Step 1: Add imports**

In `web/app/layout.tsx`, after the line `import { ServerWatchdog } from "./_components/server-watchdog";`, add:

```tsx
import { AdminAttentionModal } from "./_components/admin-attention-modal";
import { adminAttentionData } from "@/lib/attention/data";
```

- [ ] **Step 2: Compute attention data**

Directly after the line `const openFeatureRequests = loggedIn && !onLogin ? await openFeatureRequestCount() : 0;`, add:

```tsx
  // Login-time attention popup for global/super admins: pending access requests + untriaged FRs.
  // Keys off the REAL operator — impersonation blocks mutations, so the popup's approve links
  // would 403 — and only queries when it could actually render. Failure-safe: DB trouble reads
  // as "nothing pending" (adminAttentionData never throws).
  const isRealAdmin = !authEnabled() || (!!acting.realUser && ROLE_RANK[acting.realUser.role] >= ROLE_RANK.global_admin);
  const attention = loggedIn && !onLogin && !acting.impersonating && isRealAdmin ? await adminAttentionData() : null;
```

- [ ] **Step 3: Mount the component**

Inside the existing `{loggedIn && !onLogin && ( <> … </> )}` block (the one containing `<KonamiEgg />`), add one line after `{eggs.newYear && <NewYearEgg year={eggDate.slice(0, 4)} />}`:

```tsx
            {attention && <AdminAttentionModal userId={user?.id ?? null} {...attention} />}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — expected: same result as Task 2 Step 3.
Run: `npm test` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/layout.tsx
git commit -m "feat: mount the admin attention modal from the root layout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Test page `/tools/popup-test` + nav link

**Files:**
- Create: `web/app/tools/popup-test/page.tsx`
- Create: `web/app/tools/popup-test/_components/popup-test-view.tsx`
- Modify: `web/app/_components/nav.tsx` (the `tools` array in `menuGroups()`, ~line 41)

**Interfaces:**
- Consumes: `adminAttentionData` (Task 2), `AdminAttentionModal` (Task 2), `attentionStorageKey` + `AttentionData` (Task 1), `ROLE_RANK`, `authEnabled`, `getCurrentUser`.
- Produces: the test page; a Tools menu entry (gated by the existing `showSettings` flag = settings.manage = global/super admin, matching the page's own gate).

- [ ] **Step 1: Write the server page**

Create `web/app/tools/popup-test/page.tsx`:

```tsx
// Popup test — exercise the admin attention modal in every state without touching real data.
// Same audience as the modal itself (global_admin and above), same redirect-gate shape as
// /tools/db-copy. Scenario runs use forceOpen, which never writes seen-marks; only the explicit
// "Clear seen memory" button touches localStorage.
import { redirect } from "next/navigation";
import { authEnabled, getCurrentUser } from "@/lib/auth/current-user";
import { ROLE_RANK } from "@/lib/auth/permissions";
import { adminAttentionData } from "@/lib/attention/data";
import { PopupTestView } from "./_components/popup-test-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Popup test" };

export default async function PopupTestPage() {
  let userId: string | null = null;
  if (authEnabled()) {
    const me = await getCurrentUser();
    if (!me || ROLE_RANK[me.role] < ROLE_RANK.global_admin) redirect("/clients");
    userId = me.id;
  }
  const live = await adminAttentionData();
  return <PopupTestView userId={userId} live={live} />;
}
```

- [ ] **Step 2: Write the client view**

Create `web/app/tools/popup-test/_components/popup-test-view.tsx`:

```tsx
"use client";

// Scenario harness for AdminAttentionModal. Every button feeds the REAL component fake (or live)
// data with forceOpen — the key remounts it so the same scenario fires repeatedly. "None" proves
// the modal refuses to open with zero items even when forced.
import { useState } from "react";
import { AdminAttentionModal } from "@/app/_components/admin-attention-modal";
import { attentionStorageKey, type AttentionData } from "@/lib/attention/seen";

const SCENARIOS: { key: string; label: string; data: AttentionData }[] = [
  {
    key: "both",
    label: "Both pending",
    data: { pendingRequests: 3, latestRequestAt: "2026-07-24T12:00:00.000Z", newFeatureRequests: 5, maxFrNumber: 41 },
  },
  {
    key: "requests",
    label: "Only user requests",
    data: { pendingRequests: 2, latestRequestAt: "2026-07-24T12:00:00.000Z", newFeatureRequests: 0, maxFrNumber: 0 },
  },
  {
    key: "frs",
    label: "Only feature requests",
    data: { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 4, maxFrNumber: 41 },
  },
  {
    key: "none",
    label: "None (must not open)",
    data: { pendingRequests: 0, latestRequestAt: null, newFeatureRequests: 0, maxFrNumber: 0 },
  },
];

export function PopupTestView({ userId, live }: { userId: string | null; live: AttentionData }) {
  const [active, setActive] = useState<{ key: string; run: number; data: AttentionData } | null>(null);
  const [cleared, setCleared] = useState(false);

  function fire(key: string, data: AttentionData) {
    setActive((prev) => ({ key, data, run: (prev?.run ?? 0) + 1 }));
    setCleared(false);
  }

  function clearSeen() {
    try {
      localStorage.removeItem(attentionStorageKey(userId));
      setCleared(true);
    } catch {
      // Storage unavailable — nothing to clear.
    }
  }

  return (
    <main>
      <h1>Popup test</h1>
      <p className="muted">
        Fire the admin attention modal with canned data. Scenario runs never mark anything as seen —
        real popups on other pages are unaffected. To re-test the natural on-load popup, clear the
        seen memory below, then navigate to any page.
      </p>

      <h2>Scenarios</h2>
      <div className="toolbar">
        {SCENARIOS.map((s) => (
          <button key={s.key} type="button" onClick={() => fire(s.key, s.data)}>
            {s.label}
          </button>
        ))}
        <button type="button" onClick={() => fire("live", live)}>
          Live data
        </button>
      </div>
      <p className="note">
        Live right now: {live.pendingRequests} pending user request{live.pendingRequests === 1 ? "" : "s"},{" "}
        {live.newFeatureRequests} new feature request{live.newFeatureRequests === 1 ? "" : "s"}.
      </p>
      {active?.key === "none" && (
        <p className="note">
          &ldquo;None&rdquo; fired — no modal should have appeared (zero items never opens, even forced).
        </p>
      )}

      <h2>Seen memory</h2>
      <p className="muted">
        Dismissing a real popup stores high-water marks in this browser under{" "}
        <code>{attentionStorageKey(userId)}</code>; it re-pops only when something newer arrives.
      </p>
      <div className="toolbar">
        <button type="button" onClick={clearSeen}>
          Clear seen memory
        </button>
        {cleared && <span className="note">Cleared — the next page load pops again if anything is pending.</span>}
      </div>

      {active && (
        <AdminAttentionModal
          key={`${active.key}:${active.run}`}
          userId={userId}
          forceOpen
          onDismiss={() => setActive(null)}
          {...active.data}
        />
      )}
    </main>
  );
}
```

- [ ] **Step 3: Add the nav link**

In `web/app/_components/nav.tsx`, in the `tools` array of `menuGroups()`, after the `/tools/fleet-m365` line and before the `/fleet-audit` line, add:

```tsx
    // The admin attention modal's test harness — same audience as the modal (global/super admin).
    ...(flags.showSettings ? ([["/tools/popup-test", "Popup test"]] as const) : []),
```

(`mobile-nav.tsx` shares `menuGroups`, so no second edit.)

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — expected: same result as Task 2 Step 3.
Run: `npm test` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/tools/popup-test app/_components/nav.tsx
git commit -m "feat: /tools/popup-test harness for the admin attention modal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Changelog entry + full verification

**Files:**
- Create: `web/lib/changelog/entries/admin-attention-modal.ts`
- Modify: `web/lib/changelog/entries/_registry.ts` (one line, in id order)

**Interfaces:**
- Consumes: `ChangelogEntry` from `../format`.
- Produces: the entry on `/changelog` (registry.test.ts enforces file↔registry match).

- [ ] **Step 1: Get the timestamp**

Run: `TZ=America/New_York date +%H:%M`
Round the result DOWN to the nearest quarter hour (`:00`, `:15`, `:30`, `:45`) — e.g. `14:38` → `14:30`. Use that value for `time` below.

- [ ] **Step 2: Create the entry**

Create `web/lib/changelog/entries/admin-attention-modal.ts` (replace `HH:MM` with the Step 1 value):

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "admin-attention-modal",
  date: "2026-07-24",
  time: "HH:MM",
  title: "Admins now get a heads-up popup when something is waiting on them",
  items: [
    "Global and super admins see a \"Needs your attention\" popup when there are pending user access requests or new feature requests, with one-click links to review them",
    "It pops once per new item, not on every login: dismiss it and it stays quiet until something new actually arrives",
    "A new Popup test page under Tools lets admins preview every state of the popup without touching real data",
  ],
};
```

- [ ] **Step 3: Register it**

In `web/lib/changelog/entries/_registry.ts`, insert in id order — after the line exporting from `./ad-synced-adopt-only` (ASCII: `-` sorts before `m`, so `ad-synced…` < `admin-…`; place it before whatever currently follows, keeping strict alphabetical order by file id):

```ts
export { entry as adminAttentionModal } from "./admin-attention-modal";
```

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: PASS — including `lib/changelog/entries/registry.test.ts` (file↔registry match) and `lib/changelog/entries.test.ts` (quarter-hour time format).

Run: `npx tsc --noEmit` — expected: same result as Task 2 Step 3.

- [ ] **Step 5: Commit**

```bash
git add lib/changelog/entries/admin-attention-modal.ts lib/changelog/entries/_registry.ts
git commit -m "docs: changelog entry for the admin attention modal

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Manual verification (after all tasks)

From `web/` in the worktree, with a dev server (`npm run dev` — never `next build`):

1. Visit `/tools/popup-test` as a global/super admin (auth-off dev counts): fire each scenario — *Both* shows two rows, *Only user requests* / *Only feature requests* show one, *None* shows nothing, *Live data* matches the printed counts.
2. Dismiss with the button, with Esc, and by clicking a link — each closes; links navigate.
3. Clear seen memory, navigate to `/clients` — the real popup appears if anything is live-pending; dismiss it; navigate again — it stays quiet.
4. Confirm no popup on `/login`, and no "Popup test" nav entry for a non-admin role.
