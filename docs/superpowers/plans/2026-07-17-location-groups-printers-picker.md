# Location groups picker + printers box (client page polish) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single free-text location targets box with a structured, sectioned AD/365 groups multi-select plus a separate free-text printers box; make printers a manual checklist step at plan time; and do a full visual polish pass on the `/clients` list and client detail page.

**Architecture:** Group enumeration from AD (`Client.adObjects.groups: string[]`) and 365 (`Client.cloudGroups.groups: {name,type}[]`) already exists and already feeds the current editor's autocomplete — this is a UI/data-shape upgrade over existing discovery. Per location we split the existing `groups[]` into groups-only + a new `printers[]` (lazy auto-classify for display; persisted on save). At plan time, groups keep unioning into directory jobs; each location's persisted printers emit one `mode:"manual"` job (systemKey `"printers"`) injected in `resolvePlannedConfigs`, the shared plan/re-plan choke point.

**Tech Stack:** Next.js App Router (TypeScript, React) + Prisma + PostgreSQL (`web/`). Tests: Node built-in test runner via `tsx --test "lib/**/*.test.ts"` (`npm test` from `web/`). No jest/vitest; only `lib/**` is unit-tested.

## Global Constraints

- Run all commands from the worktree `web/` dir: `/Users/evankent/coding/newuserscript/.claude/worktrees/clients-location-groups-printers/web`.
- Unit tests live ONLY under `web/lib/**/*.test.ts`; run with `npm test`. Route handlers and React components are NOT unit-tested in this repo — test their extracted pure logic in `lib/`, and verify UI by running the app.
- Test import style: `import { test } from "node:test";` and `import assert from "node:assert/strict";`.
- Prisma mocking = hand-rolled `fakeDb` object cast to `PrismaClient` (see `web/lib/clients/parent-inheritance.test.ts`). No auto-mock lib.
- UI follows the host design system (CLAUDE.md): flat, minimal borders, sentence case, no gradients. Aesthetic detail is owned by the `frontend-design` skill.
- Changelog: APPEND a new entry to `web/lib/changelog/entries.ts` on ship; `time` MUST be Eastern (`TZ=America/New_York date +%H:%M`).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Do NOT run `next build` while a `next dev` server is live (corrupts `.next`).
- Location entry shape (source of truth): `{ address?, city?, state?, zip?, timezone?, country?:{short,name,code}, groups?: string[], printers?: string[], ou?: string, attributes?: object }`. `printers === undefined` ⇒ un-migrated (pre-feature); `printers` present (even `[]`) ⇒ split persisted.

---

### Task 1: Pure helpers — classify + apply location targets

**Files:**
- Create: `web/lib/profiles/location-targets.ts`
- Test: `web/lib/profiles/location-targets.test.ts`

**Interfaces:**
- Produces:
  - `classifyLocationTargets(existingGroups: string[], discoveredNames: Iterable<string>): { groups: string[]; printers: string[] }` — names matching a discovered group stay in `groups`, the rest become `printers`. Guard: if the discovered set is empty, return `{ groups: [...existingGroups], printers: [] }` (never guess).
  - `applyLocationTargets(entry: Record<string, unknown>, targets: { groups: string[]; printers: string[]; ou: string }): Record<string, unknown>` — returns a shallow-cloned entry with `groups`/`printers`/`ou` set when non-empty or deleted when empty; all other keys preserved.

- [ ] **Step 1: Write the failing tests**

