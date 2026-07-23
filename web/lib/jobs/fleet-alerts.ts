// Feature #3 — proactive fleet alerting. Four standing-condition rules (agent offline, queue backlog,
// repeated failures, backup stale) evaluated at query time and delivered through the EXISTING
// failure-notification plumbing (S6): no second alerting system — every rule ends in fireNotification,
// so it honors the master switch, the per-event toggle, per-client routing, and the audit trail.
//
// Cadence: no cron exists, so this rides the heartbeat sweep fan-out (runner-service.ts heartbeat())
// exactly like conn-sweep / db-backup — an in-process throttle, then a DURABLE AppSetting throttle
// claimed race-safely via claimAppSetting so exactly one instance evaluates per tick.
//
// Dedupe is a DEADLINE READ, not a maintained counter (memory lesson, feature-request-numbering): the
// firedAt stamp lives in AppSetting `alerts.state`; a rule/subject re-fires only when the condition is
// STILL true AND now-firedAt > cooldown. When the condition clears, its key is DELETED — so a recovered-
// then-recurring subject alerts again immediately. No new table, no migration (D6 default).
//
// DB-down is deliberately NOT a rule here: a DB-backed sweep can't read its config/state or persist a
// dedupe stamp when its own DB is down, so alerting on that from here is self-defeating. The board shows
// it; external uptime monitoring + the standalone launchd backup layer are the backstop.
import { Prisma, type PrismaClient } from "@prisma/client";
import { claimAppSetting, getAppSetting, setAppSetting } from "../settings";
import { fireNotification } from "../notifications/sender";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings, parseClientOverride } from "../notifications/types";
import { AGENT_ONLINE_MS } from "../runner/reachability";
import { agentOnlineState, clusterFailures, type FailureRow } from "../fleet/health";
import { backupFreshness } from "./backup-freshness";

export const ALERTS_KEY = "alerts"; // numeric thresholds (S3: alerts.*)
export const ALERTS_STATE_KEY = "alerts.state"; // dedupe stamps + the durable sweep throttle

// ---- Thresholds (the `alerts` AppSetting) --------------------------------------------------------

export type AlertSettings = {
  agentOfflineMinutes: number; // default 15 — MUST exceed the 90s online window
  queueDepth: number; // default 25
  queueBacklogMinutes: number; // default 15 — sustained, so a normal burst doesn't page
  failureCount: number; // default 5
  failureWindowMinutes: number; // default 60
  backupMaxAgeHours: number; // default 26 — one nightly + slack
  cooldownMinutes: number; // default 120 — per rule/subject re-fire suppression
};

export const DEFAULT_ALERTS: AlertSettings = {
  agentOfflineMinutes: 15,
  queueDepth: 25,
  queueBacklogMinutes: 15,
  failureCount: 5,
  failureWindowMinutes: 60,
  backupMaxAgeHours: 26,
  cooldownMinutes: 120,
};

const posInt = (v: unknown, dflt: number, min = 1): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : dflt;

export function normalizeAlerts(raw: unknown): AlertSettings {
  const r = (raw ?? {}) as Partial<AlertSettings>;
  // agentOfflineMinutes must sit ABOVE the 90s online window or "offline" and "online" would overlap.
  const minOfflineMin = Math.ceil(AGENT_ONLINE_MS / 60_000) + 1; // 90s -> at least 2 minutes
  return {
    agentOfflineMinutes: Math.max(posInt(r.agentOfflineMinutes, DEFAULT_ALERTS.agentOfflineMinutes), minOfflineMin),
    queueDepth: posInt(r.queueDepth, DEFAULT_ALERTS.queueDepth),
    queueBacklogMinutes: posInt(r.queueBacklogMinutes, DEFAULT_ALERTS.queueBacklogMinutes),
    failureCount: posInt(r.failureCount, DEFAULT_ALERTS.failureCount),
    failureWindowMinutes: posInt(r.failureWindowMinutes, DEFAULT_ALERTS.failureWindowMinutes),
    backupMaxAgeHours: posInt(r.backupMaxAgeHours, DEFAULT_ALERTS.backupMaxAgeHours),
    cooldownMinutes: posInt(r.cooldownMinutes, DEFAULT_ALERTS.cooldownMinutes),
  };
}

// ---- Dedupe state (the `alerts.state` AppSetting) ------------------------------------------------

export type AlertRuleState = { firedAt: string }; // ISO
export type AlertState = { lastSweepAt?: string; rules: Record<string, AlertRuleState> };

export function normalizeAlertState(raw: unknown): AlertState {
  const r = (raw ?? {}) as Partial<AlertState>;
  const rules: Record<string, AlertRuleState> = {};
  if (r.rules && typeof r.rules === "object") {
    for (const [k, v] of Object.entries(r.rules)) {
      const at = (v as { firedAt?: unknown })?.firedAt;
      if (typeof at === "string") rules[k] = { firedAt: at };
    }
  }
  return { lastSweepAt: typeof r.lastSweepAt === "string" ? r.lastSweepAt : undefined, rules };
}

