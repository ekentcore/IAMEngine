# Offboard: hide from GAL by default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every offboarding, hide the departing user from the Global Address List by default (Exchange/EXO `HiddenFromAddressListsEnabled = $true`; Google `includeInGlobalAddressList = false`), unless the client or the individual case opts out.

**Architecture:** The policy (default-on, opt-out precedence, AD-vs-EXO routing) lives in the planner (`web/lib/profiles/plan-resolve.ts`), which injects a `hideFromGal: true` config key onto the `exchange` and `google-workspace` offboard jobs. The runner modules honor that key with idempotent, read-back-confirmed steps. On-prem AD's existing attribute-based hide is reused and takes precedence when a client has configured a concrete AD attribute.

**Tech Stack:** Next.js (App Router, TypeScript) + Vitest for web; PowerShell 7 + Pester for the runner.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-offboard-hide-from-gal-design.md`. This plan implements it in full.
- Every executor is idempotent — read state, skip if already done, act, read back to confirm. Reference: convert-to-shared at `Coretelligent.Exchange.psm1:776-842`.
- Opt-out precedence, highest first: (1) per-case `payload.skipGalHide === true`; (2) per-client resolved config `hideFromGal: false` / `{ value: false }`; (3) default → hide.
- Google's sense is inverted: `includeInGlobalAddressList = $false` HIDES.
- The cloud GAL hide runs ONLY on the `exchange` lane. Graph does not expose `HiddenFromAddressListsEnabled`, so there is no `m365`/`entra` path — do not add one.
- AD ownership: the `active-directory` offboard job owns the hide ONLY when its config carries `hideFromGal.attribute` (a concrete attribute). A bare `hideFromGal: true` on the AD lane is a no-op in the AD module (`psm1:668-675`) and does NOT count as AD-owned.
- Config key casing: clients use both `hideFromGal` and `hideFromGAL` (e.g. `profiles/coretelligent.json:227`). All reads must be case-insensitive on that key.
- Google `systemKey` is `google-workspace`. Runner offboard dispatch: `Start-IamRunner.ps1:1443`.
- Module manifest export drift: any NEW exported PowerShell function must be added to the module's `.psd1` `FunctionsToExport`, or production hides it. (Internal helpers used only inside the same `.psm1` need no export, but Pester tests import the module and call them — so functions the tests call directly MUST be exported.)
- Runner change ⇒ bump `runner/VERSION`. Current on this branch: `1.80.0`. Target: **`1.82.0`** (a minor bump; `1.81.0` is taken by in-flight PR #175).
- Ship convention: append a one-file-per-entry changelog file under `web/lib/changelog/entries/` and register it in `_registry.ts`. Entry `time` MUST come from `TZ=America/New_York date +%H:%M` rounded to a 15-min boundary.

---

### Task 1: Planner — default-on GAL hide with opt-out precedence and AD routing

The heart of the feature. A new client-safe helper module plus an injection step in `resolveOffboardConfigs`. Pure TypeScript, fully unit-testable with no DB.

**Files:**
- Create: `web/lib/profiles/hide-from-gal.ts`
- Create: `web/lib/profiles/hide-from-gal.test.ts`
- Modify: `web/lib/profiles/plan-resolve.ts:38-78` (the whole `resolveOffboardConfigs` body — restructure the delegate tail and add GAL injection)
- Test: `web/lib/profiles/plan-resolve.test.ts` (add offboard-GAL cases; create the file if it does not exist)

**Interfaces:**
- Produces (consumed by the runner tasks via job config): each `exchange` offboard job gets `config.hideFromGal = true` unless opted out or AD-owned; each `google-workspace` offboard job gets `config.hideFromGal = true` unless opted out.
- Produces (TS, consumed by Task 3's editor mental model, and by tests):
  - `hideFromGalOptedOut(config: unknown): boolean` — true only when the config's `hideFromGal` (case-insensitive) is an explicit "no" (`false`, `"false"/"no"/"off"/"0"`, or `{ value: <falsey> }`).
  - `adLaneHidesViaAttribute(config: unknown): boolean` — true when the config's `hideFromGal` (case-insensitive) has a non-empty `attribute` string.
- Consumes: `PlannedJob` from `../orchestrator` (already imported in `plan-resolve.ts`); the case `payload` (already the 2nd arg of `resolveOffboardConfigs`).

- [ ] **Step 1: Write the failing test for the helpers**

Create `web/lib/profiles/hide-from-gal.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hideFromGalOptedOut, adLaneHidesViaAttribute } from "./hide-from-gal";

describe("hideFromGalOptedOut", () => {
  it("is false when the key is absent (default-on)", () => {
    expect(hideFromGalOptedOut({})).toBe(false);
    expect(hideFromGalOptedOut(null)).toBe(false);
    expect(hideFromGalOptedOut(undefined)).toBe(false);
  });
  it("is false when hideFromGal is truthy", () => {
    expect(hideFromGalOptedOut({ hideFromGal: true })).toBe(false);
    expect(hideFromGalOptedOut({ hideFromGal: { value: true } })).toBe(false);
  });
  it("is true only for an explicit no", () => {
    expect(hideFromGalOptedOut({ hideFromGal: false })).toBe(true);
    expect(hideFromGalOptedOut({ hideFromGal: "false" })).toBe(true);
    expect(hideFromGalOptedOut({ hideFromGal: "off" })).toBe(true);
    expect(hideFromGalOptedOut({ hideFromGal: { value: false } })).toBe(true);
  });
  it("reads the hideFromGAL casing variant too", () => {
    expect(hideFromGalOptedOut({ hideFromGAL: false })).toBe(true);
    expect(hideFromGalOptedOut({ hideFromGAL: true })).toBe(false);
  });
});

