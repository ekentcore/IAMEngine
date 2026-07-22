# Guided Setup Wizard + Delinea Suggestions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the in-app guided credential setup into a step-by-step automation wizard, and add a reusable "Suggest from Delinea" component that ranks a client's existing secrets for whatever credential the operator must supply.

**Architecture:** All frontend + one read-only API route + a small runner progress-emit. A pure ranking module scores existing folder secrets; a read-only route serves ranked suggestions; a reusable React component surfaces them anywhere a secret reference is entered; the `GuidedApiSetup` modal becomes a catalog-driven linear stepper; the vendor browser flows emit coarse stages the wizard mirrors.

**Tech Stack:** Next.js (App Router, TS) + React; tests are `node:test` + `node:assert` run with `cd web && npx tsx --test <file>`; runner flows are Node ESM (`.mjs`). Static gate: `npx tsc --noEmit`. Do NOT run `next lint`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-guided-setup-wizard-and-delinea-suggestions-design.md`. Implements it in full (v1 scope; phase-2 inline-OTP is out).
- Delinea suggestions expose **names/notes/metadata only — never a secret value**. Consistent with the metadata-only `/summary` read path in `web/lib/secrets/delinea.ts`.
- All new routes gate on `client.edit_secrets` + client scope (out-of-scope client reads as 404), mirroring `web/app/api/clients/[slug]/secrets/create/route.ts`.
- Ranking must be a PURE function (no fetch/db) so it is unit-tested without I/O; the route composes it with the Delinea search primitives.
- Reuse existing primitives, do not duplicate: `listFolderSecrets`, `listAllFolders` (`web/lib/secrets/delinea-search.ts`), `deriveClientFolderId` + `FolderDerivation` (`web/lib/secrets/delinea.ts`), `defaultTemplateName` (`web/lib/secrets/delinea-templates.ts`), `checkSecret`/`getDelineaToken` (`web/lib/secrets/delinea.ts`).
- `SecretSearchRecord = { id: number; name: string; folderPath: string; secretTemplateId?: number; secretTemplateName?: string }`.
- The Automatic flow is already catalog-driven: `ApiSetupEntry` has `autoBrowser`, `autoCreateEndpoint`, `autoConsoleSecret`; `GuidedApiSetup` POSTs `/api/clients/${slug}/${entry.autoCreateEndpoint}` and polls its GET which returns `{ done:false, status }` while running and `{ done:true, ok, externalId }` (or `{done:true, ok:false, error}`) when terminal.
- Changelog convention: append one file per entry under `web/lib/changelog/entries/` + register in `_registry.ts`; `time` from `TZ=America/New_York date +%H:%M` on a 15-minute boundary.
- Runner change ⇒ bump `runner/VERSION` (minor). Current on `main`: `1.86.0` → target `1.87.0`.
- No DB migration (`ModuleSetupCredential` already exists from P0a / #185).

---

### Task 1: Suggestion aliases + pure ranking module

**Files:**
- Create: `web/lib/secrets/delinea-suggestions.ts`
- Test: `web/lib/secrets/delinea-suggestions.test.ts`

**Interfaces:**
- Consumes: `SecretSearchRecord` (from `./delinea-search`), `defaultTemplateName` (from `./delinea-templates`).
- Produces:
  - `SUGGESTION_ALIASES: Record<string, string[]>` — vendor keyword aliases per secret name.
  - `type SuggestionTarget = { secretName: string; templateName: string | null; subfolders: string[] }`.
  - `type RankedSuggestion = { secretId: number; name: string; folderPath: string; folderId: number | null; template?: string; score: number; reasons: string[] }`.
  - `rankDelineaSuggestions(candidates: SecretSearchRecord[], target: SuggestionTarget): RankedSuggestion[]` — pure; scores, filters score>0, sorts desc, caps at 25. `folderId` is the last numeric segment of `folderPath` when present else null.

- [ ] **Step 1: Write the failing test**

```ts
// web/lib/secrets/delinea-suggestions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SecretSearchRecord } from "./delinea-search";
import { rankDelineaSuggestions, SUGGESTION_ALIASES } from "./delinea-suggestions";

const rec = (o: Partial<SecretSearchRecord> & { id: number; name: string }): SecretSearchRecord => ({
  folderPath: "", secretTemplateName: undefined, secretTemplateId: undefined, ...o,
});
const target = { secretName: "adobe", templateName: "Automation - API", subfolders: ["Vendor", "Identity Services"] };