// Deadline read: fire when there's no prior stamp OR the cooldown has elapsed since it. An
// unparseable stamp is treated as "fire" (fail-open — better a duplicate alert than silence).
export function dueToFire(entry: AlertRuleState | undefined, now: number, cooldownMs: number): boolean {
  if (!entry) return true;
  const t = Date.parse(entry.firedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > cooldownMs;
}

// ---- Pure condition evaluators -------------------------------------------------------------------

export function evalQueueBacklog(depth: number, oldestPendingAgeMs: number | null, s: AlertSettings): boolean {
  return depth >= s.queueDepth && oldestPendingAgeMs !== null && oldestPendingAgeMs >= s.queueBacklogMinutes * 60_000;
}

export function evalRepeatedFailures(countInWindow: number, s: AlertSettings): boolean {
  return countInWindow >= s.failureCount;
}

// Reuses the freshness signal's own numbers (backupFreshness) against the configurable threshold —
// covers "the nightly backup silently stopped", distinct from `backupFailed` which fires on a run that
// actually errored.
export function evalBackupStale(backupOk: boolean, backupAgeHours: number | null, maxAgeHours: number): boolean {
  return !backupOk || backupAgeHours === null || backupAgeHours > maxAgeHours;
}

// ---- Storm guard (agentOffline) ------------------------------------------------------------------

// A bad DNS/URL migration can knock MANY agents offline at once on cutover day. Mirror
// planConnNotifications: ≤ maxIndividual newly-offline agents notify individually (each with its
// client's routing); more collapse into ONE digest to the default destination.
export type OfflineAgent = { id: string; name: string; clientName: string | null; restricted: boolean; override: unknown };
export type AgentOfflinePlan =
  | { kind: "none" }
  | { kind: "individual"; items: OfflineAgent[] }
  | { kind: "digest"; count: number; clients: number; sample: OfflineAgent[] };

export function planAgentOfflineAlerts(agents: OfflineAgent[], maxIndividual = 3): AgentOfflinePlan {
  if (agents.length === 0) return { kind: "none" };
  if (agents.length <= maxIndividual) return { kind: "individual", items: agents };
  return { kind: "digest", count: agents.length, clients: new Set(agents.map((a) => a.clientName ?? a.id)).size, sample: agents.slice(0, 5) };
}

// ---- The sweep -----------------------------------------------------------------------------------

// Heartbeats arrive ~every 5s from every runner; self-throttle so this only touches the DB about once
// a minute (siblings do the same). Delays a standing-condition alert by <1 min at worst.
let lastTickAt = 0;
const TICK_EVERY_MS = 60_000;

// Test seam: reset the in-process throttle between unit tests.
export function __resetFleetAlertThrottle(): void {
  lastTickAt = 0;
}

// The heartbeat-driven entry point. NEVER throws (chained fire-and-forget in the sweep fan-out).
export async function sweepFleetAlerts(
  db: PrismaClient,
  deps: { now?: () => Date; fire?: typeof fireNotification } = {}
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const fire = deps.fire ?? fireNotification;
  const tick = now().getTime();
  if (tick - lastTickAt < TICK_EVERY_MS) return; // in-process throttle, before any DB work
  lastTickAt = tick;

  // Master switch off -> skip entirely (fireNotification would no-op anyway; this saves the DB work).
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));
  if (!settings.enabled) return;

  const alerts = normalizeAlerts(await getAppSetting(db, ALERTS_KEY));

  // Durable, race-safe tick claim: only one instance per ~minute evaluates and writes state.
  const raw = await getAppSetting<unknown>(db, ALERTS_STATE_KEY);
  const state = normalizeAlertState(raw);
  const nowMs = now().getTime();
  if (state.lastSweepAt && nowMs - Date.parse(state.lastSweepAt) < TICK_EVERY_MS) return;
  const claimed: AlertState = { lastSweepAt: now().toISOString(), rules: { ...state.rules } };
  const won = await claimAppSetting(db, ALERTS_STATE_KEY, raw, claimed);
  if (!won) return;

  const rules = { ...claimed.rules };
  const cooldownMs = alerts.cooldownMinutes * 60_000;
  const offlineMs = alerts.agentOfflineMinutes * 60_000;
  const nowIso = now().toISOString();

  // ---- agentOffline (per-agent, storm-guarded) ---------------------------------------------------
  if (settings.events.agentOffline) {
    const agents = await db.agent.findMany({
      where: { enabled: true, deletedAt: null, lastSeenAt: { not: null } },
      select: { id: true, name: true, lastSeenAt: true, client: { select: { name: true, restricted: true, notifyOverride: true } } },
    });
    const newlyOffline: OfflineAgent[] = [];
    for (const a of agents) {
      const key = `agentOffline:${a.id}`;
      const isOffline = agentOnlineState(a.lastSeenAt ? a.lastSeenAt.getTime() : null, nowMs, offlineMs) === "offline";
      if (!isOffline) {
        delete rules[key]; // recovered -> clear so the next occurrence re-alerts immediately
        continue;
      }
      if (dueToFire(rules[key], nowMs, cooldownMs)) {
        newlyOffline.push({ id: a.id, name: a.name, clientName: a.client?.name ?? null, restricted: a.client?.restricted ?? false, override: a.client?.notifyOverride ?? null });
        rules[key] = { firedAt: nowIso }; // stamp NOW; a digest still marks every included subject
      }
    }
    const plan = planAgentOfflineAlerts(newlyOffline);
    if (plan.kind === "individual") {
      for (const a of plan.items) {
        await fire({
          event: "agentOffline",
          title: `Agent offline: ${a.name}${a.clientName ? ` · ${a.clientName}` : " · central"}`,
          clientName: a.clientName,
          detail: `Runner '${a.name}' has not checked in for over ${alerts.agentOfflineMinutes} minutes — see /health/fleet and the Agents page.`,
          at: nowIso,
          url: "/health/fleet",
          restricted: a.restricted,
          override: parseClientOverride(a.override),
        }).catch(() => {});
      }
    } else if (plan.kind === "digest") {
      const sample = plan.sample.map((a) => a.name).join(", ");
      await fire({
        event: "agentOffline",
        title: `${plan.count} agents offline across ${plan.clients} client(s)`,
        detail: `e.g. ${sample} — a fleet-wide outage or a bad URL migration. See /health/fleet.`,
        at: nowIso,
        url: "/health/fleet",
      }).catch(() => {});
    }
  }

  // ---- queueBacklog (global, sustained) ----------------------------------------------------------
  if (settings.events.queueBacklog) {
    const where: Prisma.JobWhereInput = { status: "pending", mode: "api", case: { deletedAt: null, pausedAt: null, status: { not: "completed" } } };
    const depth = await db.job.count({ where });
    const oldest = await db.job.findFirst({ where, orderBy: { case: { createdAt: "asc" } }, select: { case: { select: { createdAt: true } } } });
    const oldestAgeMs = oldest?.case?.createdAt ? nowMs - oldest.case.createdAt.getTime() : null;
    const key = "queueBacklog";
    if (evalQueueBacklog(depth, oldestAgeMs, alerts)) {
      if (dueToFire(rules[key], nowMs, cooldownMs)) {
        rules[key] = { firedAt: nowIso };
        const mins = oldestAgeMs === null ? 0 : Math.round(oldestAgeMs / 60_000);
        await fire({
          event: "queueBacklog",
          title: `Job queue backing up: ${depth} pending`,
          detail: `${depth} claimable api jobs pending; oldest has waited ~${mins} min. No runner is keeping up — check /health/fleet and the Agents page.`,
          at: nowIso,
          url: "/health/fleet",
        }).catch(() => {});
      }
    } else {
      delete rules[key];
    }
  }

  // ---- repeatedFailures (global + per-client digest body) ----------------------------------------
  if (settings.events.repeatedFailures) {
    const since = new Date(nowMs - alerts.failureWindowMinutes * 60_000);
    const failed = await db.job.findMany({
      where: { status: "failed", finishedAt: { gte: since } },
      select: { systemKey: true, case: { select: { client: { select: { name: true } } } } },
      take: 500,
    });
    const key = "repeatedFailures";
    if (evalRepeatedFailures(failed.length, alerts)) {
      if (dueToFire(rules[key], nowMs, cooldownMs)) {
        rules[key] = { firedAt: nowIso };
        const rows: FailureRow[] = failed.map((f) => ({ clientName: f.case?.client?.name ?? null, systemKey: f.systemKey }));
        const clusters = clusterFailures(rows, 5);
        const body = clusters.map((c) => `${c.clientName ?? "—"}/${c.systemKey}×${c.count}`).join(", ");
        await fire({
          event: "repeatedFailures",
          title: `Repeated failures: ${failed.length} in the last ${alerts.failureWindowMinutes} min`,
          detail: `Top: ${body} — see /runs and /health/fleet.`,
          at: nowIso,
          url: "/health/fleet",
        }).catch(() => {});
      }
    } else {
      delete rules[key];
    }
  }

  // ---- backupStale (global) ----------------------------------------------------------------------
  if (settings.events.backupStale) {
    const fresh = await backupFreshness(db, now());
    const key = "backupStale";
    if (evalBackupStale(fresh.backupOk, fresh.backupAgeHours, alerts.backupMaxAgeHours)) {
      if (dueToFire(rules[key], nowMs, cooldownMs)) {
        rules[key] = { firedAt: nowIso };
        const age = fresh.backupAgeHours === null ? "never" : `${Math.round(fresh.backupAgeHours)}h ago`;
        await fire({
          event: "backupStale",
          title: `Database backup stale (last ${age})`,
          detail: `No successful database backup within ${alerts.backupMaxAgeHours}h — the nightly backup may have silently stopped. See /health/fleet and Settings → backups.`,
          at: nowIso,
          url: "/health/fleet",
        }).catch(() => {});
      }
    } else {
      delete rules[key];
    }
  }

  await setAppSetting(db, ALERTS_STATE_KEY, { lastSweepAt: claimed.lastSweepAt, rules });
}