describe("adLaneHidesViaAttribute", () => {
  it("is true only when a concrete attribute is present", () => {
    expect(adLaneHidesViaAttribute({ hideFromGal: { attribute: "msExchHideFromAddressLists", value: "TRUE" } })).toBe(true);
    expect(adLaneHidesViaAttribute({ hideFromGAL: { attribute: "msDS-cloudExtensionAttribute1", value: "HideFromGAL" } })).toBe(true);
  });
  it("is false for bare true, opt-out, or absence", () => {
    expect(adLaneHidesViaAttribute({ hideFromGal: true })).toBe(false);
    expect(adLaneHidesViaAttribute({ hideFromGal: false })).toBe(false);
    expect(adLaneHidesViaAttribute({ hideFromGal: { value: true } })).toBe(false);
    expect(adLaneHidesViaAttribute({})).toBe(false);
    expect(adLaneHidesViaAttribute(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run lib/profiles/hide-from-gal.test.ts`
Expected: FAIL — `Cannot find module './hide-from-gal'`.

- [ ] **Step 3: Implement the helper module**

Create `web/lib/profiles/hide-from-gal.ts`:

```ts
// Client-safe (no DB, no runner) resolution of the offboard "hide from GAL" policy.
// Mirrors the runner's Test-CtgHideFromGal truthiness so the planner and the executor
// agree on what { value: false } means. Clients spell the key both `hideFromGal` and
// `hideFromGAL` (see profiles/coretelligent.json), so every read is case-insensitive.

function readHideFromGal(config: unknown): unknown {
  if (!config || typeof config !== "object") return undefined;
  const rec = config as Record<string, unknown>;
  if ("hideFromGal" in rec) return rec.hideFromGal;
  if ("hideFromGAL" in rec) return rec.hideFromGAL;
  return undefined;
}

function isExplicitNo(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value === "string") return /^(?:false|no|off|0)$/i.test(value.trim());
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value;
    if (inner === false) return true;
    if (typeof inner === "string") return /^(?:false|no|off|0)$/i.test(inner.trim());
  }
  return false;
}

// True only when the client explicitly said "do not hide". Absence = default-on = not opted out.
export function hideFromGalOptedOut(config: unknown): boolean {
  return isExplicitNo(readHideFromGal(config));
}

// True when the AD lane carries a concrete attribute to write (the only shape the AD module acts on).
export function adLaneHidesViaAttribute(config: unknown): boolean {
  const v = readHideFromGal(config);
  if (!v || typeof v !== "object") return false;
  const attr = (v as Record<string, unknown>).attribute;
  return typeof attr === "string" && attr.trim().length > 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd web && npx vitest run lib/profiles/hide-from-gal.test.ts`
Expected: PASS (both describe blocks green).

- [ ] **Step 5: Write the failing planner-injection test**

Create or append to `web/lib/profiles/plan-resolve.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolvePlannedConfigs } from "./plan-resolve";
import type { PlannedJob } from "../orchestrator";

const job = (systemKey: string, config: Record<string, unknown> = {}): PlannedJob =>
  ({ systemKey, config } as unknown as PlannedJob);
const client = {}; // v2.0 client: no personas/globals — GAL default must still apply

function cfgOf(jobs: PlannedJob[], key: string) {
  return (jobs.find((j) => j.systemKey === key)?.config ?? {}) as Record<string, unknown>;
}

describe("offboard hide-from-GAL injection", () => {
  it("defaults hideFromGal=true on exchange and google-workspace", () => {
    const out = resolvePlannedConfigs(client, {}, "offboard", [job("exchange"), job("google-workspace"), job("m365")]);
    expect(cfgOf(out, "exchange").hideFromGal).toBe(true);
    expect(cfgOf(out, "google-workspace").hideFromGal).toBe(true);
    // never on the Graph lane
    expect(cfgOf(out, "m365").hideFromGal).toBeUndefined();
  });

  it("per-case skipGalHide=true suppresses it on every lane", () => {
    const out = resolvePlannedConfigs(client, { skipGalHide: true }, "offboard", [job("exchange"), job("google-workspace")]);
    expect(cfgOf(out, "exchange").hideFromGal).toBeUndefined();
    expect(cfgOf(out, "google-workspace").hideFromGal).toBeUndefined();
  });

  it("per-client opt-out (hideFromGal:false) is preserved, not overwritten", () => {
    const out = resolvePlannedConfigs(client, {}, "offboard", [job("exchange", { hideFromGal: false })]);
    expect(cfgOf(out, "exchange").hideFromGal).toBe(false);
  });

  it("AD attribute config takes over: exchange lane is left untouched", () => {
    const out = resolvePlannedConfigs(client, {}, "offboard", [
      job("exchange"),
      job("active-directory", { hideFromGal: { attribute: "msExchHideFromAddressLists", value: "TRUE" } }),
    ]);
    expect(cfgOf(out, "exchange").hideFromGal).toBeUndefined(); // AD owns it
    // AD job config is untouched by this feature
    expect((cfgOf(out, "active-directory").hideFromGal as Record<string, unknown>).attribute).toBe("msExchHideFromAddressLists");
  });

  it("bare hideFromGal:true on the AD lane does NOT count as AD-owned — exchange still hides", () => {
    const out = resolvePlannedConfigs(client, {}, "offboard", [job("exchange"), job("active-directory", { hideFromGal: true })]);
    expect(cfgOf(out, "exchange").hideFromGal).toBe(true);
  });

  it("does nothing on onboard", () => {
    const out = resolvePlannedConfigs(client, {}, "onboard", [job("exchange")]);
    expect(cfgOf(out, "exchange").hideFromGal).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd web && npx vitest run lib/profiles/plan-resolve.test.ts -t "hide-from-GAL"`
Expected: FAIL — exchange/google configs have no `hideFromGal` yet.

- [ ] **Step 7: Restructure `resolveOffboardConfigs` and add the injection**

In `web/lib/profiles/plan-resolve.ts`, add the import near the top (after line 8):

```ts
import { hideFromGalOptedOut, adLaneHidesViaAttribute } from "./hide-from-gal";
```

Replace the delegate tail of `resolveOffboardConfigs` (currently lines 64-77, the block from `const delegate = …` through the final `});`) with this — it stops early-returning past the GAL step and appends `injectHideFromGal`:

```ts
  const delegate = typeof payload.provideMailboxAccessTo === "string" && payload.provideMailboxAccessTo.trim()
    ? payload.provideMailboxAccessTo.trim() : null;
  const withDelegate = !delegate ? resolved : resolved.map((j) => {
    if (j.systemKey === "exchange") {
      return { ...j, config: { ...((j.config as Record<string, unknown> | null) ?? {}), grantFullAccessTo: delegate } };
    }
    if (j.systemKey === "m365" || j.systemKey === "entra") {
      const cfg = (j.config as Record<string, unknown> | null) ?? {};
      if (cfg.oneDriveDelegateAccess === false) return j;
      return { ...j, config: { ...cfg, oneDriveGrantAccessTo: delegate } };
    }
    return j;
  });

  return injectHideFromGal(withDelegate, payload);
}

// FR #0000021: hide the leaver from the GAL by default on every offboard. Precedence:
// per-case skip (payload.skipGalHide) > per-client opt-out (hideFromGal:false on the lane) > default-on.
// Cloud GAL hide runs ONLY on the exchange lane — Graph can't set HiddenFromAddressListsEnabled, so
// m365/entra are never touched here. When the AD lane carries a concrete hide ATTRIBUTE, AD owns the
// hide (correct for directory-synced mailboxes) and exchange stands down to avoid the synced-object error.
function injectHideFromGal(planned: PlannedJob[], payload: Record<string, unknown>): PlannedJob[] {
  if (payload.skipGalHide === true) return planned;
  const adOwnsHide = planned.some((j) => j.systemKey === "active-directory" && adLaneHidesViaAttribute(j.config));
  return planned.map((j) => {
    if (j.systemKey === "exchange") {
      const cfg = (j.config as Record<string, unknown> | null) ?? {};
      if (adOwnsHide) return j;
      if (hideFromGalOptedOut(cfg)) return j;
      return { ...j, config: { ...cfg, hideFromGal: true } };
    }
    if (j.systemKey === "google-workspace") {
      const cfg = (j.config as Record<string, unknown> | null) ?? {};
      if (hideFromGalOptedOut(cfg)) return j;
      return { ...j, config: { ...cfg, hideFromGal: true } };
    }
    return j;
  });
}
```

Note: the original code had `if (!delegate) return resolved;` — that early return is deliberately removed so the GAL step always runs. Confirm the function now ends with `return injectHideFromGal(...)` and the old dangling `});` is gone.

- [ ] **Step 8: Run the planner tests to verify they pass**

Run: `cd web && npx vitest run lib/profiles/plan-resolve.test.ts lib/profiles/hide-from-gal.test.ts`
Expected: PASS (all GAL cases + any pre-existing plan-resolve cases).

- [ ] **Step 9: Full web typecheck + lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add web/lib/profiles/hide-from-gal.ts web/lib/profiles/hide-from-gal.test.ts web/lib/profiles/plan-resolve.ts web/lib/profiles/plan-resolve.test.ts
git commit -m "Planner: default-on hide-from-GAL for offboard (FR #21), exchange + google lanes"
```

---

### Task 2: Offboard case form — per-case override checkbox

Adds the "keep in GAL" escape hatch to the new-case dialog. Small, self-contained React change.

**Files:**
- Modify: `web/app/cases/_components/cases-toolbar.tsx:315` (offboard payload branch) and `:386-389` (add the checkbox near the "Allowed to maintain email" one)

**Interfaces:**
- Produces: `payload.skipGalHide: boolean` on offboard case creation — consumed by Task 1's `injectHideFromGal`.

- [ ] **Step 1: Add the checkbox to the offboard-visible area**

In `cases-toolbar.tsx`, immediately AFTER the "Allowed to maintain email" label block (ends at line 389, `</label>`), add an offboard-only checkbox:

```tsx
          {action === "offboard" && (
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" name="skipGalHide" style={{ width: "auto" }} /> Keep in global address list (skip GAL hide)
            </label>
          )}
```

- [ ] **Step 2: Thread it into the offboard payload**

In the `submit()` payload ternary, change the offboard branch (line 315) from:

```tsx
      : { userToOffboard: `${first} ${last}`.trim(), dateOfOffboarding: date || null, allowedToMaintainEmail: f.get("email") === "on" };
```

to:

```tsx
      : { userToOffboard: `${first} ${last}`.trim(), dateOfOffboarding: date || null, allowedToMaintainEmail: f.get("email") === "on", skipGalHide: f.get("skipGalHide") === "on" };
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Manual smoke (dev server)**

Per the "Web dev verify recipe" memory (worktree dev server + minted DB session + `site_v2` cookie): open the New case dialog, switch Action to Offboard, confirm the "Keep in global address list" checkbox renders only for offboard (not onboard), create a dry-run offboard case, and confirm on the case's plan that the exchange step shows no `hideFromGal` when the box is checked and `hideFromGal: true` when unchecked. If a dev server is not readily available, note this step as deferred to PR review rather than blocking.

- [ ] **Step 5: Commit**

```bash
git add web/app/cases/_components/cases-toolbar.tsx
git commit -m "Offboard form: per-case 'keep in GAL' override (skipGalHide)"
```

---

### Task 3: Client config editor — structured GAL control

Lets a client be configured to opt out, and (for synced clients) to select an AD hide attribute, without hand-editing JSON. Merged over the per-lane JSON blob the same way `intent.offboard` already is.

**Files:**
- Modify: `web/app/clients/_components/systems-editor.tsx` — add a "Hide from GAL" control in the offboard section and merge it into the saved config (mirror the `intent.offboard` / `onboard.ou` special-casing at `:253-261`).

**Interfaces:**
- Consumes: the same `config.offboard` JSON the editor already round-trips.
- Produces: writes `offboard.hideFromGal` as `false` (force-off) OR `{ attribute: "<attr>", value: "TRUE" }` (AD attribute) OR omits the key (default-on). Consumed by Task 1's planner reads and the runner.

- [ ] **Step 1: Read the current editor to place the control**

Run: `sed -n '1,60p;230,275p' web/app/clients/_components/systems-editor.tsx`
Confirm where `configText` is parsed on save (~`:245-262`) and how `intent.offboard` / `onboard.ou` are merged over the parsed object. The new control merges the same way: parse the blob, set/delete `offboard.hideFromGal`, re-stringify.

- [ ] **Step 2: Add a "Hide from GAL" control to the offboard section**

Add, within the offboard-lane editing UI for mail-capable systems (`exchange`, and — for the AD attribute — `active-directory`), a select + optional text input. The select has three states, defaulting to "Default (hide)":

```tsx
{/* FR #21: GAL hide is default-on. This control only records deviations. */}
<label>Hide from GAL on offboard</label>
<select value={galMode} onChange={(e) => setGalMode(e.target.value as GalMode)}>
  <option value="default">Default — hide from GAL</option>
  <option value="off">Do NOT hide (client opts out)</option>
  {systemKey === "active-directory" && <option value="attribute">Hide via AD attribute…</option>}
</select>
{galMode === "attribute" && (
  <input
    placeholder="msExchHideFromAddressLists"
    value={galAttribute}
    onChange={(e) => setGalAttribute(e.target.value)}
  />
)}
```

Where `type GalMode = "default" | "off" | "attribute";` and `galMode`/`galAttribute` are `useState` initialized by reading the existing parsed `offboard.hideFromGal` on mount: `false`→`"off"`; `{attribute}`→`"attribute"` + the attribute; otherwise `"default"`.

- [ ] **Step 3: Merge the control's value into the saved config**

In the save path (alongside the existing `intent.offboard` merge at `:253-257`), after parsing `configText` into `parsed`:

```ts
parsed.offboard = parsed.offboard ?? {};
if (galMode === "off") {
  parsed.offboard.hideFromGal = false;
} else if (galMode === "attribute" && galAttribute.trim()) {
  parsed.offboard.hideFromGal = { attribute: galAttribute.trim(), value: "TRUE" };
} else {
  delete parsed.offboard.hideFromGal;      // default-on: no key
  delete parsed.offboard.hideFromGAL;      // also clear the casing variant if present
}
if (Object.keys(parsed.offboard).length === 0) delete parsed.offboard;
```

(Types: cast `parsed`/`parsed.offboard` to `Record<string, unknown>` consistent with the surrounding code's handling of the parsed blob.)

- [ ] **Step 4: Typecheck + lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual smoke (dev server)**

On a client's systems editor: set exchange offboard to "Do NOT hide", save, reload — confirm the control reads back "off" and the JSON shows `offboard.hideFromGal: false`. Set active-directory to "Hide via AD attribute" = `msExchHideFromAddressLists`, save/reload — confirm `{ attribute, value:"TRUE" }`. Set back to "Default", save — confirm the key is gone. Defer to PR review if no dev server is handy.

- [ ] **Step 6: Commit**

```bash
git add web/app/clients/_components/systems-editor.tsx
git commit -m "Client editor: structured hide-from-GAL control (off / AD attribute / default)"
```

---

### Task 4: Exchange runner — EXO hide step + normalizer + read-back confirm

The executor for the cloud GAL hide. Idempotent, gated on `$hasExoMailbox`, with a WARN (not a failure) when EXO rejects a directory-synced mailbox.

**Files:**
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1` — add `Test-CtgHideFromGal` (near `Test-CtgConvertToShared` at `:295`), a hide step in `Invoke-CtgExchangeOffboarding` (after the convert block, ~`:842`), and a read-back in `Confirm-CtgExchange` (`:991`).
- Modify: `runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1` — add `Test-CtgHideFromGal` to `FunctionsToExport` (tests import and call it).
- Test: `runner/tests/Coretelligent.Exchange.Tests.ps1`

**Interfaces:**
- Consumes: `Config.hideFromGal` (`$true` from the planner; or `$false`/`{value:false}` opt-out).
- Produces: action strings `"hid from GAL"` / `"already hidden from GAL"` / `"WARN could not hide from GAL — …"`, surfaced by `run-report.ts` unchanged.

- [ ] **Step 1: Write failing Pester tests**

Add to `runner/tests/Coretelligent.Exchange.Tests.ps1` a new `Describe`:

```powershell
Describe 'Invoke-CtgExchangeOffboarding hide-from-GAL' {
    BeforeEach {
        Mock Resolve-CtgExchangeTarget { [pscustomobject]@{ Upn = 'leaver@contoso.com'; DisplayName = ''; MatchCount = 1 } } -ModuleName Coretelligent.Exchange
        Mock Get-CtgMailboxSizeGB { 1 } -ModuleName Coretelligent.Exchange
        Mock Get-Mailbox { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox'; HiddenFromAddressListsEnabled = $false } } -ModuleName Coretelligent.Exchange
        Mock Set-Mailbox { } -ModuleName Coretelligent.Exchange
    }

    It 'hides from GAL when config asks and it is not already hidden' {
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = $true })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $HiddenFromAddressListsEnabled -eq $true } -Times 1
        ($r.Actions -join "`n") | Should -Match 'hid from GAL'
    }

    It 'is idempotent: skips the write when already hidden' {
        Mock Get-Mailbox { [pscustomobject]@{ RecipientTypeDetails = 'UserMailbox'; HiddenFromAddressListsEnabled = $true } } -ModuleName Coretelligent.Exchange
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = $true })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $null -ne $HiddenFromAddressListsEnabled } -Times 0
        ($r.Actions -join "`n") | Should -Match 'already hidden from GAL'
    }

    It 'does not hide when config opts out with { value = $false }' {
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = [pscustomobject]@{ value = $false } })
        Should -Invoke Set-Mailbox -ModuleName Coretelligent.Exchange -ParameterFilter { $null -ne $HiddenFromAddressListsEnabled } -Times 0
    }

    It 'WARNs (does not throw) when EXO rejects a directory-synced mailbox' {
        Mock Set-Mailbox { throw "The operation couldn't be performed because object 'leaver' is being synchronized." } -ModuleName Coretelligent.Exchange -ParameterFilter { $null -ne $HiddenFromAddressListsEnabled }
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgExchangeOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = $true })
        ($r.Actions -join "`n") | Should -Match 'WARN.*hide from GAL.*sync'
    }
}