Create `web/lib/profiles/location-targets.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLocationTargets, applyLocationTargets } from "./location-targets";

test("classify: discovered names → groups, rest → printers", () => {
  const out = classifyLocationTargets(
    ["FalconBOS", "HP-Reception", "FIA-Sec"],
    ["FalconBOS", "FIA-Sec", "Something-Else"],
  );
  assert.deepEqual(out.groups, ["FalconBOS", "FIA-Sec"]);
  assert.deepEqual(out.printers, ["HP-Reception"]);
});

test("classify: empty discovery keeps everything as groups (never guess)", () => {
  const out = classifyLocationTargets(["A", "B"], []);
  assert.deepEqual(out.groups, ["A", "B"]);
  assert.deepEqual(out.printers, []);
});

test("classify: empty input → empty split", () => {
  const out = classifyLocationTargets([], ["A"]);
  assert.deepEqual(out, { groups: [], printers: [] });
});

test("apply: sets non-empty, deletes empty, preserves other keys", () => {
  const entry = { city: "Boston", groups: ["old"], printers: ["oldp"], ou: "OU=x", zip: "02110" };
  const out = applyLocationTargets(entry, { groups: ["G1"], printers: [], ou: "" });
  assert.equal(out.city, "Boston");
  assert.equal(out.zip, "02110");
  assert.deepEqual(out.groups, ["G1"]);
  assert.ok(!("printers" in out)); // empty ⇒ deleted
  assert.ok(!("ou" in out));       // empty ⇒ deleted
});

test("apply: does not mutate the input entry", () => {
  const entry = { groups: ["old"] };
  applyLocationTargets(entry, { groups: ["new"], printers: ["p"], ou: "" });
  assert.deepEqual(entry, { groups: ["old"] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `web/`): `npm test`
Expected: FAIL — `Cannot find module './location-targets'`.

- [ ] **Step 3: Implement the helpers**

Create `web/lib/profiles/location-targets.ts`:

```ts
// Split a location's flat targets into real groups vs printers, and apply an
// edited split back onto a location entry. Used by the UI/view-model (display
// split of un-migrated locations) and the set-location-targets API handler.

export function classifyLocationTargets(
  existingGroups: string[],
  discoveredNames: Iterable<string>,
): { groups: string[]; printers: string[] } {
  const discovered = new Set<string>();
  for (const n of discoveredNames) if (typeof n === "string" && n.trim()) discovered.add(n);
  if (discovered.size === 0) return { groups: [...existingGroups], printers: [] };
  const groups: string[] = [];
  const printers: string[] = [];
  for (const g of existingGroups) (discovered.has(g) ? groups : printers).push(g);
  return { groups, printers };
}

export function applyLocationTargets(
  entry: Record<string, unknown>,
  targets: { groups: string[]; printers: string[]; ou: string },
): Record<string, unknown> {
  const out = { ...entry };
  if (targets.groups.length) out.groups = targets.groups; else delete out.groups;
  if (targets.printers.length) out.printers = targets.printers; else delete out.printers;
  if (targets.ou) out.ou = targets.ou; else delete out.ou;
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all four/five new tests green, existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add web/lib/profiles/location-targets.ts web/lib/profiles/location-targets.test.ts
git commit -m "Add classify/apply location-target helpers (groups vs printers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Plan-resolve — groups union unchanged; printers → one manual job

**Files:**
- Modify: `web/lib/profiles/plan-resolve.ts` (onboard branch, the location block at ~L116-138)
- Modify: `web/lib/cases/run-report.ts` (add `printers` to `ADHOC_STEP_LABELS`, and export it)
- Modify: `web/lib/cases/repository.ts` (`getCase` name fallback to use the adhoc label)
- Test: `web/lib/profiles/plan-resolve.test.ts` (append tests)

**Interfaces:**
- Consumes: the matched `location` object (same reference as an entry in `client.locations`) already destructured in `resolvePlannedConfigs`; the `planned: PlannedJob[]` array.
- Produces: for an onboard with a matched location that has a persisted `printers: string[]`, exactly one appended `PlannedJob` with `systemKey: "printers"`, `mode: "manual"`, `config: { note: "Map printers at <name>: <a, b>" }`.

Notes on the safe design (do NOT deviate):
- Read ONLY the persisted `location.printers` (an array). If `printers` is not an array (un-migrated), do nothing extra — existing behavior is preserved (typed printers still ride in `groups` until the location is edited once in the new UI). Do NOT re-classify at plan time (would risk demoting a real-but-undiscovered group to a printer).
- The groups union block stays as-is: it reads `location.groups`. After migration `groups` is groups-only, so the union is automatically correct.
- Inject in `resolvePlannedConfigs` so BOTH create (`planning-service.ts`) and re-plan (`replan-service.ts`) re-emit it — otherwise `replanCaseJobs` deletes the orphan (`repository.ts` reconcile-by-systemKey).

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/profiles/plan-resolve.test.ts`:

```ts
test("a matched location's persisted printers emit one manual 'printers' job", () => {
  const locClient = {
    personas: null, globals: null,
    locations: {
      Boston: { city: "Boston", groups: ["FalconBOS"], printers: ["HP-Reception", "MFP-3rd"] },
    },
  };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const planned = [job("active-directory", {}), job("m365", {})];
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", planned);
  // groups still union into directory jobs
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["FalconBOS"]);
  // exactly one manual printers job, with the note
  const printerJobs = resolved.filter((j) => j.systemKey === "printers");
  assert.equal(printerJobs.length, 1);
  assert.equal(printerJobs[0].mode, "manual");
  assert.equal(printerJobs[0].requiresApproval, false);
  assert.deepEqual(printerJobs[0].secretNames, []);
  assert.equal((printerJobs[0].config as { note?: string }).note, "Map printers at Boston: HP-Reception, MFP-3rd");
});

