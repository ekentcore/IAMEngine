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
// credential lacks it), ok=null ("cannot verify automatically — check manually").
export type RightsRow = { op: string; ok: boolean | null; detail: string };

const MAX_RIGHTS_OPS = 20;
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
    rows.push({ op, ok, detail });
  }
  return rows.length > 0 ? rows : null;
}

// Roll a rights array up to the badge the UI shows: verified (all ops ok), missing (any op the
// credential definitely lacks), unverified (some ops couldn't be checked), or unknown (no data).
export type RightsSummary =
  | { state: "unknown" }
  | { state: "verified"; total: number }
  | { state: "missing"; missing: number; total: number }
  | { state: "unverified"; unverified: number; total: number };

export function summarizeRights(rights: RightsRow[] | null | undefined): RightsSummary {
  if (!rights || rights.length === 0) return { state: "unknown" };
  const missing = rights.filter((r) => r.ok === false).length;
  if (missing > 0) return { state: "missing", missing, total: rights.length };
  const unverified = rights.filter((r) => r.ok === null).length;
  if (unverified > 0) return { state: "unverified", unverified, total: rights.length };
  return { state: "verified", total: rights.length };
}