Describe 'Test-CtgHideFromGal' {
    It 'defaults, flags, and objects resolve correctly' {
        Test-CtgHideFromGal $true | Should -BeTrue
        Test-CtgHideFromGal $false | Should -BeFalse
        Test-CtgHideFromGal 'off' | Should -BeFalse
        Test-CtgHideFromGal ([pscustomobject]@{ value = $false }) | Should -BeFalse
        Test-CtgHideFromGal ([pscustomobject]@{ value = $true }) | Should -BeTrue
        Test-CtgHideFromGal $null | Should -BeFalse
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester runner/tests/Coretelligent.Exchange.Tests.ps1 -Output Detailed"`
Expected: FAIL — `Test-CtgHideFromGal` not found; no "hid from GAL" action.

- [ ] **Step 3: Add the `Test-CtgHideFromGal` normalizer**

In `Coretelligent.Exchange.psm1`, immediately after `Test-CtgConvertToShared` (ends `:307`), add:

```powershell
# Does this client's config ask us to hide the mailbox from the GAL?
# Mirrors Test-CtgConvertToShared: a PSCustomObject is always truthy, so { value = $false } — the
# shape a client uses to opt OUT — must be read for intent, not existence. Default (no key) is
# handled by the caller; this function only judges a value that WAS provided.
function Test-CtgHideFromGal {
    [CmdletBinding()]
    param([Parameter(Position = 0)]$Config)
    if ($null -eq $Config) { return $false }
    if ($Config -is [bool]) { return [bool]$Config }
    if ($Config -is [string]) { return -not ([string]::IsNullOrWhiteSpace($Config) -or $Config -match '^(?i:false|no|off|0)$') }
    $value = Get-CtgProp $Config 'value'
    if ($null -ne $value) {
        if ($value -is [string]) { return -not ($value -match '^(?i:false|no|off|0)$') }
        return [bool]$value
    }
    # An object with no `value` (e.g. an { attribute = … } AD shape, or a settings bag) — presence is opt-in.
    return $true
}
```

- [ ] **Step 4: Add the hide step to `Invoke-CtgExchangeOffboarding`**

Insert, right after the convert-to-shared block closes (after `:842`, before the "1b. Grant the manager Full Access" block at `:844`):

```powershell
    # 1a. Hide from the GAL (FR #21) — EXO-only, idempotent -------------------
    # Default-on is decided in the planner (config.hideFromGal = $true); a client opt-out arrives as
    # $false / { value = $false }. Directory-synced mailboxes can't be modified from EXO — Set-Mailbox
    # throws a "being synchronized" error; that's a WARN for a human (hide via the AD attribute), never
    # a failed offboard. MailUsers (no EXO mailbox) are hidden on-prem via AD, so skip here.
    $hideCfg = Get-CtgProp $Config 'hideFromGal'
    if ($null -eq $hideCfg) { $hideCfg = Get-CtgProp $Config 'hideFromGAL' }
    if (Test-CtgHideFromGal $hideCfg) {
        if (-not $hasExoMailbox) {
            $actions.Add("hide-from-GAL skipped — $upn is a MailUser (on-prem mailbox); hide it via the AD attribute on the active-directory step")
        }
        else {
            $mbx = Get-Mailbox -Identity $upn -ErrorAction SilentlyContinue
            if ($mbx -and $mbx.HiddenFromAddressListsEnabled) {
                $actions.Add("already hidden from GAL")
            }
            elseif ($PSCmdlet.ShouldProcess($upn, "Hide from GAL (Set-Mailbox -HiddenFromAddressListsEnabled `$true)")) {
                try {
                    Set-Mailbox -Identity $upn -HiddenFromAddressListsEnabled $true
                    # Read back — only claim it once EXO reflects it.
                    $after = Get-Mailbox -Identity $upn -ErrorAction SilentlyContinue
                    if ($after -and $after.HiddenFromAddressListsEnabled) { $actions.Add("hid from GAL") }
                    else { $actions.Add("WARN hide from GAL submitted but EXO still shows the mailbox visible — re-run; if it persists, hide via the AD attribute") }
                }
                catch {
                    $msg = $_.Exception.Message
                    if ($msg -match 'synchroniz|being synchronized|on-premises|directory') {
                        $actions.Add("WARN could not hide from GAL — the mailbox is directory-synced and can't be changed from Exchange Online. Set the AD hide attribute (e.g. msExchHideFromAddressLists) on the active-directory step, or hide it manually.")
                    }
                    else { $actions.Add("WARN could not hide from GAL: $msg") }
                }
            }
        }
    }