test("un-migrated location (no printers key) emits no printers job and preserves group union", () => {
  const locClient = {
    personas: null, globals: null,
    locations: { Boston: { city: "Boston", groups: ["FalconBOS", "TypedPrinter"] } },
  };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", [job("active-directory", {})]);
  assert.equal(resolved.filter((j) => j.systemKey === "printers").length, 0);
  const ad = resolved.find((j) => j.systemKey === "active-directory")!.config as Record<string, unknown>;
  assert.deepEqual(ad.groups, ["FalconBOS", "TypedPrinter"]); // unchanged legacy behavior
});

test("printers only (no groups) still emits the manual job", () => {
  const locClient = { personas: null, globals: null, locations: { Boston: { city: "Boston", printers: ["HP-Reception"] } } };
  const p = { firstName: "A", lastName: "B", officeLocation: "Boston", samAccountName: "ab", userPrincipalName: "ab@x.com", primaryDomain: "x.com" };
  const resolved = resolvePlannedConfigs(locClient, p, "onboard", [job("active-directory", {})]);
  assert.equal(resolved.filter((j) => j.systemKey === "printers").length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — the `printers` job is not emitted yet (`printerJobs.length` is 0).

- [ ] **Step 3: Implement — append the manual printers job in the onboard branch**

In `web/lib/profiles/plan-resolve.ts`, after the location group-union block that produces `withLoc` (the block ending ~L138 that returns the mapped jobs), add the printers injection. The onboard branch already has `location` in scope. Add:

```ts
// Printers attached to the matched location become one manual checklist step.
// Only the persisted split (location.printers as an array) is honored — never
// re-classify here, to avoid demoting a real-but-undiscovered group to a printer.
const locPrinters = Array.isArray((location as { printers?: unknown } | null)?.printers)
  ? ((location as { printers: unknown[] }).printers).filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
  : [];
if (locPrinters.length === 0) return withLoc;

const locName = client.locations && typeof client.locations === "object"
  ? (Object.entries(client.locations as Record<string, unknown>).find(([, v]) => v === location)?.[0] ?? "the location")
  : "the location";
const nextSeq = withLoc.reduce((m, j) => Math.max(m, j.sequence), 0) + 1;
const printersJob = {
  systemKey: "printers",
  sequence: nextSeq,
  mode: "manual" as const,
  requiresApproval: false,
  captureEvidence: false,
  intent: null,
  secretNames: [],
  dependsOn: [],
  config: { note: `Map printers at ${locName}: ${locPrinters.join(", ")}` },
};
return [...withLoc, printersJob];
```

Notes for the implementer:
- `withLoc` is the array the onboard branch was about to return; ensure this replaces the existing single `return withLoc;` for the onboard path so the printers job is appended.
- `PlannedJob` type is in `web/lib/orchestrator.ts:13-25`; `mode: "manual"` and `intent: null` match it. If TS complains about the literal, import/annotate as `PlannedJob`.

- [ ] **Step 4: Add a friendly label for the `printers` key**

In `web/lib/cases/run-report.ts`, find `ADHOC_STEP_LABELS` (used at ~L378 as `ADHOC_STEP_LABELS[j.systemKey]`). Add a `printers` entry and ensure it is exported:

```ts
export const ADHOC_STEP_LABELS: Record<string, string> = {
  // ...existing entries...
  printers: "Printers",
};
```

In `web/lib/cases/repository.ts` `getCase` (name fallback at ~L826 `nameByKey.get(j.systemKey) ?? j.systemKey`), import the label map and extend the fallback:

```ts
import { ADHOC_STEP_LABELS } from "./run-report";
// ...
systemName: nameByKey.get(j.systemKey) ?? ADHOC_STEP_LABELS[j.systemKey] ?? j.systemKey,
```

(If `run-report.ts` importing creates a cycle, instead define `ADHOC_STEP_LABELS` in a tiny new module `web/lib/cases/step-labels.ts` and import it from both files. Prefer the direct import; only split if `npm test`/typecheck reveals a cycle.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all three new plan-resolve tests green; existing plan-resolve tests (including the group-union test) still green.

- [ ] **Step 6: Commit**

```bash
git add web/lib/profiles/plan-resolve.ts web/lib/profiles/plan-resolve.test.ts web/lib/cases/run-report.ts web/lib/cases/repository.ts
git commit -m "Plan-resolve: location printers emit one manual checklist step

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: API — `set-location-targets` accepts and persists `printers`

**Files:**
- Modify: `web/app/api/clients/[slug]/route.ts` (the `set-location-targets` branch, L130-147)

**Interfaces:**
- Consumes: `applyLocationTargets` from `web/lib/profiles/location-targets.ts` (Task 1).
- Produces: PATCH body now accepts `printers?: string[]` alongside `groups?`, `ou?`. Persists both.

- [ ] **Step 1: Update the handler**

In `web/app/api/clients/[slug]/route.ts`:

1. Add the import near the other lib imports:

```ts
import { applyLocationTargets } from "@/lib/profiles/location-targets";
```

2. Add `printers?` to the `body` type declaration (the type at ~L31 already lists `name?`, `groups?`, `ou?`): add `printers?: unknown;`.

3. Replace the merge portion of the branch. The current branch parses `groups` and `ou`, then builds `entry` by hand. Change it to also parse `printers` and delegate the merge:

```ts
if (body.action === "set-location-targets") {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "location name required" }, { status: 422 });
  const parseNames = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim()) : [];
  const groups = parseNames(body.groups);
  const printers = parseNames(body.printers);
  const ou = typeof body.ou === "string" ? body.ou.trim() : "";
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, locations: true } });
  if (!client) return NextResponse.json({ error: "client not found" }, { status: 404 });
  const locs = client.locations && typeof client.locations === "object" && !Array.isArray(client.locations)
    ? { ...(client.locations as Record<string, Record<string, unknown>>) } : {};
  if (!locs[name]) return NextResponse.json({ error: `no location named "${name}"` }, { status: 422 });
  locs[name] = applyLocationTargets({ ...locs[name] }, { groups, printers, ou });
  await db.client.update({ where: { id: client.id }, data: { locations: locs as Prisma.InputJsonValue } });
  await repo.writeAudit({ actor: who.label, userId: who.userId, action: "client.location_targets.set", clientId: client.id, detail: { name, groups: groups.length, printers: printers.length, ou: ou || null } });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Typecheck**

