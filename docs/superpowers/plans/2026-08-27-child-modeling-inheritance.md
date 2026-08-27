# Roles and personas reach child clients, with an opt-out (FR #41) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A child client picks up its parent's roles and personas even when it has systems of its own,
and an operator can switch that off per child.

**Architecture:** Today ONE flag and ONE gate decide two different questions. Split them: systems
inheritance stays gated on "the child has no systems of its own"; modeling inheritance (personas,
globals, identity, locations) becomes independent, governed by its own `inheritParentModeling` flag.

**Tech Stack:** TypeScript, Prisma (one additive migration), `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-17-open-feature-requests-batch-2-design.md` (item 14)

## Diagnosis (confirmed 2026-08-27)

The request: *"Roles & personas should sync over to child clients with the option to remove them if
necessary."*

`inheritsFromParent` gates everything on `systems.length === 0`. That conflates two separate questions —
*which systems does this client run* and *which roles and personas apply to its people* — so **a child
that has any systems of its own inherits no personas at all**, which is the spec's reading and is correct.

FR #42 (shipped earlier today) fixed the neighbouring half: the fallback was missing entirely from the
re-plan path, so systems-less children lost their parent's personas on every re-plan. That is done. What
remains is this gate.

### What is actually affected

Five child clients have systems of their own:

| Child | Own personas | Parent personas | Effect |
|---|---|---|---|
| **core847** Maywood Veterinary Clinic | NULL | 4 | **the live gap** — can never inherit them |
| core860 Liverpool Animal Health | 4 (identical copy) | 4 | own copy wins; silently drifts if the parent is edited |
| core866 Rocky Point Animal Hospital | 4 (identical copy) | 4 | same |
| core2187 Olympus LittleRock | `{}` | 2 | an empty object is not null, so no fallback either way |
| yuma Yuma Holdings | NULL | `{}` | parent has none — nothing to inherit |

