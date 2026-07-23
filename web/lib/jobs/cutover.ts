// Azure-cutover state machine (feature #2). One AppSetting key (`cutover`) holds the whole guided
// move as a single JSON object — same pattern as agent-migration / maintenance / db-backup, so there
// is NO Prisma migration on the shared DB the night of the move (see the DB-reset incident memory).
//
// This module is PURE (no I/O, `tsx --test`able): the durable record shape, the phase transitions,
// and the per-agent re-home verdict that the console's green/red board renders. It reuses the already
// built re-homing machinery verbatim — `migrateStatus` (lib/agents/migrate-status.ts) and `normalizeUrl`
// (lib/jobs/agent-migration.ts). It invents NO new runner directive: `push`/`rollback` write the
// existing `agent_migration` setting, which the heartbeat already turns into `migrate:{appUrl}`.
import { normalizeUrl } from "@/lib/jobs/agent-migration";
import { migrateStatus, type MigrateStatusAgent } from "@/lib/agents/migrate-status";
import { AGENT_ONLINE_MS } from "@/lib/runner/reachability";
import type { DbBaseline, DbVerifyResult } from "@/lib/jobs/cutover-db";

// S3: our state lives under the exclusive `cutover` key.
export const CUTOVER_KEY = "cutover";

// An agent that has re-homed but not heartbeated within this window is "converged but quiet" (pending),
// not green — green requires a fresh beat on the new URL. Past OFFLINE it counts as an offline straggler.
export const REHOME_OFFLINE_MS = 10 * 60_000;

export type CutoverPhase =
  | "idle"
  | "staged"
  | "draining"
  | "pushing"
  | "verifying-agents"
  | "verifying-db"
  | "complete"
  | "rolled-back";

export type CutoverAction = "stage" | "push" | "confirm" | "rollback" | "ackStragglers";

export type CutoverState = {
  phase: CutoverPhase;
  azureUrl: string; // the new target base URL
  oldUrl: string | null; // captured at stage time = the fleet's current common URL, for symmetric rollback
  startedBy: string | null; // operator email who staged
  stagedAt: string | null;
  pushedAt: string | null;
  completedAt: string | null;
  rolledBackAt: string | null;
  baseline: DbBaseline | null; // captured pre-dump on the source host, travels inside pg_dump
  dbVerify: DbVerifyResult | null; // computed post-restore on the new host
  acknowledgedStragglers: boolean; // operator accepted "complete with N offline-unconverged agents"
};

export const EMPTY_CUTOVER: CutoverState = {
  phase: "idle",
  azureUrl: "",
  oldUrl: null,
  startedBy: null,
  stagedAt: null,
  pushedAt: null,
  completedAt: null,
  rolledBackAt: null,
  baseline: null,
  dbVerify: null,
  acknowledgedStragglers: false,
};

const PHASES: CutoverPhase[] = [
  "idle", "staged", "draining", "pushing", "verifying-agents", "verifying-db", "complete", "rolled-back",
];

// Coerce a raw (possibly partial / legacy / corrupt) setting value into a full state. Fail-safe:
// anything non-object or an unknown phase reads as idle — a corrupt setting must never leave the
// machine stuck mid-cutover with no way back to a clean stage.
export function normalizeCutover(raw: unknown): CutoverState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_CUTOVER };
  const r = raw as Partial<CutoverState>;
  const phase = typeof r.phase === "string" && (PHASES as string[]).includes(r.phase) ? (r.phase as CutoverPhase) : "idle";
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  return {
    phase,
    azureUrl: typeof r.azureUrl === "string" ? r.azureUrl.trim() : "",
    oldUrl: str(r.oldUrl),
    startedBy: str(r.startedBy),
    stagedAt: str(r.stagedAt),
    pushedAt: str(r.pushedAt),
    completedAt: str(r.completedAt),
    rolledBackAt: str(r.rolledBackAt),
    baseline: r.baseline && typeof r.baseline === "object" ? (r.baseline as DbBaseline) : null,
    dbVerify: r.dbVerify && typeof r.dbVerify === "object" ? (r.dbVerify as DbVerifyResult) : null,
    acknowledgedStragglers: r.acknowledgedStragglers === true,
  };
}

