# Add "directory-sync" button in hybrid-client warning box — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the "hybrid client has no directory-sync step" warning on the client detail page into a one-confirm action that adds a correctly shaped `directory-sync` system.

**Architecture:** A pure helper builds the canonical `directory-sync` `EditableSystem` (shape varies by whether it orders after `active-directory` or `exchange`) and appends it idempotently to a client's system set. A small `"use client"` island renders the existing warning box plus an "Add directory-sync" button that opens a prefilled `<dialog>`; on confirm it reads the client's current systems, appends the row via the helper, and PUTs the full set back through the existing full-replace `/systems` route. No new API endpoint, no runner/migration.

**Tech Stack:** Next.js App Router (TypeScript), React client components, Node built-in test runner (`tsx --test`, `node:test` + `node:assert/strict`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-add-directory-sync-button-design.md`.
- Web-only. No runner version bump, no Prisma migration.
- Reuse the existing `PUT /api/clients/[slug]/systems` route — it is a **full replace** (deletes any `systemKey` not in the payload), so the confirm action MUST send the client's complete system set plus the new row, never the single row alone.
- `EditableSystem` (`web/lib/clients/types.ts:37`): `{ systemKey, mode, onboardWhen, offboardWhen, dependsOn[], requiresApproval, captureEvidence, secretNames[], config }`. `GET /api/clients/[slug]` returns systems in this same field shape.
- Canonical `directory-sync`: `mode:"api"`, onboard/offboard `"always"`, `secretNames:["ad-dc"]` (ad-dc is OPTIONAL — no wiring needed to run). `orderAfter:"active-directory"` → `dependsOn:["active-directory"]`, `config:null`. `orderAfter:"exchange"` → `dependsOn:["exchange"]`, `config:{ onboard:{ command:"Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox:true } }`.
- Backbone: only ever set to `"ad_synced"` when the dialog checkbox is on; otherwise leave the client's current backbone unchanged (never null it).
- Tests run from `web/`: single file via `npx tsx --test lib/clients/<name>.test.ts`; full suite via `npm test`.
- Changelog: one file per entry in `web/lib/changelog/entries/`, registered in `_registry.ts`; `time` is Eastern on a 15-minute boundary.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## File Structure

- **Create** `web/lib/clients/directory-sync-row.ts` — pure helpers `directorySyncRow(opts)` and `withDirectorySync(systems, opts)`. One responsibility: the canonical directory-sync shape + idempotent append.
- **Create** `web/lib/clients/directory-sync-row.test.ts` — unit tests for the helpers.
- **Create** `web/app/clients/_components/add-directory-sync-button.tsx` — `"use client"` island: warning box + button + confirm dialog + confirm action.
- **Modify** `web/app/clients/[slug]/page.tsx:342-346` — replace inline warning JSX with `<AddDirectorySyncButton .../>` (+ import).
- **Create** `web/lib/changelog/entries/add-directory-sync-button.ts` — changelog entry.
- **Modify** `web/lib/changelog/entries/_registry.ts` — register the entry.

---

### Task 1: Pure helper `directory-sync-row.ts`

**Files:**
- Create: `web/lib/clients/directory-sync-row.ts`
- Test: `web/lib/clients/directory-sync-row.test.ts`

**Interfaces:**
- Consumes: `EditableSystem` from `web/lib/clients/types.ts`.
- Produces:
  - `type DirectorySyncOpts = { orderAfter: "active-directory" | "exchange" }`
  - `directorySyncRow(opts: DirectorySyncOpts): EditableSystem`
  - `withDirectorySync(systems: EditableSystem[], opts: DirectorySyncOpts): EditableSystem[]`

- [ ] **Step 1: Write the failing test**

Create `web/lib/clients/directory-sync-row.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EditableSystem } from "./types";
import { directorySyncRow, withDirectorySync } from "./directory-sync-row";

const ad: EditableSystem = {
  systemKey: "active-directory", mode: "api", onboardWhen: "always", offboardWhen: "always",
  dependsOn: [], requiresApproval: false, captureEvidence: false, secretNames: ["ad-dc"], config: null,
};
const m365: EditableSystem = {
  systemKey: "m365", mode: "api", onboardWhen: "always", offboardWhen: "always",
  dependsOn: [], requiresApproval: false, captureEvidence: false, secretNames: ["m365"], config: null,
};

test("directorySyncRow ordered after active-directory has null config and depends on AD", () => {
  const row = directorySyncRow({ orderAfter: "active-directory" });
  assert.equal(row.systemKey, "directory-sync");
  assert.equal(row.mode, "api");
  assert.equal(row.onboardWhen, "always");
  assert.equal(row.offboardWhen, "always");
  assert.deepEqual(row.dependsOn, ["active-directory"]);
  assert.deepEqual(row.secretNames, ["ad-dc"]);
  assert.equal(row.requiresApproval, false);
  assert.equal(row.captureEvidence, false);
  assert.equal(row.config, null);
});

test("directorySyncRow ordered after exchange waits for mailbox", () => {
  const row = directorySyncRow({ orderAfter: "exchange" });
  assert.deepEqual(row.dependsOn, ["exchange"]);
  assert.deepEqual(row.config, {
    onboard: { command: "Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox: true },
  });
});

test("withDirectorySync appends exactly one row and keeps existing systems", () => {
  const out = withDirectorySync([ad, m365], { orderAfter: "active-directory" });
  assert.equal(out.length, 3);
  assert.deepEqual(out.slice(0, 2), [ad, m365]); // existing untouched, order preserved
  assert.equal(out[2].systemKey, "directory-sync");
});

test("withDirectorySync is idempotent when directory-sync already present", () => {
  const existing = [ad, directorySyncRow({ orderAfter: "exchange" }), m365];
  const out = withDirectorySync(existing, { orderAfter: "active-directory" });
  assert.equal(out, existing); // same reference — unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npx tsx --test lib/clients/directory-sync-row.test.ts`
Expected: FAIL — cannot resolve `./directory-sync-row` / `directorySyncRow is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `web/lib/clients/directory-sync-row.ts`:

```ts
// The canonical `directory-sync` system shape and an idempotent way to add it to a client's
// system set. Kept pure (no fetch/DOM) so the shape logic is unit-tested without a browser.
// `directory-sync` makes an AD client "ad-synced": AD accounts are pushed to Entra before the
// cloud steps run. Ordered after `active-directory` normally, or after `exchange` (waiting for
// the mailbox) for hybrid-Exchange clients (the coretelligent.json pattern). `ad-dc` is an
// OPTIONAL secret — a DC agent authenticates as ambient SYSTEM — so the row needs no wiring to run.
import type { EditableSystem } from "./types";

export type DirectorySyncOpts = { orderAfter: "active-directory" | "exchange" };

export function directorySyncRow(opts: DirectorySyncOpts): EditableSystem {
  const config =
    opts.orderAfter === "exchange"
      ? { onboard: { command: "Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox: true } }
      : null;
  return {
    systemKey: "directory-sync",
    mode: "api",
    onboardWhen: "always",
    offboardWhen: "always",
    dependsOn: [opts.orderAfter],
    requiresApproval: false,
    captureEvidence: false,
    secretNames: ["ad-dc"],
    config,
  };
}

export function withDirectorySync(systems: EditableSystem[], opts: DirectorySyncOpts): EditableSystem[] {
  if (systems.some((s) => s.systemKey === "directory-sync")) return systems;
  return [...systems, directorySyncRow(opts)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `web/`): `npx tsx --test lib/clients/directory-sync-row.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/lib/clients/directory-sync-row.ts web/lib/clients/directory-sync-row.test.ts
git commit -m "feat: canonical directory-sync row + idempotent append helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `AddDirectorySyncButton` component + wire into the page

**Files:**
- Create: `web/app/clients/_components/add-directory-sync-button.tsx`
- Modify: `web/app/clients/[slug]/page.tsx` (import + replace warning block at lines 342-346)

**Interfaces:**
- Consumes: `withDirectorySync`, `DirectorySyncOpts` from `web/lib/clients/directory-sync-row.ts`; `EditableSystem` from `web/lib/clients/types.ts`. Reads `GET /api/clients/[slug]` (`{ systems, backbone }`) and writes `PUT /api/clients/[slug]/systems` (`{ systems, backbone }`).
- Produces: `AddDirectorySyncButton({ slug, hasExchange, backbone })` React component (named export).

- [ ] **Step 1: Create the component**

Create `web/app/clients/_components/add-directory-sync-button.tsx`:

```tsx
"use client";

// Shown under the Systems heading when a hybrid client (on-prem active-directory + a cloud
// identity system) has no `directory-sync` row. Renders the existing warning box plus a button
// that opens a prefilled confirm dialog; confirming reads the client's CURRENT systems, appends
// a canonical directory-sync row, and PUTs the FULL set back (the /systems route is a full
// replace, so we must never send the single row alone). See
// docs/superpowers/specs/2026-07-22-add-directory-sync-button-design.md.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EditableSystem } from "@/lib/clients/types";
import { withDirectorySync, type DirectorySyncOpts } from "@/lib/clients/directory-sync-row";

export function AddDirectorySyncButton({
  slug,
  hasExchange,
  backbone,
}: {
  slug: string;
  hasExchange: boolean;
  backbone: string | null;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [orderAfter, setOrderAfter] = useState<DirectorySyncOpts["orderAfter"]>(
    hasExchange ? "exchange" : "active-directory",
  );
  const alreadySynced = backbone === "ad_synced";
  const [setAdSynced, setSetAdSynced] = useState(!alreadySynced);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openDialog() {
    setError(null);
    ref.current?.showModal();
  }
  function closeDialog() {
    if (!saving) ref.current?.close();
  }

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}`);
      if (!res.ok) {
        setError(`Could not load current systems (${res.status})`);
        return;
      }
      const c = await res.json();
      // GET returns systems in the EditableSystem field shape already; keep only those fields so
      // the PUT payload is clean (the route's sanitize() ignores extras, but this is explicit).
      const current: EditableSystem[] = (c.systems ?? []).map((s: Record<string, unknown>) => ({
        systemKey: s.systemKey,
        mode: s.mode,
        onboardWhen: s.onboardWhen,
        offboardWhen: s.offboardWhen,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        requiresApproval: Boolean(s.requiresApproval),
        captureEvidence: Boolean(s.captureEvidence),
        secretNames: Array.isArray(s.secretNames) ? s.secretNames : [],
        config: s.config ?? null,
      }));
      const systems = withDirectorySync(current, { orderAfter });
      const nextBackbone = setAdSynced ? "ad_synced" : (c.backbone ?? null);
      const put = await fetch(`/api/clients/${slug}/systems`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systems, backbone: nextBackbone }),
      });
      const data = await put.json().catch(() => ({}));
      if (!put.ok) {
        setError(data.error ?? `Save failed (${put.status})`);
        return;
      }
      ref.current?.close();
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p
        className="note"
        style={{
          color: "var(--warn-fg)",
          border: "1px solid var(--warn-fg)",
          background: "var(--warn-bg)",
          borderRadius: 8,
          padding: "0.5rem 0.7rem",
          margin: "0 0 0.75rem",
        }}
      >
        ⚠ Hybrid client with on-prem Active Directory <b>and</b> cloud systems, but{" "}
        <b>no directory-sync step</b>. New AD accounts won&rsquo;t be pushed to Entra before the
        cloud steps run — they can race or fail. Add <b>directory-sync</b> (depends on{" "}
        <code>active-directory</code>) below, or in <b>Edit systems</b>.
        <br />
        <button type="button" onClick={openDialog} style={{ marginTop: 8 }}>
          Add directory-sync
        </button>
      </p>

      <dialog ref={ref} style={{ maxWidth: 520, borderRadius: 8, border: "1px solid var(--border)" }}>
        <h3 style={{ marginTop: 0 }}>Add directory-sync</h3>
        <p className="note">
          Adds a <code>directory-sync</code> system so AD accounts sync to Entra before the cloud
          steps run. Mode <code>api</code>, runs on onboard <b>and</b> offboard. Uses the{" "}
          <code>ad-dc</code> secret, which is optional — the DC agent authenticates as SYSTEM, so no
          credential wiring is required for it to run.
        </p>

        <label style={{ display: "block", margin: "0.75rem 0" }}>
          Order after
          <br />
          <select
            value={orderAfter}
            onChange={(e) => setOrderAfter(e.target.value as DirectorySyncOpts["orderAfter"])}
            disabled={saving}
          >
            <option value="active-directory">active-directory</option>
            <option value="exchange">exchange (wait for mailbox)</option>
          </select>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "0.75rem 0" }}>
          <input
            type="checkbox"
            checked={setAdSynced}
            disabled={saving || alreadySynced}
            onChange={(e) => setSetAdSynced(e.target.checked)}
          />
          {alreadySynced
            ? "Backbone is already ad-synced"
            : "Also set backbone to ad-synced"}
        </label>

        {error && (
          <p className="note" style={{ color: "#b91c1c" }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" onClick={closeDialog} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={confirm} disabled={saving}>
            {saving ? "Adding…" : "Add directory-sync"}
          </button>
        </div>
      </dialog>
    </>
  );
}
```

- [ ] **Step 2: Wire it into the page — add the import**

In `web/app/clients/[slug]/page.tsx`, add to the component imports (near the other
`_components` imports, e.g. next to `SyncSystemsButton`):

```tsx
import { AddDirectorySyncButton } from "../_components/add-directory-sync-button";
```

(Verify the exact relative path matches how sibling `_components` are imported in this file —
match `SyncSystemsButton`'s import specifier prefix.)

- [ ] **Step 3: Replace the inline warning block**

In `web/app/clients/[slug]/page.tsx`, replace the block at lines 342-346:

```tsx
      {sysByKey.has("active-directory") && (sysByKey.has("m365") || sysByKey.has("entra") || sysByKey.has("exchange")) && !sysByKey.has("directory-sync") && (
        <p className="note" style={{ color: "var(--warn-fg)", border: "1px solid var(--warn-fg)", background: "var(--warn-bg)", borderRadius: 8, padding: "0.5rem 0.7rem", margin: "0 0 0.75rem" }}>
          ⚠ Hybrid client with on-prem Active Directory <b>and</b> cloud systems, but <b>no directory-sync step</b>. New AD accounts won&rsquo;t be pushed to Entra before the cloud steps run — they can race or fail. Add <b>directory-sync</b> (depends on <code>active-directory</code>) in <b>Edit systems</b>.
        </p>
      )}
```

with:

```tsx
      {sysByKey.has("active-directory") && (sysByKey.has("m365") || sysByKey.has("entra") || sysByKey.has("exchange")) && !sysByKey.has("directory-sync") && (
        <AddDirectorySyncButton slug={client.slug} hasExchange={sysByKey.has("exchange")} backbone={client.backbone} />
      )}
```

- [ ] **Step 4: Typecheck + build-lint the changed files**

Run (from `web/`): `npx tsc --noEmit`
Expected: no new errors referencing `add-directory-sync-button.tsx` or the page. (If the repo's
`tsc --noEmit` is slow/noisy, at minimum confirm zero errors in the two touched files.)

- [ ] **Step 5: Manual verification (dev server)**

Start the worktree dev server per `web-dev-verify-recipe` memory, then load `core1561`
(Agostino Food):
- The warning box shows an **Add directory-sync** button.
- Click → dialog opens; "Order after" defaults to `exchange (wait for mailbox)` if the client has
  exchange, else `active-directory`; the ad-synced checkbox is checked (client isn't ad_synced).
- Confirm → dialog closes, page refreshes, warning is gone.
- Open **Edit systems** → a `directory-sync` row exists with the chosen dependsOn/config; the
  backbone shows `ad-synced`; all previously existing systems are still present.

Note in the commit/PR body what was verified.

- [ ] **Step 6: Commit**

```bash
git add web/app/clients/_components/add-directory-sync-button.tsx web/app/clients/[slug]/page.tsx
git commit -m "feat: one-click Add directory-sync button in hybrid-client warning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Changelog entry

**Files:**
- Create: `web/lib/changelog/entries/add-directory-sync-button.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

- [ ] **Step 1: Get the current Eastern time on a 15-minute boundary**

Run: `TZ=America/New_York date +"%Y-%m-%d %H:%M"`
Round the minutes DOWN to the nearest 15 (`:00`, `:15`, `:30`, `:45`). Use that date + rounded
time in the entry below.

- [ ] **Step 2: Create the entry**

Create `web/lib/changelog/entries/add-directory-sync-button.ts` (substitute the real date/time):

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "add-directory-sync-button",
  date: "2026-07-22",
  time: "16:15",
  title: "Add directory-sync to a hybrid client in one click from its warning box",
  items: [
    "A hybrid client (on-prem Active Directory + a cloud identity system) with no directory-sync step showed a warning telling you to go add it by hand in Edit systems - now the warning has an Add directory-sync button",
    "The button opens a prefilled confirm dialog: it drops in the canonical directory-sync system (api mode, runs on onboard and offboard, uses the optional ad-dc secret so no credential wiring is needed)",
    "'Order after' defaults to exchange with wait-for-mailbox when the client has Exchange, otherwise active-directory; a checkbox (on by default) also flips the client's backbone to ad-synced",
    "Confirming re-reads the client's current systems and saves the whole set back, so every existing system is preserved; adding is idempotent if a directory-sync row already exists",
  ],
};
```

- [ ] **Step 3: Register the entry**

In `web/lib/changelog/entries/_registry.ts`, append at the end of the export list:

```ts
export { entry as addDirectorySyncButton } from "./add-directory-sync-button";
```

- [ ] **Step 4: Verify the changelog compiles**

Run (from `web/`): `npx tsc --noEmit`
Expected: no errors referencing the changelog files.

- [ ] **Step 5: Commit**

```bash
git add web/lib/changelog/entries/add-directory-sync-button.ts web/lib/changelog/entries/_registry.ts
git commit -m "docs: changelog for Add directory-sync button

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] From `web/`: `npm test` — full suite green (includes the new `directory-sync-row.test.ts`).
- [ ] From `web/`: `npx tsc --noEmit` — no new type errors.
- [ ] Manual check on `core1561` recorded (Task 2 Step 5).
- [ ] Push the branch and open a **draft** PR (`gh pr create --draft`) with a body noting: web-only, no runner bump, no migration; what was manually verified.

## Self-review notes (author)

- **Spec coverage:** warning-site swap (Task 2 S2-3) ✓; prefilled dialog with order-after + backbone checkbox (Task 2 S1) ✓; confirm = GET→append→PUT full set (Task 2 S1) ✓; pure helper + idempotency (Task 1) ✓; unit tests (Task 1) ✓; changelog (Task 3) ✓; no new endpoint / no migration (Global Constraints) ✓.
- **Type consistency:** `DirectorySyncOpts.orderAfter` union used identically in helper, tests, and component; `withDirectorySync`/`directorySyncRow` names consistent across tasks; `EditableSystem` fields match `types.ts:37`.
- **Placeholder scan:** date/time in Task 3 is intentionally computed at execution (Step 1) — the shown `16:15` is a substitute-me value, not a code placeholder.