```

- [ ] **Step 5: Add the read-back to `Confirm-CtgExchange`**

Read the offboard branch of `Confirm-CtgExchange` (`:991+`) first:

Run: `sed -n '991,1080p' runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1`

Then, in the offboard confirmation, add a best-effort check that does NOT hard-fail the confirm when GAL wasn't requested or the mailbox is a MailUser: only assert "hidden" when `Test-CtgHideFromGal (config.hideFromGal)` is true AND `Get-Mailbox` returns an EXO mailbox. Follow the existing pass/fail array idiom in that function (match the shape used for the convert-to-shared assertion). Concretely, add:

```powershell
    $hideCfg = Get-CtgProp $Config 'hideFromGal'; if ($null -eq $hideCfg) { $hideCfg = Get-CtgProp $Config 'hideFromGAL' }
    if (Test-CtgHideFromGal $hideCfg) {
        $mbx = Get-Mailbox -Identity $upn -ErrorAction SilentlyContinue
        if ($mbx) {
            if ($mbx.HiddenFromAddressListsEnabled) { $checks.Add("hidden from GAL") }
            else { $problems.Add("still visible in the GAL") }
        }
        # MailUser (no EXO mailbox): GAL hide is on-prem — not this lane's assertion.
    }
```

(Use whatever the function's actual accumulator variables are — `$checks`/`$problems` above are placeholders to be matched to the real names you see in Step 5's read.)

- [ ] **Step 6: Export the new function**

In `Coretelligent.Exchange.psd1`, add `'Test-CtgHideFromGal'` to `FunctionsToExport` (keep the array alphabetized if it is).

- [ ] **Step 7: Run Pester to verify pass**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester runner/tests/Coretelligent.Exchange.Tests.ps1 -Output Detailed"`
Expected: PASS (new Describes green; existing Exchange tests still green).