// The phase an action moves the machine INTO (or the current phase for actions that don't advance it,
// e.g. ackStragglers). Undefined = the action produces no phase change of its own.
const ACTION_TO: Record<CutoverAction, CutoverPhase | undefined> = {
  stage: "staged",
  push: "pushing",
  confirm: "complete",
  rollback: "rolled-back",
  ackStragglers: undefined,
};

// Legal SOURCE phases per action — the transition guards. Illegal jumps (e.g. confirm from idle, push
// before stage) return false so the route rejects rather than corrupting the record.
const ACTION_FROM: Record<CutoverAction, CutoverPhase[]> = {
  // Re-stage is allowed before push (adjust the URL), and after a finished/aborted run (start a new one).
  stage: ["idle", "staged", "draining", "complete", "rolled-back"],
  // Push only after the fleet is staged (and, in the route, drain-quiesced).
  push: ["staged", "draining"],
  // Confirm only from an in-progress push/verify (the route additionally requires all-green + dbVerify.ok).
  confirm: ["pushing", "verifying-agents", "verifying-db"],
  // Roll back from anywhere a push may be in flight (or staged, to abort cleanly).
  rollback: ["staged", "draining", "pushing", "verifying-agents", "verifying-db"],
  // Acknowledge stragglers only while verifying — it unblocks confirm.
  ackStragglers: ["pushing", "verifying-agents", "verifying-db"],
};

// Is this action legal from the current phase?
export function canAct(state: CutoverState, action: CutoverAction): boolean {
  return ACTION_FROM[action].includes(state.phase);
}

// The phase resulting from a (legal) action. Callers MUST gate on canAct first; this only maps the
// action to its destination phase (leaving the phase unchanged when the action doesn't advance it).
export function nextPhase(state: CutoverState, action: CutoverAction): CutoverPhase {
  if (!canAct(state, action)) return state.phase;
  return ACTION_TO[action] ?? state.phase;
}

// Adjacency guard used by the loader/view to reason about legal forward moves independent of a specific
// action label (the stepper renders "can I get from here to there?"). A phase can always hold (self).
const ADJACENCY: Record<CutoverPhase, CutoverPhase[]> = {
  idle: ["idle", "staged"],
  staged: ["staged", "draining", "pushing", "rolled-back"],
  draining: ["draining", "staged", "pushing", "rolled-back"],
  pushing: ["pushing", "verifying-agents", "verifying-db", "complete", "rolled-back"],
  "verifying-agents": ["verifying-agents", "verifying-db", "complete", "rolled-back"],
  "verifying-db": ["verifying-db", "verifying-agents", "complete", "rolled-back"],
  complete: ["complete", "staged"],
  "rolled-back": ["rolled-back", "staged"],
};

export function canAdvance(state: CutoverState, to: CutoverPhase): boolean {
  return (ADJACENCY[state.phase] ?? []).includes(to);
}

// ── per-agent re-home verdict ──────────────────────────────────────────────────────────────────────
// The cutover-scoped green/red/pending signal, built ON TOP of the shared migrateStatus verdict so the
// board and the agents page never disagree. Kinds:
//   green   — reported in on the Azure URL within the online window (a real, fresh convergence)
//   red     — the move actively failed / bounced back, OR the agent is long-offline and still on the old
//             URL (we can't reach it to re-home; it is the thing blocking a clean cutover)
//   pending — in flight (queued/moving), or converged-but-quiet (re-homed, just hasn't beaten recently)
export type RehomeKind = "green" | "red" | "pending";
export type RehomeReasonCode =
  | "migrated"
  | "failed"
  | "returned-old"
  | "offline-unconverged"
  | "converged-quiet"
  | "moving"
  | "queued"
  | "not-started";

