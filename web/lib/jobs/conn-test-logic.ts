// Pure helpers for the connection-test lane (no I/O), mirroring runner-logic.ts: the request
// scoping and result normalization live here so they stay unit-testable and the whole-client /
// single-system / fleet-sweep paths can't drift apart.
import { systemIsOnPrem } from "../cases/case-secrets";

export type TestableSystemInput = {
  systemKey: string;
  mode: string;
  secretNames: string[] | null;
  config: unknown;
};

export type ConnTestRowSpec = {
  systemKey: string;
  secretNames: string[];
  config: unknown;
  onPrem: boolean;
};

// The single definition of "which of a client's systems get a connection test": api-mode systems
// that actually connect to something (have a required secret). Optionally scoped to ONE system —
// the per-system retest path — which callers pair with a scoped delete so other systems' latest
// results survive.
export function testableSystems(
  systems: TestableSystemInput[],
  hasAd: boolean,
  onlySystemKey?: string
): ConnTestRowSpec[] {
  return systems
    .filter((s) => s.mode === "api" && (s.secretNames?.length ?? 0) > 0)
    .filter((s) => !onlySystemKey || s.systemKey === onlySystemKey)
    .map((s) => ({
      systemKey: s.systemKey,
      secretNames: s.secretNames ?? [],
      config: s.config ?? undefined,
      onPrem: systemIsOnPrem(s.systemKey, hasAd),
    }));
}

// Per-operation rights results a runner probe may report: ok=true (verified), ok=false (the
// credential lacks it), ok=null ("cannot verify automatically — check manually"). `optional` marks a
// nice-to-have permission (e.g. UserAuthenticationMethod.ReadWrite.All for offboard MFA removal): a
// miss is NOTED but never fails the test or turns the rights badge red.
// `surplus` marks the OPPOSITE finding: a permission the credential holds that the engine never uses
// (an over-permissioned app registration). It rides in as optional+ok=false so it can never fail a
// test, but it is NOT a missing optional permission and must not be counted as one — "3 optional
// missing" when the truth is "3 permissions too many" is a report that means the reverse of itself.
export type RightsRow = { op: string; ok: boolean | null; detail: string; optional?: boolean; surplus?: boolean };

// Rows per probe. Was 20, which the m365 probe now exceeds on a real tenant: 3 required + 7 optional
// caps + one row per surplus role (coretelligent has 7). A silent slice here would drop findings off
// the end of the table and read as "nothing else to see".
const MAX_RIGHTS_OPS = 48;
const MAX_RIGHTS_DETAIL = 300;

// Normalize a runner-posted rights array: drop malformed entries, cap lengths. Returns null when
// nothing usable was sent (older runner / probe without rights) so the column stays null.
export function parseRights(raw: unknown): RightsRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: RightsRow[] = [];
  for (const entry of raw.slice(0, MAX_RIGHTS_OPS)) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    const op = typeof o.op === "string" ? o.op.trim().slice(0, 120) : "";
    if (!op) continue;
    const ok = typeof o.ok === "boolean" ? o.ok : null;
    const detail = typeof o.detail === "string" ? o.detail.slice(0, MAX_RIGHTS_DETAIL) : "";
    const row: RightsRow = { op, ok, detail };
    if (o.optional === true) row.optional = true;
    if (o.surplus === true) { row.surplus = true; row.optional = true; } // surplus can never fail a test
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

// Roll a rights array up to the badge the UI shows: verified (all ops ok), missing (any op the
// credential definitely lacks), unverified (some ops couldn't be checked), or unknown (no data).
// The state is driven by the REQUIRED ops only — an optional op that's missing is surfaced as
// `optionalMissing` (a note beside the badge), never as a "missing" that reads like a failure.
export type RightsSummary =
  | { state: "unknown" }
  | { state: "verified"; total: number; optionalMissing: number; surplus: number }
  | { state: "missing"; missing: number; total: number; optionalMissing: number; surplus: number }
  | { state: "unverified"; unverified: number; total: number; optionalMissing: number; surplus: number };

export function summarizeRights(rights: RightsRow[] | null | undefined): RightsSummary {
  if (!rights || rights.length === 0) return { state: "unknown" };
  // Surplus rows are optional+ok=false on the wire, but they are the opposite of a missing optional
  // permission — count them separately or the badge says "N optional missing" about permissions the
  // credential HAS too many of.
  const surplus = rights.filter((r) => r.surplus).length;
  const optionalMissing = rights.filter((r) => r.optional && !r.surplus && r.ok === false).length;
  // Required ops drive the badge. If a probe somehow sent only optional rows, fall back to all rows
  // so the badge still reflects something rather than reporting an empty "verified" — but never fall
  // back to surplus rows, which would report a fully-working credential as "missing".
  const required = rights.filter((r) => !r.optional);
  const base = required.length > 0 ? required : rights.filter((r) => !r.surplus);
  if (base.length === 0) return { state: "verified", total: 0, optionalMissing, surplus };
  const missing = base.filter((r) => r.ok === false).length;
  if (missing > 0) return { state: "missing", missing, total: base.length, optionalMissing, surplus };
  const unverified = base.filter((r) => r.ok === null).length;
  if (unverified > 0) return { state: "unverified", unverified, total: base.length, optionalMissing, surplus };
  return { state: "verified", total: base.length, optionalMissing, surplus };
}