Run (from `web/`): `npx tsc --noEmit`
Expected: no new type errors from this file. (`applyLocationTargets` returns `Record<string,unknown>`; assigning into `locs[name]` is fine since `locs` is `Record<string, Record<string,unknown>>`.)

- [ ] **Step 3: Commit**

```bash
git add web/app/api/clients/[slug]/route.ts
git commit -m "API: set-location-targets persists printers alongside groups

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `GroupMultiselect` component (sectioned, searchable, multi-select)

**Files:**
- Create: `web/app/clients/_components/group-multiselect.tsx`

**Interfaces:**
- Produces a client component:

```ts
export function GroupMultiselect(props: {
  sections: { label: string; options: string[] }[]; // e.g. 365 Distribution / 365 Security / 365 Groups / AD
  value: string[];
  onChange: (next: string[]) => void;
  emptyHint?: string; // shown when every section is empty (points to Refresh)
}): JSX.Element
```

Behavior (aesthetic detail owned by frontend-design in Task 7; this task delivers correct behavior with plain markup):
- A search input filters option rows across all sections (case-insensitive substring).
- Options render grouped under their section label; empty sections (after filtering) are hidden.
- Clicking an option toggles it in `value`; selected options are shown as removable chips above the list.
- A selected value that is not present in any section (e.g. a group deleted upstream) still renders as a removable chip so it is never silently dropped from `value`.
- Deduplicate option names within/across sections (first occurrence wins) so the same name isn't listed twice.

- [ ] **Step 1: Implement the component**

Create `web/app/clients/_components/group-multiselect.tsx`:

```tsx
"use client";
import { useMemo, useState } from "react";