So the change moves exactly **one** client today: core847 gains its parent's four personas. core860 and
core866 keep their own copies (child's own value still wins), which is why this is safe to ship.

The 37 systems-less children are unaffected: they already inherit through the systems gate, and would
inherit through the new modeling gate instead. Nothing has `inheritParentSystems = false` with no systems,
so no client loses anything.

### Decisions

1. **A separate flag, `inheritParentModeling`.** Reusing `inheritParentSystems` would mean "stop inheriting
   roles" also breaks systems inheritance — the exact conflation being fixed.
2. **Default `true`.** Matches the request ("should sync over") and preserves today's behaviour for every
   systems-less child.
3. **The child's own value still wins.** `personas: child.personas ?? parent.personas`. This is what keeps
   core860/core866 on their own copies and makes the change one-client-wide.
4. **NULL means unset; `{}` does not.** core2187 carries `personas: {}`, and treating an empty object as
   unset would silently hand it two personas nobody asked for. An operator who wants none has the flag.
5. **`locations` stays in the modeling set.** 35 of 37 systems-less children set their own, so the fallback
   rarely fires; removing it from the set would change behaviour for the two that rely on it.
6. **The migration ships in the PR; it is NOT applied here.** `DATABASE_URL` points at the live Azure
   database, and the repo convention (`prs.sh`) is that a human runs `npx prisma migrate deploy` after the
   merge. The migration SQL is hand-authored to match the existing files.

## Global Constraints

- Web-only. **No runner change, no `runner/VERSION` bump.**
- **One additive migration**, `ALTER TABLE ... ADD COLUMN ... DEFAULT true`. No backfill needed.
- Baseline to beat: web **2174 pass / 6 known fail**.

---

### Task 1: Schema and migration

**Files:**
- Modify: `web/prisma/schema.prisma`
- Create: `web/prisma/migrations/20260827120000_client_inherit_parent_modeling/migration.sql`

- [ ] **Step 1: Add the column to the model**

Directly beneath `inheritParentSystems` in `model Client`:

```prisma
  // Roles/personas + every-user rules inheritance, SEPARATE from systems inheritance above. A child
  // may legitimately run its own systems while still following the parent's people rules, so gating
  // this on "has no systems of its own" (as the systems link is) denied a child its parent's personas
  // the moment it owned a single ClientSystem row (FR #0000041). Set false to stop following them.
  inheritParentModeling  Boolean      @default(true)
```

- [ ] **Step 2: Write the migration**

```sql
-- Roles/personas inheritance for child clients, separate from systems inheritance (FR #0000041).
-- Additive and defaulted true, which is exactly today's behaviour for every child that inherits.
ALTER TABLE "Client" ADD COLUMN "inheritParentModeling" BOOLEAN NOT NULL DEFAULT true;
```

- [ ] **Step 3: Regenerate the client (do NOT migrate)**

Run: `cd web && npx prisma generate`

Do **not** run `prisma migrate dev` — it would apply to the live database. `migrate deploy` is a human
step after the merge.

- [ ] **Step 4: Commit**

```bash
git add web/prisma/schema.prisma web/prisma/migrations/
git commit -m "FR #41 (1/3): inheritParentModeling column"
```

---

### Task 2: Split modeling inheritance from systems inheritance

**Files:**
- Modify: `web/lib/cases/parent-inheritance.ts`
- Modify: `web/lib/cases/repository.ts` (`clientForPlanning`, `replanInputs`)
- Test: `web/lib/cases/parent-inheritance.test.ts`

**Interfaces:**
- Produces: `inheritsParentModeling(child: { parentId: string | null; inheritParentModeling: boolean }): boolean`
  and a reworked `applyParentInheritance(child, parent, opts: { systems: boolean; modeling: boolean })`.

- [ ] **Step 1: Write the failing tests**

Append to `web/lib/cases/parent-inheritance.test.ts`:

```typescript
import { inheritsParentModeling } from "./parent-inheritance";

test("modeling inheritance does NOT depend on having no systems (FR #0000041)", () => {
  // core847: five systems of its own, and its parent's four personas were unreachable.
  assert.equal(inheritsParentModeling({ parentId: "p1", inheritParentModeling: true }), true);
});

test("modeling inheritance is off when the child opted out", () => {
  assert.equal(inheritsParentModeling({ parentId: "p1", inheritParentModeling: false }), false);
});

test("a top-level client never inherits modeling", () => {
  assert.equal(inheritsParentModeling({ parentId: null, inheritParentModeling: true }), false);
});

test("modeling-only inheritance takes personas but NOT systems", () => {
  const child = { ...emptyChild(), systems: [{ systemKey: "m365" }] as unknown[] };
  const out = applyParentInheritance(child, parent, { systems: false, modeling: true });
  assert.deepEqual(out.systems, [{ systemKey: "m365" }]); // its own systems are kept
  assert.deepEqual(out.personas, parent.personas);        // the parent's personas arrive
});

test("systems-only inheritance takes systems but leaves modeling alone", () => {
  const out = applyParentInheritance(emptyChild(), parent, { systems: true, modeling: false });
  assert.deepEqual(out.systems, parent.systems);
  assert.equal(out.personas, null);
});

test("a child's OWN personas still win over the parent's", () => {
  // core860/core866 hold identical copies; they must keep using their own.
  const child = { ...emptyChild(), personas: { own: {} } };
  const out = applyParentInheritance(child, parent, { systems: true, modeling: true });
  assert.deepEqual(out.personas, { own: {} });
});

test("an EMPTY personas object is not treated as unset", () => {
  // core2187 carries {}. Treating it as unset would hand it two personas nobody asked for.
  const child = { ...emptyChild(), personas: {} };
  const out = applyParentInheritance(child, parent, { systems: true, modeling: true });
  assert.deepEqual(out.personas, {});
});
```

Update the existing `applyParentInheritance` tests to pass `{ systems: true, modeling: true }`.

- [ ] **Step 2: Run and watch them fail**

Run: `cd web && npx tsx --test lib/cases/parent-inheritance.test.ts`

- [ ] **Step 3: Rework the helper**

```typescript
export function inheritsParentModeling(child: { parentId: string | null; inheritParentModeling: boolean }): boolean {
  return !!child.parentId && child.inheritParentModeling;
}

export function applyParentInheritance<C extends InheritableChild>(
  child: C,
  parent: InheritableParent | null,
  opts: { systems: boolean; modeling: boolean }
): C {
  if (!parent) return child;
  let out = child;
  // Systems come WHOLESALE and only when the child has none of its own — a parent with no systems has
  // no runbook to lend.
  if (opts.systems && parent.systems.length > 0) out = { ...out, systems: parent.systems };
  // Modeling falls back INDIVIDUALLY, and independently of systems: a child may legitimately run its
  // own systems while following the parent's people rules (FR #0000041). NULL means unset; an empty
  // object is a deliberate "none" and is left alone.
  if (opts.modeling) {
    out = {
      ...out,
      identity: out.identity ?? parent.identity,
      personas: out.personas ?? parent.personas,
      globals: out.globals ?? parent.globals,
      globalsOffboard: out.globalsOffboard ?? parent.globalsOffboard,
      locations: out.locations ?? parent.locations,
      adObjects: out.adObjects ?? parent.adObjects,
      cloudGroups: out.cloudGroups ?? parent.cloudGroups,
    };
  }
  return out;
}
```

- [ ] **Step 4: Update both call sites**

Each must fetch the parent when EITHER kind of inheritance applies, and select the new flag.

`clientForPlanning` — add `inheritParentModeling: true` to its client select, then:

```typescript
      const wantSystems = inheritsFromParent(c);
      const wantModeling = inheritsParentModeling(c);
      if (wantSystems || wantModeling) {
        const p = await db.client.findUnique({ where: { id: c.parentId! }, select: PARENT_INHERIT_SELECT });
        return applyParentInheritance({ ...c, notNeededSecrets, wiredOptionalSecrets }, p, { systems: wantSystems, modeling: wantModeling });
      }
      return { ...c, notNeededSecrets, wiredOptionalSecrets };
```

`replanInputs` — add `inheritParentModeling: true` to its client select, then:

```typescript
      const wantSystems = inheritsFromParent(c.client);
      const wantModeling = inheritsParentModeling(c.client);
      const inherited = wantSystems || wantModeling
        ? applyParentInheritance(c.client, await db.client.findUnique({ where: { id: c.client.parentId! }, select: PARENT_INHERIT_SELECT }), { systems: wantSystems, modeling: wantModeling })
        : c.client;
```

- [ ] **Step 5: Verify**

Run: `cd web && npx tsx --test lib/cases/parent-inheritance.test.ts` — all PASS.
Run: `cd web && npm test` — expected 2174 + 7 = **2181 pass**, same 6 known failures.
Run: `cd web && npx tsc --noEmit -p tsconfig.json` — clean.

- [ ] **Step 6: Commit**

```bash
git add web/lib/cases/parent-inheritance.ts web/lib/cases/parent-inheritance.test.ts web/lib/cases/repository.ts
git commit -m "FR #41 (2/3): a child inherits its parent's roles even when it runs its own systems"
```

---

### Task 3: The opt-out control

**Files:**
- Modify: `web/app/api/clients/[slug]/route.ts` (new PATCH action)
- Modify: `web/lib/clients/repository.ts` (setter, mirroring `setInheritParentSystems`)
- Modify: `web/app/clients/[slug]/page.tsx` and `web/app/clients/_components/client-vm.ts`
- Create: `web/app/clients/_components/parent-modeling-toggle.tsx`

- [ ] **Step 1: Add the repository setter**

Beside `setInheritParentSystems` in `web/lib/clients/repository.ts`:

```typescript
    async setInheritParentModeling(slug: string, inheritParentModeling: boolean) {
      return db.client.update({ where: { slug }, data: { inheritParentModeling } });
    },
```

- [ ] **Step 2: Add the PATCH action**

Alongside the existing `set-parent-inheritance` action in `web/app/api/clients/[slug]/route.ts`, following
its guard/audit shape exactly:

```typescript
    if (body.action === "set-parent-modeling") {
      const on = body.inherit === true;
      await repo.setInheritParentModeling(params.slug, on);
      await recordAudit("client.parent_modeling", { user: g.user, detail: { slug: params.slug, inheritParentModeling: on } });
      return NextResponse.json({ ok: true });
    }
```

- [ ] **Step 3: Add the toggle**

Create `web/app/clients/_components/parent-modeling-toggle.tsx`, mirroring the existing small toggles
(`NoRunnerToggle` is the closest shape — read it and follow it rather than inventing a new one). Label it
"Follow <parent>'s roles" with a one-line explanation that the child's own roles always win, and post
`{ action: "set-parent-modeling", inherit }` to `/api/clients/<slug>`.

Render it next to `ParentInheritanceControl` on the client page, under the same `{parent && ...}` guard,
and add `inheritParentModeling: boolean` to `client-vm.ts` plus the page's client select.

- [ ] **Step 4: Verify**

Run: `cd web && npx tsc --noEmit -p tsconfig.json` — clean.
Run: `cd web && npm test` — expected 2181 pass / 6 known failures.

- [ ] **Step 5: Commit**

```bash
git add web/app web/lib/clients/repository.ts
git commit -m "FR #41 (3/3): a child can stop following its parent's roles"
```

---

### Task 4: Changelog

- [ ] Create `web/lib/changelog/entries/child-modeling-inheritance.ts`, register it, verify, commit.

---

## Out of scope, deliberately

- **No live-linking of copied personas.** core860/core866 hold their own copies and keep using them; making
  a copy re-follow the parent would silently discard local edits. Clearing a child's personas is how you
  opt back in, which the reset-to-parent feature already does.
- **No backfill.** The column defaults true; nothing to migrate.
- **No change to `copyParentModeling` or `reset-child-to-parent`.** They already do the right thing and the
  spec is explicit that this must not contradict them.

## Risks

- **Personas drive groups, licences and attributes**, so handing a client four of them is a real change to
  what its onboards do. It affects exactly one client today (core847), whose siblings under the same parent
  already run those personas — but it should be checked with the requester before its next onboard.
- **A migration against the live database.** Additive with a default, so it is safe, but it must be applied
  with `npx prisma migrate deploy` after the merge or the app will error on the missing column.