- [ ] **Step 8: Commit**

```bash
git add runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psm1 runner/modules/Coretelligent.Exchange/Coretelligent.Exchange.psd1 runner/tests/Coretelligent.Exchange.Tests.ps1
git commit -m "Exchange runner: hide-from-GAL offboard step (idempotent, sync-aware WARN)"
```

---

### Task 5: Google runner — hide via includeInGlobalAddressList

The Google-side executor. Inverted sense: `includeInGlobalAddressList = $false` hides.

**Files:**
- Modify: `runner/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1` — add a hide step in `Invoke-CtgGoogleOffboarding` (`:297`) and a read-back in `Confirm-CtgGoogle` (`:400`).
- Test: `runner/tests/Coretelligent.GoogleWorkspace.Tests.ps1`

**Interfaces:**
- Consumes: `Config.hideFromGal` (`$true` default from the planner; `$false`/`{value:false}` opt-out). Reuses the same intent semantics — add a tiny local `Test-CtgGoogleHideFromGal` OR replicate the `{value}` read inline (the Exchange `Test-CtgHideFromGal` is in a different module; do not cross-import modules — keep Google self-contained).
- Produces: action strings `"hid from GAL (contact sharing off)"` / `"already hidden from GAL"`.

- [ ] **Step 1: Write failing Pester tests**