export function GroupMultiselect({ sections, value, onChange, emptyHint }: {
  sections: { label: string; options: string[] }[];
  value: string[];
  onChange: (next: string[]) => void;
  emptyHint?: string;
}) {
  const [q, setQ] = useState("");
  const selected = new Set(value);

  // Dedupe option names across sections (first occurrence wins).
  const seen = new Set<string>();
  const cleanSections = sections.map((s) => ({
    label: s.label,
    options: s.options.filter((o) => o && !seen.has(o) && (seen.add(o), true)),
  }));

  const needle = q.trim().toLowerCase();
  const filtered = cleanSections
    .map((s) => ({ label: s.label, options: s.options.filter((o) => o.toLowerCase().includes(needle)) }))
    .filter((s) => s.options.length > 0);

  const allEmpty = cleanSections.every((s) => s.options.length === 0);

  const toggle = (name: string) => {
    const next = selected.has(name) ? value.filter((v) => v !== name) : [...value, name];
    onChange(next);
  };

  // Selected chips include any value not present in the option sections.
  const chips = useMemo(() => value, [value]);

  return (
    <div className="group-multiselect" style={{ minWidth: 240 }}>
      {chips.length > 0 && (
        <div className="gm-chips" style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {chips.map((c) => (
            <button key={c} type="button" className="gm-chip" onClick={() => toggle(c)} title="remove">
              {c} ×
            </button>
          ))}
        </div>
      )}
      <input
        className="gm-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search groups…"
        style={{ width: "100%", marginBottom: 6 }}
      />
      {allEmpty ? (
        <div className="note muted">{emptyHint ?? "No groups discovered yet."}</div>
      ) : (
        <div className="gm-list" style={{ maxHeight: 200, overflowY: "auto" }}>
          {filtered.length === 0 ? (
            <div className="note muted">No match.</div>
          ) : (
            filtered.map((s) => (
              <div key={s.label} className="gm-section">
                <div className="gm-section-label note muted" style={{ marginTop: 6 }}>{s.label}</div>
                {s.options.map((o) => (
                  <label key={o} className="gm-option" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
                    <span>{o}</span>
                  </label>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add web/app/clients/_components/group-multiselect.tsx
git commit -m "Add sectioned GroupMultiselect component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Rework `LocationTargetsEditor` (groups picker + printers box)

**Files:**
- Modify: `web/app/clients/_components/location-targets-editor.tsx`

**Interfaces:**
- Consumes: `GroupMultiselect` (Task 4), `TagList` from `./condition-builder`.
- New props signature:

```ts
export function LocationTargetsEditor(props: {
  slug: string;
  name: string;
  groups: string[];            // display split (groups-only)
  printers: string[];          // display split (printers-only)
  sections: { label: string; options: string[] }[]; // for the group picker
}): JSX.Element
```

- Persists via PATCH `/api/clients/{slug}` body `{ action: "set-location-targets", name, groups, printers }` on any change to either box.

- [ ] **Step 1: Rewrite the component**

Replace `web/app/clients/_components/location-targets-editor.tsx` with:

```tsx
"use client";
import { useState } from "react";
import { TagList } from "./condition-builder";
import { GroupMultiselect } from "./group-multiselect";

export function LocationTargetsEditor({ slug, name, groups, printers, sections }: {
  slug: string;
  name: string;
  groups: string[];
  printers: string[];
  sections: { label: string; options: string[] }[];
}) {
  const [g, setG] = useState<string[]>(groups);
  const [p, setP] = useState<string[]>(printers);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save(nextGroups: string[], nextPrinters: string[]) {
    setG(nextGroups);
    setP(nextPrinters);
    setErr(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-location-targets", name, groups: nextGroups, printers: nextPrinters }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error ?? "save failed"); return; }
      setSavedAt(Date.now());
    } catch {
      setErr("save failed");
    }
  }

  return (
    <div className="location-targets" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <div className="lt-groups" style={{ minWidth: 240 }}>
        <div className="note muted">Groups (AD / 365)</div>
        <GroupMultiselect
          sections={sections}
          value={g}
          onChange={(next) => save(next, p)}
          emptyHint="No groups discovered yet — refresh AD / cloud groups above."
        />
      </div>
      <div className="lt-printers" style={{ minWidth: 220 }}>
        <div className="note muted">Printers</div>
        <TagList items={p} onChange={(next) => save(g, next)} placeholder="printer name…" />
      </div>
      {err ? <div className="note" style={{ color: "#b3261e" }}>{err}</div>
        : savedAt ? <div className="note muted">saved</div> : null}
    </div>
  );
}
```

Note: `TagList` is passed NO `options` so printer names are free-form (no ⚠ validation) — this matches "allow someone to type printer names".

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: `LocationTargetsEditor` call sites will now error (old props) — those are fixed in Task 6. No errors from within this file.

- [ ] **Step 3: Commit** (after Task 6 makes it compile — or commit together with Task 6)

Defer commit to Task 6 so the tree typechecks; Tasks 5+6 ship as one compiling unit.

---

### Task 6: Double-line locations table + page wiring (sections, display split)

**Files:**
- Modify: `web/app/clients/_components/roles-rules-view.tsx` (props + Locations table)
- Modify: `web/app/clients/[slug]/page.tsx` (build sections + discovery data, pass down)

**Interfaces:**
- Consumes: `classifyLocationTargets` (Task 1), `LocationTargetsEditor` (Task 5).
- `RolesRulesView` props change: replace `groupOptions?: string[]` with:
  - `groupSections?: { label: string; options: string[] }[]`
  - `discoveredNames?: string[]` (for the per-location display split of un-migrated locations)

- [ ] **Step 1: Update `page.tsx` to build sections + discovered names**

In `web/app/clients/[slug]/page.tsx`, near the existing `knownGroups` / `cloudGroupList` derivations (~L132-145), add:

```tsx
// Sectioned group options for the location picker.
const groupSections = [
  { label: "365 Distribution", options: cloudGroupList.filter((g) => g.type === "dl").map((g) => g.name) },
  { label: "365 Security", options: cloudGroupList.filter((g) => g.type === "security").map((g) => g.name) },
  { label: "365 Groups", options: cloudGroupList.filter((g) => g.type === "m365").map((g) => g.name) },
  { label: "AD", options: adGroupNames },
];
const everyUserExtra = everyUserM365Groups.filter(
  (n) => !groupSections.some((s) => s.options.includes(n)),
);
if (everyUserExtra.length) groupSections.push({ label: "Configured (every user)", options: everyUserExtra });

// Flat set of discovered names for the display split of un-migrated locations.
const discoveredNames = [...new Set(knownGroups.map((g) => g.name))];
```

Then change the `RolesRulesView` render (~L442-448) from `groupOptions={[...new Set(knownGroups.map((g) => g.name))]}` to:

```tsx
<RolesRulesView
  personas={v21?.personas as never}
  globals={v21?.globals as never}
  locations={v21?.locations as never}
  slug={client.slug}
  groupSections={groupSections}
  discoveredNames={discoveredNames}
/>
```

- [ ] **Step 2: Update `RolesRulesView` props + Locations table (double-line)**

In `web/app/clients/_components/roles-rules-view.tsx`:

1. Update the props signature (L71-77):

```tsx
export function RolesRulesView({ personas, globals, locations, slug, groupSections = [], discoveredNames = [] }: {
  slug?: string;
  personas: Record<string, Persona> | null;
  globals: Record<string, Fragment> | null;
  locations: Record<string, Record<string, unknown>> | null;
  groupSections?: { label: string; options: string[] }[];
  discoveredNames?: string[];
}) {
```

2. Add the import at the top:

```tsx
import { classifyLocationTargets } from "@/lib/profiles/location-targets";
```

3. Replace the Locations `<thead>`/`<tbody>` (L136-146). The head drops the trailing "Groups (AD/Entra)" column (targets move to a second row). Each location renders TWO `<tr>`s: line 1 = the 7 address columns; line 2 = a full-width cell with the editor.

```tsx
<thead><tr>
  <th>Name</th><th>Address</th><th>City</th><th>State</th><th>Zip</th><th>Timezone</th><th>Country</th>
</tr></thead>
<tbody>
  {locNames.map((n) => {
    const l = locations![n] as {
      address?: string; city?: string; state?: string; zip?: string; timezone?: string;
      country?: { short?: string; name?: string }; groups?: string[]; printers?: string[];
    };
    const existingGroups = Array.isArray(l.groups) ? l.groups : [];
    // Persisted split if printers key exists; else lazy display split (never persisted here).
    const split = Array.isArray(l.printers)
      ? { groups: existingGroups, printers: l.printers }
      : classifyLocationTargets(existingGroups, discoveredNames);
    return (
      <>
        <tr key={n}>
          <td><b>{n}</b></td>
          <td>{l.address ?? "—"}</td>
          <td>{l.city ?? "—"}</td>
          <td>{l.state ?? "—"}</td>
          <td>{l.zip ?? "—"}</td>
          <td>{l.timezone ?? "—"}</td>
          <td>{l.country?.short ?? l.country?.name ?? "—"}</td>
        </tr>
        <tr key={n + "-targets"} className="location-targets-row">
          <td colSpan={7}>
            {slug ? (
              <LocationTargetsEditor slug={slug} name={n} groups={split.groups} printers={split.printers} sections={groupSections} />
            ) : (
              <span className="note muted">
                {split.groups.length || split.printers.length
                  ? [...split.groups, ...split.printers.map((p) => `🖨 ${p}`)].join(", ")
                  : "—"}
              </span>
            )}
          </td>
        </tr>
      </>
    );
  })}
</tbody>
```

Notes:
- React keys: the `<>` fragment can't take a key; instead give the two `<tr>`s their own keys (as above) and wrap with a keyed fragment if lint requires — if the `map` needs a single keyed root, use `<React.Fragment key={n}>` (import React) instead of `<>`.

- [ ] **Step 3: Typecheck the whole tree**

Run: `npx tsc --noEmit`
Expected: no errors. The old `groupOptions` prop is gone; the editor call site matches Task 5's new props.

- [ ] **Step 4: Commit Tasks 5 + 6 together**

```bash
git add web/app/clients/_components/location-targets-editor.tsx web/app/clients/_components/roles-rules-view.tsx web/app/clients/[slug]/page.tsx
git commit -m "Locations: double-line table, groups picker + separate printers box

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Visual polish pass (frontend-design) — locations section + client detail + /clients list

**Files:**
- Modify: `web/app/clients/_components/roles-rules-view.tsx` (Locations section styling)
- Modify: `web/app/clients/_components/group-multiselect.tsx`, `web/app/clients/_components/location-targets-editor.tsx` (picker/box styling)
- Modify: `web/app/clients/[slug]/page.tsx` (detail page layout polish)
- Modify: `web/app/clients/_components/clients-explorer.tsx`, `web/app/clients/_components/clients-table.tsx` (list page polish)
- Modify: shared CSS (locate the stylesheet these pages use — search for existing class names like `note`, `muted` to find it; e.g. `web/app/globals.css` or a co-located module).

**REQUIRED SUB-SKILL:** Invoke `frontend-design:frontend-design` for this task. It owns the visual design. Constraints from CLAUDE.md: flat, minimal borders, sentence case, no gradients; keep it consistent with the existing host design system already used across the app (reuse existing utility classes like `note`/`muted` rather than inventing a new visual language).

- [ ] **Step 1: Invoke frontend-design and polish the Locations section**
  - The double-line locations table: make the second (targets) row read as a clear sub-panel of its location — indentation/background, the two labeled boxes ("Groups (AD / 365)" and "Printers") side by side and wrapping cleanly on narrow widths.
  - Style `GroupMultiselect`: chips, section headers, search field, scroll area — consistent, flat, accessible (light/dark if the app supports it).
  - Add discovery staleness + refresh affordances near the picker if not already present on the page (the page already renders AD/cloud-group refresh controls; ensure the tech can see "when were groups last discovered" and refresh without leaving the section).

- [ ] **Step 2: Polish the client detail page ([slug])**
  - Tighten section rhythm, headings (sentence case), spacing, and the surrounding "Roles & rules" area so the new locations block sits well.

- [ ] **Step 3: Polish the /clients list page**
  - Density, header, search/filter affordances, status chips — a clean, flat pass consistent with the rest of the app. No behavior changes.

- [ ] **Step 4: Verify visually (see Task 8's run step) and commit**

```bash
git add web/app/clients
git commit -m "Polish clients list + detail + locations targets UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Verify end-to-end, changelog, ship

**Files:**
- Modify: `web/lib/changelog/entries.ts` (append entry)

- [ ] **Step 1: Full test + typecheck**

Run (from `web/`): `npm test && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 2: Run the app and drive the flow** (use the `run` / `verify` skill and the "Web dev verify recipe" memory: worktree dev server + minted DB session + `site_v2` cookie)
  - Open a client detail page with locations. Confirm the double-line table renders, the groups picker shows sectioned discovered groups, selecting adds a chip and persists, and typing a printer persists to the printers box.
  - Confirm an un-migrated location shows a sensible auto-classified split and that saving it persists `printers`.
  - Plan an onboard case for a hire matching a location that has printers; confirm the case shows a "Printers" manual checklist item with the note "Map printers at <name>: …" and a working "✓ mark complete" button; confirm groups still landed on the directory job config.
  - Screenshot the polished `/clients` list and detail page.

- [ ] **Step 3: Append changelog entry**

Get the Eastern time: `TZ=America/New_York date +%H:%M`. Append a new entry object to `web/lib/changelog/entries.ts` (match the existing entry shape in that file) describing: sectioned AD/365 groups picker + separate printers box on client locations; printers now a manual checklist step; clients list/detail visual polish.

- [ ] **Step 4: Final commit**

```bash
git add web/lib/changelog/entries.ts
git commit -m "Changelog: location groups picker + printers box + clients polish

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push branch + open draft PR**

```bash
git push -u origin HEAD
gh pr create --draft --title "Location groups picker + printers box + clients page polish" --body "$(cat <<'EOF'
## Summary
- Location targets split into a sectioned AD/365 **groups** multi-select (365 Distribution / 365 Security / 365 Groups / AD, from existing discovery) and a separate free-text **printers** box.
- Existing mixed entries auto-classify for display (guarded against empty discovery); the split persists on save.
- Printers become one `mode:"manual"` checklist step per matched location at plan time (systemKey `printers`, injected in `resolvePlannedConfigs` so create + re-plan agree); groups keep unioning into directory jobs.
- Double-line locations table; full visual polish on `/clients` list + client detail page.

## Test plan
- `npm test` (new helpers + plan-resolve printer-step tests) and `npx tsc --noEmit` green.
- Drove the flow in the dev app: picker/printers persist; onboard case shows the printers manual checklist item with note; groups still land on the directory job.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Data model (`printers[]`, no migration, lazy auto-classify, empty-discovery guard) → Task 1 (`classifyLocationTargets`) + Task 6 (display split) + Task 3 (persist).
- Sectioned groups picker (365 DL/Security/M365/AD) → Task 4 + Task 6 (sections built in page.tsx).
- Printers free-text box → Task 5 (TagList, no options).
- Printers = manual checklist step (not group union) → Task 2 (safe injection, refined to persisted-split-only; documented deviation).
- Double-line table → Task 6.
- Full visual polish (list + detail) → Task 7.
- Refresh/staleness affordances → Task 7 (reuses existing discovery endpoints/UI).
- Optional AD `GroupCategory` follow-on → intentionally out of scope (spec flagged it as non-blocking); not a task.
- Testing → Tasks 1, 2 (lib TDD); UI verified live in Task 8 (repo has no component-test convention).

**Deviation from spec (intentional, safety):** plan-resolve reads only the *persisted* `location.printers` split rather than re-classifying at plan time. Rationale documented in Task 2 — avoids demoting a real-but-undiscovered group to a printer during onboarding. Migration still happens: the UI shows the auto-classified split immediately and persists it on first save.

**Placeholder scan:** lib tasks contain full code; UI tasks contain full behavioral code (Tasks 4-6) with only aesthetics deferred to frontend-design (Task 7), which is the correct owner. No TBD/TODO.

**Type consistency:** `classifyLocationTargets`/`applyLocationTargets` signatures identical across Tasks 1/3/6. `GroupMultiselect` props identical across Tasks 4/5. `LocationTargetsEditor` new props identical across Tasks 5/6. `RolesRulesView` `groupSections`/`discoveredNames` identical across Tasks 6. `PlannedJob` shape for the printers job matches `web/lib/orchestrator.ts:13-25`.
