// Agent on-prem capabilities: which ALWAYS_ON_PREM system keys a runner host can actually execute (its
// host-specific Coretelligent module loaded). The runner reports them each heartbeat; the claim gate and
// the run-report reason use them so an incapable agent (e.g. a DC missing the ActiveDirectory/RSAT
// module) never gets dispatched an on-prem job it would hard-fail — it stays pending with a clear reason.
import { ALWAYS_ON_PREM_SYSTEMS } from "../cases/case-secrets";

// Normalize the reported value. The runner sends a JSON-array STRING (e.g. '["active-directory"]', or
// '[]' for "none") — tolerate a raw array or a bare scalar too. Returns the reported keys, or NULL when
// nothing was reported (a legacy pre-1.31 runner). NULL means "unknown → treat as capable" so routing is
// unchanged until a runner actually reports; [] is distinct and means "reports it can run no on-prem system".
export function parseCapabilities(v: unknown): string[] | null {
  if (v == null) return null;
  let arr: unknown[] | null;
  if (Array.isArray(v)) {
    arr = v;
  } else if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null; // "" — not reported
    if (s.startsWith("[")) {
      try {
        const p: unknown = JSON.parse(s);
        arr = Array.isArray(p) ? p : null;
      } catch {
        arr = []; // malformed array string — reported, but nothing usable
      }
    } else {
      arr = [s]; // a single scalar key
    }
  } else {
    arr = null;
  }
  if (arr == null) return null;
  return arr.filter((x): x is string => typeof x === "string");
}

// Can this agent claim/run a job for `systemKey`? Non-on-prem systems are always runnable here (the
// separate central-vs-client scope rule still applies). An on-prem system requires the agent to REPORT
// the capability; a legacy agent (caps === null) is treated as capable so rollout doesn't strand jobs.
export function agentCanRun(systemKey: string, caps: string[] | null): boolean {
  if (!ALWAYS_ON_PREM_SYSTEMS.includes(systemKey)) return true;
  if (caps === null) return true; // legacy runner — don't block during rollout
  return caps.includes(systemKey);
}

// The on-prem system keys to WITHHOLD from a client agent's claim query given its reported caps. Legacy
// (null) withholds nothing (old behavior); a reporting agent withholds every on-prem key it didn't list.
export function onPremExclusions(caps: string[] | null): string[] {
  if (caps === null) return [];
  return ALWAYS_ON_PREM_SYSTEMS.filter((k) => !caps.includes(k));
}