Add to `runner/tests/Coretelligent.GoogleWorkspace.Tests.ps1`:

```powershell
Describe 'Invoke-CtgGoogleOffboarding hide-from-GAL' {
    BeforeEach {
        Mock Get-CtgGoogleUser { [pscustomobject]@{ primaryEmail = 'leaver@contoso.com'; includeInGlobalAddressList = $true } } -ModuleName Coretelligent.GoogleWorkspace
        Mock Get-CtgGoogleUserGroups { @() } -ModuleName Coretelligent.GoogleWorkspace
        Mock Get-CtgGoogleSessionScopes { @() } -ModuleName Coretelligent.GoogleWorkspace
        Mock Invoke-CtgGoogleApi { } -ModuleName Coretelligent.GoogleWorkspace
    }

    It 'sets includeInGlobalAddressList=$false by default' {
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgGoogleOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = $true })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter {
            $Method -eq 'PUT' -and $Path -eq '/users/leaver@contoso.com' -and $Body.includeInGlobalAddressList -eq $false
        } -Times 1
        ($r.Actions -join "`n") | Should -Match 'hid from GAL'
    }

    It 'is idempotent when already hidden' {
        Mock Get-CtgGoogleUser { [pscustomobject]@{ primaryEmail = 'leaver@contoso.com'; includeInGlobalAddressList = $false } } -ModuleName Coretelligent.GoogleWorkspace
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgGoogleOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = $true })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter {
            $null -ne $Body -and $Body.ContainsKey('includeInGlobalAddressList')
        } -Times 0
        ($r.Actions -join "`n") | Should -Match 'already hidden from GAL'
    }

    It 'does not hide when opted out with { value = $false }' {
        $u = [pscustomobject]@{ UserPrincipalName = 'leaver@contoso.com' }
        $r = Invoke-CtgGoogleOffboarding -User $u -Config ([pscustomobject]@{ hideFromGal = [pscustomobject]@{ value = $false } })
        Should -Invoke Invoke-CtgGoogleApi -ModuleName Coretelligent.GoogleWorkspace -ParameterFilter {
            $null -ne $Body -and $Body.ContainsKey('includeInGlobalAddressList')
        } -Times 0
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester runner/tests/Coretelligent.GoogleWorkspace.Tests.ps1 -Output Detailed"`
Expected: FAIL — no includeInGlobalAddressList PUT; no "hid from GAL" action.

- [ ] **Step 3: Add the hide step**

In `Invoke-CtgGoogleOffboarding`, insert a step BEFORE the suspend (before `:345` "5. Suspend"), so the visibility flip happens while the account is still active (order is not strictly required, but keeps it with the other directory-property writes):

```powershell
    # 4b. Hide from the directory / GAL (FR #21) — Google calls it "contact sharing".
    # includeInGlobalAddressList = $false HIDES (inverted sense). Default-on is decided in the planner
    # (config.hideFromGal = $true); a client opt-out arrives as $false / { value = $false }. Idempotent.
    $hideCfg = Get-CtgProp $Config 'hideFromGal'; if ($null -eq $hideCfg) { $hideCfg = Get-CtgProp $Config 'hideFromGAL' }
    $wantHide = $false
    if ($null -ne $hideCfg) {
        if ($hideCfg -is [bool]) { $wantHide = [bool]$hideCfg }
        elseif ($hideCfg -is [string]) { $wantHide = -not ($hideCfg -match '^(?i:false|no|off|0)$') }
        else { $v = Get-CtgProp $hideCfg 'value'; $wantHide = if ($null -ne $v) { -not ("$v" -match '^(?i:false|no|off|0)$') } else { $true } }
    }
    if ($wantHide) {
        $current = Get-CtgGoogleUser -Email $email
        $already = ($null -ne $current) -and ((Get-CtgProp $current 'includeInGlobalAddressList') -eq $false)
        if ($already) {
            $actions.Add("already hidden from GAL")
        }
        elseif ($PSCmdlet.ShouldProcess($email, "Hide from directory (includeInGlobalAddressList = false)")) {
            Invoke-CtgGoogleApi -Method PUT -Path "/users/$email" -Body @{ includeInGlobalAddressList = $false } | Out-Null
            $actions.Add("hid from GAL (contact sharing off)")
        }
    }
```

- [ ] **Step 4: Add the read-back to `Confirm-CtgGoogle`**

Read the confirm function first:

Run: `sed -n '400,470p' runner/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1`

Then add a best-effort assertion using the function's existing accumulator idiom: when `config.hideFromGal` resolves truthy, read the user and assert `includeInGlobalAddressList -eq $false`; only add a problem when it is still `$true`. Match the real variable names seen in the read.

- [ ] **Step 5: Run Pester to verify pass**

Run: `~/.local/pwsh/pwsh -c "Invoke-Pester runner/tests/Coretelligent.GoogleWorkspace.Tests.ps1 -Output Detailed"`
Expected: PASS (new Describe green; existing Google tests still green).

- [ ] **Step 6: Commit**

```bash
git add runner/modules/Coretelligent.GoogleWorkspace/Coretelligent.GoogleWorkspace.psm1 runner/tests/Coretelligent.GoogleWorkspace.Tests.ps1
git commit -m "Google runner: hide-from-GAL offboard step (includeInGlobalAddressList=false)"
```

---

### Task 6: Schema, docs, VERSION bump, changelog

Wraps the feature: makes the config key discoverable, documents it, and ships.

**Files:**
- Modify: `profiles/_schema.json` — add `hideFromGal` to the `m365OffboardConfig` `$def` (~`:364-377`). (Exchange offboard config is open-ended — no `$def` — so no schema entry is required there; document it instead.)
- Modify: `docs/modules/exchange.md` — describe the now-wired `hideFromGal` key and the default-on behavior.
- Modify: `runner/VERSION` — `1.80.0` → `1.82.0`.
- Create: `web/lib/changelog/entries/offboard-hide-from-gal.ts`
- Modify: `web/lib/changelog/entries/_registry.ts` — register the new entry (id-sorted).

- [ ] **Step 1: Add `hideFromGal` to the m365 offboard schema def**

Read the def first: `sed -n '360,380p' profiles/_schema.json`. Add a `hideFromGal` property to `m365OffboardConfig`'s `properties`, permissive (matches the runner's tolerance of `true` / `false` / `{ value }` / `{ attribute, value }`):