test("aliases exist for the guided vendors", () => {
  for (const k of ["adobe", "zoom", "mimecast", "egnyte", "knowbe4", "slack", "spanning"]) {
    assert.ok(SUGGESTION_ALIASES[k]?.length, `${k} needs aliases`);
  }
});

test("template match, name match, and folder match each contribute, with reasons", () => {
  const cands = [
    rec({ id: 1, name: "Adobe Admin Console (auto)", folderPath: "\\Clients\\Acme !CORE1!\\Vendor", secretTemplateName: "Automation - API" }),
    rec({ id: 2, name: "random note", folderPath: "\\Clients\\Acme !CORE1!\\Networking", secretTemplateName: "Active Directory Account" }),
    rec({ id: 3, name: "UMAPI service", folderPath: "\\Clients\\Acme !CORE1!\\Identity Services", secretTemplateName: "Automation - API" }),
  ];
  const out = rankDelineaSuggestions(cands, target);
  // #1 wins: template + name(adobe) + Vendor folder. #3 next: template + name(umapi) + Identity Services. #2 filtered (score 0).
  assert.deepEqual(out.map((s) => s.secretId), [1, 3]);
  assert.ok(out[0].score > out[1].score);
  assert.ok(out[0].reasons.some((r) => /template/i.test(r)));
  assert.ok(out[0].reasons.some((r) => /adobe/i.test(r)));
  assert.ok(out[0].reasons.some((r) => /Vendor/i.test(r)));
});

test("folderId is the numeric last segment of a Secret Server folderPath, else null", () => {
  // Secret Server folderPath is name-based ("\\Clients\\..\\Vendor"), so folderId is null unless numeric.
  const out = rankDelineaSuggestions([rec({ id: 9, name: "adobe key", folderPath: "\\Clients\\Acme\\Vendor", secretTemplateName: "Automation - API" })], target);
  assert.equal(out[0].folderId, null);
});