export type AgentRehomeInput = MigrateStatusAgent & { id: string; name: string; scope?: string; clientName?: string | null };
export type RehomeVerdict = { agentId: string; name: string; kind: RehomeKind; reasonCode: RehomeReasonCode; reason: string };

export function agentRehomeVerdict(
  a: AgentRehomeInput,
  azureUrl: string | null,
  now: number,
  offlineMs: number = REHOME_OFFLINE_MS
): RehomeVerdict {
  const target = normalizeUrl(azureUrl);
  const current = normalizeUrl(a.currentAppUrl);
  const seenMs = a.lastSeenAt ? Date.parse(a.lastSeenAt) : NaN;
  const recentlySeen = Number.isFinite(seenMs) && now - seenMs <= AGENT_ONLINE_MS;
  const longOffline = !Number.isFinite(seenMs) || now - seenMs > offlineMs;
  const converged = target !== "" && ((current !== "" && current === target) || Boolean(a.migratedAt));

  const st = migrateStatus(a, azureUrl, now); // shared verdict — reused verbatim
  const base = (kind: RehomeKind, reasonCode: RehomeReasonCode, reason: string): RehomeVerdict => ({ agentId: a.id, name: a.name, kind, reasonCode, reason: st?.label ?? reason });

  // An actively-failed or bounced-back move is red regardless of anything else.
  if (st?.kind === "failed") return base("red", "failed", "migration failed — still on the old URL");
  if (st?.kind === "returned-old") return base("red", "returned-old", "came back on the old URL — the move didn't stick");

  if (converged) {
    return recentlySeen
      ? base("green", "migrated", `re-homed to ${a.currentAppUrl ?? "the new URL"}`)
      : base("pending", "converged-quiet", "re-homed but hasn't beaten in recently");
  }

  // Not converged. If we can't reach it (long offline) it's the straggler blocking cutover → red.
  if (longOffline) return base("red", "offline-unconverged", "offline and still on the old URL — can't re-home it");
  // Otherwise it's mid-move or simply hasn't taken the directive yet → pending.
  if (st?.kind === "queued") return base("pending", "queued", "migration queued — waiting for the runner to poll");
  return base("pending", "moving", "moving to the new URL…");
}

export type FleetRehomeSummary = { total: number; green: number; red: number; pending: number; offlineUnconverged: number };

export function fleetRehomeSummary(verdicts: RehomeVerdict[]): FleetRehomeSummary {
  const s: FleetRehomeSummary = { total: verdicts.length, green: 0, red: 0, pending: 0, offlineUnconverged: 0 };
  for (const v of verdicts) {
    if (v.kind === "green") s.green++;
    else if (v.kind === "red") s.red++;
    else s.pending++;
    if (v.reasonCode === "offline-unconverged") s.offlineUnconverged++;
  }
  return s;
}

// Confirm precondition (pure, so the route and the button agree): every agent green, with the sole
// permitted exception of offline stragglers ONCE the operator has acknowledged them, AND the DB move
// verified. This is the structural split-brain guard — cutover never completes until the fleet has
// converged and the database is proven intact.
export function canConfirm(state: CutoverState, summary: FleetRehomeSummary): { ok: boolean; reason?: string } {
  if (!canAct(state, "confirm")) return { ok: false, reason: `cannot confirm from phase "${state.phase}"` };
  const unresolvedReds = summary.red - (state.acknowledgedStragglers ? summary.offlineUnconverged : 0);
  if (unresolvedReds > 0) return { ok: false, reason: `${unresolvedReds} agent(s) failed to re-home` };
  if (summary.pending > 0) return { ok: false, reason: `${summary.pending} agent(s) still moving` };
  if (!state.dbVerify) return { ok: false, reason: "run the database verification first" };
  if (!state.dbVerify.ok) return { ok: false, reason: "database verification did not pass" };
  return { ok: true };
}