```json
"hideFromGal": {
  "description": "Hide the leaver from the Global Address List on offboard. Default is to hide; set false to opt out. On synced clients an { attribute, value } object hides via the on-prem AD attribute.",
  "oneOf": [
    { "type": "boolean" },
    { "type": "object" }
  ]
}
```

Validate the JSON parses: `node -e "JSON.parse(require('fs').readFileSync('profiles/_schema.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 2: Document the key in `docs/modules/exchange.md`**

Update the exchange config-keys section (which already lists `hideFromGal` as though wired) to state: hide-from-GAL is **default-on** for every offboard; the runner runs `Set-Mailbox -HiddenFromAddressListsEnabled $true` on the EXO mailbox; set `hideFromGal: false` on the exchange offboard config to opt a client out, or a single case can be excluded with the "Keep in global address list" checkbox; directory-synced mailboxes are hidden via the AD attribute (`active-directory` offboard `hideFromGal: { attribute, value }`) instead, and the runner WARNs if asked to hide a synced mailbox from EXO.

- [ ] **Step 3: Bump the runner version**

Run: `printf '1.82.0\n' > runner/VERSION` (match the file's existing trailing-newline convention — verify with `cat -A runner/VERSION`).

- [ ] **Step 4: Add the changelog entry**

Get the Eastern time on a 15-min boundary: `TZ=America/New_York date +%H:%M`, then round DOWN to the nearest :00/:15/:30/:45.

Create `web/lib/changelog/entries/offboard-hide-from-gal.ts`:

```ts
import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-hide-from-gal",
  date: "2026-07-21",
  time: "<HH:MM from the command above>",
  title: "Offboards now hide the leaver from the address book by default",
  items: [
    "Every offboarding now hides the departing user from the Global Address List (Exchange/365) and from directory/contact sharing (Google) automatically — previously only clients with an on-prem AD attribute configured got this (FR #0000021)",
    "A client can opt out by setting hideFromGal: false on their exchange or google offboard config; a single offboard can keep the person listed with the new 'Keep in global address list' checkbox on the case form",
    "Directory-synced mailboxes can't be hidden from Exchange Online directly — if a client has selected an AD hide attribute (e.g. msExchHideFromAddressLists) it's used; otherwise the step WARNs a human instead of failing the offboard",
    "The change is idempotent: a mailbox that's already hidden is left alone, and every hide is read back before it's reported done",
  ],
};
```

- [ ] **Step 5: Register the entry (id-sorted)**

In `web/lib/changelog/entries/_registry.ts`, add the export line in id-sorted position (between the `o…` entries):

```ts
export { entry as offboardHideFromGal } from "./offboard-hide-from-gal";
```

- [ ] **Step 6: Verify the changelog registry test passes**

Run: `cd web && npx vitest run lib/changelog`
Expected: PASS (registry.test.ts confirms every entry file is registered).

- [ ] **Step 7: Full web + runner test sweep**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Run: `~/.local/pwsh/pwsh -c "Invoke-Pester runner/tests/Coretelligent.Exchange.Tests.ps1, runner/tests/Coretelligent.GoogleWorkspace.Tests.ps1, runner/tests/Smoke.Tests.ps1 -Output Detailed"`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add profiles/_schema.json docs/modules/exchange.md runner/VERSION web/lib/changelog/entries/offboard-hide-from-gal.ts web/lib/changelog/entries/_registry.ts
git commit -m "Schema/docs/changelog + runner 1.82.0 for offboard hide-from-GAL (FR #21)"
```