test("caps at 25 results", () => {
  const many = Array.from({ length: 40 }, (_, i) => rec({ id: i + 1, name: `adobe ${i}`, secretTemplateName: "Automation - API" }));
  assert.equal(rankDelineaSuggestions(many, target).length, 25);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx tsx --test lib/secrets/delinea-suggestions.test.ts`
Expected: FAIL — `Cannot find module './delinea-suggestions'`.

- [ ] **Step 3: Write the module**

```ts
// web/lib/secrets/delinea-suggestions.ts
import type { SecretSearchRecord } from "./delinea-search";

// Keyword aliases per target secret name — a candidate whose NAME contains any alias is a name match.
// Includes the vendor word(s) + the console-login variant so the same map serves API creds and logins.
export const SUGGESTION_ALIASES: Record<string, string[]> = {
  adobe: ["adobe", "umapi"],
  "adobe-console": ["adobe"],
  zoom: ["zoom"],
  "zoom-console": ["zoom"],
  mimecast: ["mimecast"],
  "mimecast-console": ["mimecast"],
  egnyte: ["egnyte"],
  "egnyte-console": ["egnyte"],
  knowbe4: ["knowbe4", "know be4", "kb4"],
  "knowbe4-console": ["knowbe4", "kb4"],
  slack: ["slack", "scim"],
  "slack-console": ["slack"],
  spanning: ["spanning", "backup"],
  "spanning-portal": ["spanning"],
  proofpoint: ["proofpoint"],
  "m365-admin": ["m365", "azure", "entra", "graph", "global admin", "365"],
  "google-admin": ["google", "workspace", "gws"],
};

export type SuggestionTarget = { secretName: string; templateName: string | null; subfolders: string[] };
export type RankedSuggestion = {
  secretId: number; name: string; folderPath: string; folderId: number | null;
  template?: string; score: number; reasons: string[];
};

const norm = (s: string) => s.toLowerCase();
const lastSegment = (folderPath: string) => folderPath.split("\\").filter(Boolean).pop() ?? "";

export function rankDelineaSuggestions(candidates: SecretSearchRecord[], target: SuggestionTarget): RankedSuggestion[] {
  const aliases = SUGGESTION_ALIASES[target.secretName] ?? [target.secretName.replace(/-/g, " ")];
  const wantSub = target.subfolders.map(norm);
  const out: RankedSuggestion[] = [];
  for (const c of candidates) {
    let score = 0;
    const reasons: string[] = [];
    if (target.templateName && c.secretTemplateName && norm(c.secretTemplateName) === norm(target.templateName)) {
      score += 3; reasons.push(`template: ${c.secretTemplateName}`);
    }
    const nm = norm(c.name);
    const hit = aliases.find((a) => nm.includes(norm(a)));
    if (hit) { score += 2; reasons.push(`name matches '${hit}'`); }
    const leaf = norm(lastSegment(c.folderPath));
    const sub = wantSub.find((s) => leaf === s);
    if (sub) { score += 1; reasons.push(`in ${lastSegment(c.folderPath)} subfolder`); }
    if (score <= 0) continue;
    const fidRaw = lastSegment(c.folderPath);
    out.push({
      secretId: c.id, name: c.name, folderPath: c.folderPath,
      folderId: /^\d+$/.test(fidRaw) ? Number(fidRaw) : null,
      template: c.secretTemplateName, score, reasons,
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, 25);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx tsx --test lib/secrets/delinea-suggestions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/lib/secrets/delinea-suggestions.ts web/lib/secrets/delinea-suggestions.test.ts
git commit -m "feat(secrets): pure Delinea suggestion ranking + vendor aliases"
```

---

### Task 2: Suggestions API route (compose ranking with Delinea search)

**Files:**
- Create: `web/app/api/clients/[slug]/delinea-suggestions/route.ts`
- Create: `web/lib/secrets/build-suggestions.ts` (the testable composition helper)
- Test: `web/lib/secrets/build-suggestions.test.ts`

**Interfaces:**
- Consumes: `rankDelineaSuggestions`, `SuggestionTarget` (Task 1); `listFolderSecrets` (`./delinea-search`); `defaultTemplateName` (`./delinea-templates`).
- Produces:
  - `buildSuggestions(deps, args): Promise<{ folderResolved: boolean; suggestions: RankedSuggestionWithNote[] }>` where
    `deps = { listSecrets: (folderId:number)=>Promise<SecretSearchRecord[]>; fetchNote: (secretId:number)=>Promise<string|undefined> }`,
    `args = { clientFolderId: string | null; secretName: string; subfolders: string[]; noteTopN: number }`.
    `RankedSuggestionWithNote = RankedSuggestion & { note?: string }`. Fetches notes only for the first `noteTopN`.
  - Route `GET /api/clients/:slug/delinea-suggestions?secret=<name>` → JSON `{ folderResolved, suggestions }`.

- [ ] **Step 1: Write the failing test for `buildSuggestions`**

```ts
// web/lib/secrets/build-suggestions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSuggestions } from "./build-suggestions";
import type { SecretSearchRecord } from "./delinea-search";

const secrets: SecretSearchRecord[] = [
  { id: 1, name: "Adobe Admin (auto)", folderPath: "\\C\\Vendor", secretTemplateName: "Automation - API" },
  { id: 2, name: "Adobe old", folderPath: "\\C\\Vendor", secretTemplateName: "Automation - API" },
  { id: 3, name: "unrelated", folderPath: "\\C\\Networking", secretTemplateName: "Active Directory Account" },
];

test("no client folder -> folderResolved false, no fetches", async () => {
  let listed = false;
  const r = await buildSuggestions({ listSecrets: async () => { listed = true; return []; }, fetchNote: async () => "x" },
    { clientFolderId: null, secretName: "adobe", subfolders: ["Vendor"], noteTopN: 5 });
  assert.equal(r.folderResolved, false);
  assert.deepEqual(r.suggestions, []);
  assert.equal(listed, false);
});

test("ranks, and fetches notes only for the top N", async () => {
  const noteCalls: number[] = [];
  const r = await buildSuggestions(
    { listSecrets: async () => secrets, fetchNote: async (id) => { noteCalls.push(id); return `note-${id}`; } },
    { clientFolderId: "500", secretName: "adobe", subfolders: ["Vendor"], noteTopN: 1 });
  assert.equal(r.folderResolved, true);
  assert.equal(r.suggestions.length, 2);            // #3 filtered (score 0)
  assert.equal(r.suggestions[0].note, "note-1");     // top-1 got a note
  assert.equal(r.suggestions[1].note, undefined);    // beyond N: no note
  assert.deepEqual(noteCalls, [r.suggestions[0].secretId]);
});

test("a failing note fetch is swallowed (suggestion kept, note omitted)", async () => {
  const r = await buildSuggestions(
    { listSecrets: async () => secrets, fetchNote: async () => { throw new Error("boom"); } },
    { clientFolderId: "500", secretName: "adobe", subfolders: ["Vendor"], noteTopN: 5 });
  assert.equal(r.suggestions.length, 2);
  assert.equal(r.suggestions[0].note, undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx tsx --test lib/secrets/build-suggestions.test.ts`
Expected: FAIL — `Cannot find module './build-suggestions'`.

- [ ] **Step 3: Implement `build-suggestions.ts`**

```ts
// web/lib/secrets/build-suggestions.ts
import type { SecretSearchRecord } from "./delinea-search";
import { rankDelineaSuggestions, type RankedSuggestion } from "./delinea-suggestions";
import { defaultTemplateName } from "./delinea-templates";

export type RankedSuggestionWithNote = RankedSuggestion & { note?: string };

export type BuildSuggestionsDeps = {
  listSecrets: (folderId: number) => Promise<SecretSearchRecord[]>;
  fetchNote: (secretId: number) => Promise<string | undefined>;
};
export type BuildSuggestionsArgs = {
  clientFolderId: string | null;
  secretName: string;
  subfolders: string[];
  noteTopN: number;
};

export async function buildSuggestions(
  deps: BuildSuggestionsDeps,
  args: BuildSuggestionsArgs
): Promise<{ folderResolved: boolean; suggestions: RankedSuggestionWithNote[] }> {
  if (!args.clientFolderId) return { folderResolved: false, suggestions: [] };
  const candidates = await deps.listSecrets(Number(args.clientFolderId));
  const ranked = rankDelineaSuggestions(candidates, {
    secretName: args.secretName,
    templateName: defaultTemplateName(args.secretName),
    subfolders: args.subfolders,
  });
  const withNotes: RankedSuggestionWithNote[] = [];
  for (let i = 0; i < ranked.length; i++) {
    let note: string | undefined;
    if (i < args.noteTopN) {
      try { note = await deps.fetchNote(ranked[i].secretId); } catch { note = undefined; }
    }
    withNotes.push({ ...ranked[i], note });
  }
  return { folderResolved: true, suggestions: withNotes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx tsx --test lib/secrets/build-suggestions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the route (wires real Delinea search + a note fetcher)**

```ts
// web/app/api/clients/[slug]/delinea-suggestions/route.ts
// GET /api/clients/:slug/delinea-suggestions?secret=<name> — ranked existing-secret suggestions from
// the client's own Delinea folder tree (names/notes/metadata only, never values). Gated read.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { currentClientScope, scopeAllows } from "@/lib/auth/client-scope";
import { delineaConfigFromEnv, delineaConfigured, getDelineaToken, deriveClientFolderId } from "@/lib/secrets/delinea";
import { listFolderSecrets } from "@/lib/secrets/delinea-search";
import { buildSuggestions } from "@/lib/secrets/build-suggestions";
import { identitySubfolderName } from "@/lib/secrets/delinea-templates";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const g = await guard("client.edit_secrets"); if (g.res) return g.res;
  const secret = new URL(req.url).searchParams.get("secret")?.trim();
  if (!secret) return NextResponse.json({ error: "secret query param required" }, { status: 422 });

  const scope = await currentClientScope(db);
  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true, delineaFolderId: true } });
  if (!client || !scopeAllows(scope, client.id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cfg = delineaConfigFromEnv();
  if (!delineaConfigured(cfg)) return NextResponse.json({ folderResolved: false, suggestions: [], reason: "Delinea not configured" });

  let token: string;
  try { token = await getDelineaToken(cfg); }
  catch (e) { return NextResponse.json({ folderResolved: false, suggestions: [], reason: `Delinea auth failed — ${(e as Error).message}` }, { status: 502 }); }

  // Client folder: stored id, else best-effort derivation from the client's slug/name.
  let folderId: string | null = client.delineaFolderId ?? null;
  if (!folderId) {
    const d = await deriveClientFolderId(cfg, { slug: params.slug }, token).catch(() => null);
    folderId = d?.folderId ?? null;
  }

  const result = await buildSuggestions(
    {
      listSecrets: (fid) => listFolderSecrets(cfg, fid, token),
      fetchNote: async (id) => {
        const res = await fetch(`${cfg.baseUrl}/api/v1/secrets/${id}/summary`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return undefined;
        const b = (await res.json().catch(() => null)) as { notes?: string; secretNote?: string } | null;
        const n = (b?.notes ?? b?.secretNote ?? "").trim();
        return n || undefined;
      },
    },
    { clientFolderId: folderId, secretName: secret, subfolders: [identitySubfolderName(), "Vendor"], noteTopN: 5 }
  );
  return NextResponse.json(result);
}
```

> NOTE for the implementer: confirm `deriveClientFolderId`'s exact argument shape in `web/lib/secrets/delinea.ts:292` and adapt the call (it may take `{ slug, clientFolderId, gaSecretRef }`). If its signature differs, pass what it needs; the only requirement is "return a folder id or null". Confirm the `/summary` note field name against a real secret (`notes` vs `secretNote`) — the fallback already tolerates both.

- [ ] **Step 6: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 7: Commit**

```bash
git add web/lib/secrets/build-suggestions.ts web/lib/secrets/build-suggestions.test.ts "web/app/api/clients/[slug]/delinea-suggestions/route.ts"
git commit -m "feat(secrets): delinea-suggestions route + testable composition helper"
```

---

### Task 3: Reusable `DelineaSuggestions` component

**Files:**
- Create: `web/app/clients/_components/delinea-suggestions.tsx`

**Interfaces:**
- Produces: `<DelineaSuggestions slug={string} secretName={string} onPick={(externalId: string) => void} />`.
  Renders a "🔎 Suggest from Delinea" button; on click, `GET`s the Task-2 route, shows a panel of ranked rows (name, folder path + id, template, note when present, and `reasons[]` as chips), a "browse all N" expander, and calls `onPick(secretId)` when a row is chosen. Loading + empty (`folderResolved:false`) + error states inline. Purely additive; the caller still supports manual entry.

- [ ] **Step 1: Implement the component**

```tsx
// web/app/clients/_components/delinea-suggestions.tsx
"use client";
import { useState } from "react";

type Suggestion = {
  secretId: number; name: string; folderPath: string; folderId: number | null;
  template?: string; note?: string; score: number; reasons: string[];
};

export function DelineaSuggestions({ slug, secretName, onPick }: { slug: string; secretName: string; onPick: (externalId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [folderResolved, setFolderResolved] = useState(true);
  const [showAll, setShowAll] = useState(false);

  async function load() {
    setOpen(true); setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/delinea-suggestions?secret=${encodeURIComponent(secretName)}`);
      const d = await r.json();
      if (!r.ok) { setError(d?.error ?? `failed (${r.status})`); return; }
      setFolderResolved(d.folderResolved !== false);
      setItems(d.suggestions ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const shown = items ? (showAll ? items : items.slice(0, 5)) : [];
  return (
    <div style={{ marginTop: 4 }}>
      <button type="button" className="note" onClick={() => (open ? setOpen(false) : load())}>
        {open ? "Hide suggestions" : "🔎 Suggest from Delinea"}
      </button>
      {open && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, marginTop: 4 }}>
          {busy && <p className="note"><span className="spinner" /> Searching this client's Delinea folders…</p>}
          {error && <p className="note danger">{error}</p>}
          {!busy && !error && !folderResolved && <p className="note">No Delinea folder is known for this client yet — enter the id by hand, or set the client's folder.</p>}
          {!busy && !error && folderResolved && items?.length === 0 && <p className="note">No matching secrets found in this client's folders.</p>}
          {shown.map((s) => (
            <div key={s.secretId} style={{ borderTop: "1px solid #f0f0f0", padding: "6px 0" }}>
              <div className="row-between">
                <b style={{ fontSize: 13 }}>{s.name}</b>
                <button type="button" className="primary" onClick={() => { onPick(String(s.secretId)); setOpen(false); }}>Use #{s.secretId}</button>
              </div>
              <div className="note" style={{ fontSize: 12 }}>
                <code style={{ fontSize: 11 }}>{s.folderPath}</code>{s.folderId ? ` (folder ${s.folderId})` : ""}{s.template ? ` · ${s.template}` : ""}
              </div>
              {s.note && <div className="note" style={{ fontSize: 12, fontStyle: "italic" }}>note: {s.note}</div>}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                {s.reasons.map((r, i) => <span key={i} className="badge" style={{ fontSize: 10 }}>{r}</span>)}
              </div>
            </div>
          ))}
          {items && items.length > 5 && !showAll && (
            <button type="button" className="note" onClick={() => setShowAll(true)} style={{ marginTop: 6 }}>browse all {items.length} in this client's folders</button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "web/app/clients/_components/delinea-suggestions.tsx"
git commit -m "feat(clients): reusable DelineaSuggestions button+panel"
```

---

### Task 4: Coarse stage progress (runner emits stage; create-api GET surfaces it)

**Files:**
- Create: `web/lib/secrets/setup-stage.ts` + `web/lib/secrets/setup-stage.test.ts` (pure stage→step mapping)
- Modify: `runner/browser/run-flow.mjs` (emit a `stage:<name>` progress line the job records) — follow the existing stage-logging in each `*-console-setup.mjs` flow
- Modify: each `web/app/api/clients/[slug]/<vendor>-setup/create-api/route.ts` + `web/app/api/clients/[slug]/mimecast-console/create-api-app/route.ts` GET to include `stage` from `job.progress`
- Modify: `runner/VERSION` → `1.87.0`

**Interfaces:**
- Produces: `SETUP_STAGES = ["signin","create","harvest","vault","done"] as const`; `stageIndex(stage: string | null | undefined): number` (−1 when unknown/absent); the create-api GET adds `stage?: string` to its running response (`{ done:false, status, stage }`).

- [ ] **Step 1: Failing test for the pure mapping**

```ts
// web/lib/secrets/setup-stage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SETUP_STAGES, stageIndex } from "./setup-stage";

test("known stages map to their order; unknown/absent -> -1", () => {
  assert.deepEqual([...SETUP_STAGES], ["signin", "create", "harvest", "vault", "done"]);
  assert.equal(stageIndex("harvest"), 2);
  assert.equal(stageIndex("SIGNIN"), 0);   // case-insensitive
  assert.equal(stageIndex(undefined), -1);
  assert.equal(stageIndex("nonsense"), -1);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd web && npx tsx --test lib/secrets/setup-stage.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement the mapping**

```ts
// web/lib/secrets/setup-stage.ts
export const SETUP_STAGES = ["signin", "create", "harvest", "vault", "done"] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];
export function stageIndex(stage: string | null | undefined): number {
  if (!stage) return -1;
  return (SETUP_STAGES as readonly string[]).indexOf(stage.toLowerCase());
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd web && npx tsx --test lib/secrets/setup-stage.test.ts` — PASS.

- [ ] **Step 5: Emit stage from the runner flows**

In `runner/browser/run-flow.mjs`, where each vendor flow already logs its stage progression, also write a coarse stage marker to the job's progress channel using the SAME `SETUP_STAGES` vocabulary (`signin` → `create` → `harvest` → `vault`). Use the existing progress-post mechanism the runner uses for other jobs (search `runner/Start-IamRunner.ps1` / `run-flow.mjs` for how a browser job reports `progress`); emit `{ stage: "<name>" }`. If a flow currently has no progress hook, add a single `reportStage(name)` call at each of the four boundaries in that flow. Keep it best-effort — a failed progress post must never fail the run.

- [ ] **Step 6: Surface `stage` in every create-api GET**

In each `<vendor>-setup/create-api/route.ts` and `mimecast-console/create-api-app/route.ts`, in the non-terminal branch, read the job's progress stage and include it:

```ts
// replace: if (!TERMINAL.has(job.status)) return NextResponse.json({ done: false, status: job.status });
const stage = (job.progress as { stage?: string } | null)?.stage;
if (!TERMINAL.has(job.status)) return NextResponse.json({ done: false, status: job.status, stage });
```

Ensure the `job` select includes `progress: true`.

- [ ] **Step 7: Bump runner version + verify**

```bash
printf '1.87.0' > runner/VERSION
cd web && npx tsc --noEmit && npx tsx --test lib/secrets/setup-stage.test.ts
```
Expected: tsc clean; test PASS.

- [ ] **Step 8: Commit**

```bash
git add web/lib/secrets/setup-stage.ts web/lib/secrets/setup-stage.test.ts runner/browser/run-flow.mjs "web/app/api/clients/[slug]" runner/VERSION
git commit -m "feat(setup): coarse browser-setup stage progress (runner emit + create-api GET surface)"
```

---

### Task 5: Rework `GuidedApiSetup` into the step-by-step wizard

**Files:**
- Create: `web/lib/secrets/wizard-steps.ts` + `web/lib/secrets/wizard-steps.test.ts` (pure step derivation)
- Modify: `web/app/clients/_components/guided-api-setup.tsx`

**Interfaces:**
- Consumes: `ApiSetupEntry` (`@/lib/secrets/api-setup-catalog`), `SETUP_STAGES`/`stageIndex` (Task 4), `DelineaSuggestions` (Task 3).
- Produces (pure, testable): `type SetupSource = "auto" | "paste" | "existing"`; `wizardStepIds(entry: ApiSetupEntry, source: SetupSource): string[]` returning the ordered step ids for that vendor+source (e.g. auto → `["overview","prep","login","run","done"]`; paste/existing on a non-auto vendor → `["overview","fields","done"]`).

- [ ] **Step 1: Failing test for `wizardStepIds`**

```ts
// web/lib/secrets/wizard-steps.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { wizardStepIds } from "./wizard-steps";
import type { ApiSetupEntry } from "./api-setup-catalog";

const auto = { systemKey: "adobe", secretName: "adobe", label: "Adobe", consoleUrl: "https://x", steps: ["a"], autoBrowser: "adobe-console-setup", autoCreateEndpoint: "adobe-setup/create-api", autoConsoleSecret: "adobe-console" } as ApiSetupEntry;
const manual = { systemKey: "proofpoint", secretName: "proofpoint", label: "Proofpoint", consoleUrl: "https://x", steps: ["a"] } as ApiSetupEntry;

test("automatic vendor + auto source -> full run wizard", () => {
  assert.deepEqual(wizardStepIds(auto, "auto"), ["overview", "prep", "login", "run", "done"]);
});
test("paste/existing source -> field steps, no run", () => {
  assert.deepEqual(wizardStepIds(auto, "paste"), ["overview", "fields", "done"]);
  assert.deepEqual(wizardStepIds(auto, "existing"), ["overview", "existing", "done"]);
});
test("non-automatic vendor never offers the run step", () => {
  assert.deepEqual(wizardStepIds(manual, "auto"), ["overview", "fields", "done"]); // falls back to paste
});
```

- [ ] **Step 2: Run to verify fail** — `cd web && npx tsx --test lib/secrets/wizard-steps.test.ts` — FAIL.

- [ ] **Step 3: Implement `wizard-steps.ts`**

```ts
// web/lib/secrets/wizard-steps.ts
import type { ApiSetupEntry } from "./api-setup-catalog";
export type SetupSource = "auto" | "paste" | "existing";
export function wizardStepIds(entry: ApiSetupEntry, source: SetupSource): string[] {
  const canAuto = Boolean(entry.autoCreateEndpoint);
  if (source === "auto" && canAuto) return ["overview", "prep", "login", "run", "done"];
  if (source === "existing") return ["overview", "existing", "done"];
  return ["overview", "fields", "done"]; // paste, or auto requested on a non-automatic vendor
}
```

- [ ] **Step 4: Run to verify pass** — `cd web && npx tsx --test lib/secrets/wizard-steps.test.ts` — PASS.

- [ ] **Step 5: Rework the modal into the stepper**

Rework `web/app/clients/_components/guided-api-setup.tsx` so its body is a linear stepper driven by `wizardStepIds(entry, source)` and a `stepIndex` state. Preserve ALL existing behavior (the `createApiApp()` POST/poll, paste `values`/region/service, existing-id test-then-wire) — only reorganize it into steps and add the new pieces:

- **overview:** vendor label, the target Delinea "Vendor" subfolder note, and a 3-way `source` selector (Automatic / Paste / Use existing). Selecting changes `source`.
- **prep:** render `entry.steps[]` as a numbered checklist (read-only). Only in the `auto` path.
- **login:** show the `entry.autoConsoleSecret` requirement; render `<DelineaSuggestions slug={slug} secretName={entry.autoConsoleSecret!} onPick={(id) => setConsoleSecretRef(id)} />` beside the existing console-secret input.
- **fields** (paste): the existing per-field inputs; add `<DelineaSuggestions slug={slug} secretName={entry.secretName} onPick={(id) => { setMode("existing"); setExternalId(id); }} />` so a suggestion can jump to the existing-id path.
- **existing:** the existing-id input + test-then-wire; add `<DelineaSuggestions slug={slug} secretName={entry.secretName} onPick={setExternalId} />`.
- **run:** trigger `createApiApp()`; render `entry.steps[]` (or the `SETUP_STAGES` labels) as a checklist and mark items complete using `stageIndex(pollStage)` from the GET poll's `stage` field. On terminal, advance to **done**.
- **done:** show the vaulted `externalId` + a "Test connection" affordance (reuse whatever the current modal shows on success).

Footer: Back / Next buttons gated by `stepIndex`; Next on the last pre-terminal step triggers the step's action (run) where applicable. Delete the old tab-bar `mode` UI (its states fold into `source`).

- [ ] **Step 6: Typecheck + manual smoke**

Run: `cd web && npx tsc --noEmit` (clean). Then smoke via the web dev recipe (worktree dev server + minted session + `site_v2` cookie — see memory "Web dev verify recipe"): open a client's setup, confirm the wizard renders per source, the Suggest button lists ranked secrets, and the automatic run advances the checklist.

- [ ] **Step 7: Commit**

```bash
git add web/lib/secrets/wizard-steps.ts web/lib/secrets/wizard-steps.test.ts "web/app/clients/_components/guided-api-setup.tsx"
git commit -m "feat(clients): step-by-step guided-setup wizard with Delinea suggestions + live stage progress"
```

---

### Task 6: Changelog + full verification

**Files:**
- Create: `web/lib/changelog/entries/guided-setup-wizard-and-suggestions.ts`
- Modify: `web/lib/changelog/entries/_registry.ts`

- [ ] **Step 1: Add the changelog entry**

```ts
// web/lib/changelog/entries/guided-setup-wizard-and-suggestions.ts
import type { ChangelogEntry } from "../format";
export const entry: ChangelogEntry = {
  id: "guided-setup-wizard-and-suggestions",
  date: "2026-07-22",
  time: "<TZ=America/New_York date +%H:%M on a 15-min boundary at commit time>",
  title: "Guided setup is now a step-by-step wizard, with Delinea credential suggestions",
  items: [
    "Setting up a system's API credentials now walks you through it step by step — overview, the console prep steps, the login, a live run that advances as the automation signs in / creates the app / harvests / vaults, then a done screen with the vaulted secret",
    "A new 'Suggest from Delinea' button (anywhere you enter a credential reference) searches this client's own Delinea folders and ranks the likely secrets — showing name, note, folder path + id, template, and why it matched — so you pick instead of hunting",
    "The automatic browser run shows coarse progress by stage; the paste and existing-secret paths still work for every vendor (and are the fallback for SSO tenants)",
  ],
};
```

Register in `web/lib/changelog/entries/_registry.ts` (alphabetical by id: add `export { entry as guidedSetupWizardAndSuggestions } from "./guided-setup-wizard-and-suggestions";`). Set the real `time` from `TZ=America/New_York date +%H:%M` rounded to :00/:15/:30/:45.

- [ ] **Step 2: Full verification**

```bash
cd web && npx tsc --noEmit
npx tsx --test lib/secrets/delinea-suggestions.test.ts lib/secrets/build-suggestions.test.ts lib/secrets/setup-stage.test.ts lib/secrets/wizard-steps.test.ts lib/changelog/entries/registry.test.ts
```
Expected: tsc clean; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add web/lib/changelog/entries/guided-setup-wizard-and-suggestions.ts web/lib/changelog/entries/_registry.ts
git commit -m "docs(changelog): guided-setup wizard + Delinea suggestions"
```

---

## Self-review notes (checked against the spec)

- Spec "reusable Suggest button at BOTH cred and login steps" → Task 3 component + Task 5 wires it in login, fields, and existing steps. ✓
- Spec "ranked by template + name + folder + recency" → Task 1 ranking (template/name/folder). **Recency is a documented tie-break only and the fast folder listing exposes no reliable date, so recency is omitted in v1** — the ranking is deterministic by score then name; note this in the PR. (Not a gap: spec called recency a tie-breaker "if exposed".)
- Spec "notes for top ~5" → Task 2 `noteTopN: 5`, best-effort. ✓
- Spec "names/notes/metadata only, never values" → route uses `/summary` + listing only; no value read. ✓
- Spec "step-by-step wizard, coarse live progress, degrades gracefully" → Tasks 4 (stage) + 5 (wizard); `stageIndex` returns −1 when absent so the run step shows indeterminate. ✓
- Spec "non-automatic vendors skip Run" → `wizardStepIds` returns fields path for no-`autoCreateEndpoint`. ✓
- Placeholder scan: the only `<…>` is the changelog `time`, which is intentionally stamped at commit time per convention. No TBD/TODO in code steps.
- Type consistency: `RankedSuggestion` (Task 1) extended by `RankedSuggestionWithNote` (Task 2); `SETUP_STAGES`/`stageIndex` (Task 4) consumed by Task 5; `SetupSource`/`wizardStepIds` (Task 5) self-consistent.
