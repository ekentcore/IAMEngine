// Reseed protection for ClientSystem rows. The DB is where operational corrections live —
// the Edit-systems OUs, the offboard licence sweep's per-client config, mailbox-decision policies —
// and none of that is in the profile JSON the seed reads. A no-arg `db:seed` used to upsert every
// row back to the profile values, silently reverting all of it (67 clients' licence config in one
// run). The seed has no provenance for WHICH rows a human/script touched, so the honest rule is:
// a row whose current values differ from what the seed would write is treated as DB-edited and
// KEPT, unless the operator passes an explicit --force. A row that already matches is a no-op
// either way, so the seed stays idempotent for untouched fleets.
type Jsonish = unknown;

// Structural equality under JSON semantics, object-key-order-insensitive (Prisma returns JSON
// columns with arbitrary key order; the seed builds fresh literals). An undefined-VALUED key is the
// same as an absent key — the JSONB round trip drops it (JSON.stringify semantics), and the seed's
// literals carry them freely ({ onboard: s.onboard?.dependsOn, ... }); counting them made every
// freshly-seeded row "differ" from its own source on the next run. Arrays stay order-SENSITIVE —
// dependsOn order and runbook steps are meaningful.
export function stableEqual(a: Jsonish, b: Jsonish): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => stableEqual(v, b[i]));
  }
  if (a && b && typeof a === "object") {
    const defined = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined).sort();
    const ka = defined(a as Record<string, unknown>);
    const kb = defined(b as Record<string, unknown>);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => stableEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

// The ClientSystem columns the seed writes. `config` is JSON; null and undefined both mean "no config".
export type SeedSystemFields = {
  mode: string;
  onboardWhen: string;
  offboardWhen: string;
  dependsOn: string[];
  requiresApproval: boolean;
  captureEvidence: boolean;
  secretNames: string[];
  config: Jsonish;
};

/** True when the existing row already equals what the seed would write — updating it is a no-op. */
export function clientSystemMatches(existing: SeedSystemFields, incoming: SeedSystemFields): boolean {
  return (
    existing.mode === incoming.mode &&
    existing.onboardWhen === incoming.onboardWhen &&
    existing.offboardWhen === incoming.offboardWhen &&
    stableEqual(existing.dependsOn, incoming.dependsOn) &&
    existing.requiresApproval === incoming.requiresApproval &&
    existing.captureEvidence === incoming.captureEvidence &&
    stableEqual(existing.secretNames, incoming.secretNames) &&
    stableEqual(existing.config ?? null, incoming.config ?? null)
  );
}