---

## Self-Review

**Spec coverage:**
- Policy (default-on + 3-level precedence) → Task 1 (`injectHideFromGal`) + Tasks 4/5 (runner honors opt-out).
- Per-case override → Task 2 (`skipGalHide` checkbox) + Task 1 (precedence).
- Per-client opt-out → Task 3 (editor control) + Task 1 (`hideFromGalOptedOut`).
- AD-vs-EXO routing (attribute-owned) → Task 1 (`adLaneHidesViaAttribute`).
- Exchange executor (idempotent, sync WARN, read-back) → Task 4.
- Google executor (inverted sense, read-back) → Task 5.
- No M365/Graph path → enforced by omission + Global Constraints note; Task 1 test asserts m365 is untouched.
- AD-attribute "client can select" UI → Task 3.
- Schema + docs + VERSION + changelog → Task 6.
- Run report (auto-surfaces action lines) → no task needed (spec says no change).

**Placeholder scan:** The only intentionally-deferred specifics are the `Confirm-Ctg*` accumulator variable NAMES (Tasks 4 Step 5, 5 Step 4), which must be read from the live function because they are not visible in this plan's excerpts — each such step includes the exact `sed` command to read them and the placeholder-to-real mapping instruction. No "TBD"/"handle edge cases"/"add validation" placeholders remain.

**Type consistency:** `hideFromGalOptedOut` / `adLaneHidesViaAttribute` names are identical across the helper (Task 1 Step 3), its tests (Step 1), and the planner import (Step 7). `Test-CtgHideFromGal` is consistent across module, manifest export, and tests in Task 4. `skipGalHide` is consistent across Task 2 (form) and Task 1 (`injectHideFromGal`). `hideFromGal` config key is consistent across planner, runner, schema, editor, and docs.
