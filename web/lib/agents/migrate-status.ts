// Live app-URL migration status for an agent row — pure so it's unit-testable (the runner never
// talks to this; it renders lifecycle timestamps the heartbeat wrote).
//
// The old in-component version vanished 5 minutes after delivery even when the agent never
// reported in on the new URL — exactly the window an operator needs to watch. States, in
// precedence order:
//   failed          migrateError recorded (agent tried, couldn't verify/rewrite — still on old URL)
//   migrated        heartbeat came back reporting the target URL
//   queued          operator asked, runner hasn't polled yet
//   returned-old    delivered, then the agent reported in again still on the OLD URL with no error
//                   (the move didn't stick) — shown for an hour after delivery, then treated as
//                   stale history
//   moving          delivered < 5 min ago, agent silent (verifying + rewriting + relaunching)
//   moving-quiet    delivered ≥ 5 min ago, agent still silent — "switched away, not communicating
//                   on the new URL yet". Never times out: silence is the signal.
import { normalizeUrl } from "@/lib/jobs/agent-migration";

export type MigrateStatusAgent = {
  migrateRequested: boolean;
  migrateRequestedBy: string | null;
  migrateDeliveredAt: string | null;
  migratedAt: string | null;
  migrateError: string | null;
  lastSeenAt: string | null;
  currentAppUrl: string | null;
};

export type MigrateStatus = {
  kind: "failed" | "migrated" | "queued" | "returned-old" | "moving" | "moving-quiet";
  label: string;
  color: string;
};

// How long "came back on the old URL" stays visible after delivery. Without a bound it would show
// forever on any agent whose fleet-off migration was delivered once and abandoned.
const RETURNED_OLD_WINDOW_MS = 60 * 60_000;
const MOVING_QUIET_AFTER_MS = 5 * 60_000;

export function migrateStatus(a: MigrateStatusAgent, targetUrl: string | null, now: number): MigrateStatus | null {
  const by = a.migrateRequestedBy ? ` (by ${a.migrateRequestedBy})` : "";
  if (a.migrateError) return { kind: "failed", label: `⚠ migration failed — ${a.migrateError} (still on the old URL)`, color: "var(--danger-fg, #b00)" };
  if (a.migratedAt) return { kind: "migrated", label: `✓ migrated${by} — now on ${a.currentAppUrl ?? "the new URL"}`, color: "var(--ok-fg)" };
  if (a.migrateRequested) return { kind: "queued", label: `↻ migration queued${by} — waiting for the runner to poll…`, color: "var(--warn-fg)" };
  if (!a.migrateDeliveredAt) return null;

  const del = new Date(a.migrateDeliveredAt).getTime();
  const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
  if (seen > del + 3000) {
    // The agent reported in after taking the migrate order. Converged heartbeats set migratedAt
    // (handled above), so a later report can only mean it's still on the old URL.
    const target = normalizeUrl(targetUrl);
    const current = normalizeUrl(a.currentAppUrl);
    if (target && current && current !== target && now - del <= RETURNED_OLD_WINDOW_MS) {
      return { kind: "returned-old", label: `⚠ came back on the old URL${by} — the move didn't stick (still polling ${a.currentAppUrl})`, color: "var(--danger-fg, #b00)" };
    }
    return null;
  }

  // Silent since delivery: the runner is (or should be) verifying the new URL, rewriting its own
  // supervisor entry, and relaunching. Past 5 minutes that silence is the story — keep saying so
  // until a heartbeat lands somewhere.
  if (now - del < MOVING_QUIET_AFTER_MS) {
    return { kind: "moving", label: `↻ moving URL${by} — verifying the new URL + rewriting the scheduled task…`, color: "var(--info-fg)" };
  }
  const mins = Math.floor((now - del) / 60_000);
  return { kind: "moving-quiet", label: `↻ moving URL${by} — switched away, not communicating on the new URL yet (${mins}m)`, color: "var(--warn-fg)" };
}
