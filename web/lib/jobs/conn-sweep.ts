// Scheduled fleet-wide connection-test sweep + credential-expiry alerts. No cron exists in this
// app — like every periodic task, this rides the runner-heartbeat sweep chain (procurement-watch),
// gated by a DURABLE AppSetting throttle (an in-process timestamp would double-fire after a
// redeploy and skip after a restart; a daily job can't tolerate either):
//
//   enabled + interval elapsed -> claim the run via a CONDITIONAL AppSetting update (exact-match on
//   the old JSON — a racing instance's update matches zero rows), then enqueue conn-tests in client
//   BATCHES (cursor persisted in the setting, resumable) so ~200 clients spread over ~10 minutes of
//   heartbeat ticks instead of one thundering herd against Delinea and the vendors.
//
// New-failure detection is EVENT-DRIVEN, not sweep-coordinated: reportConnectionTest upserts the
// durable ConnHealthState snapshot on every result (ConnectionTest rows are deleted per run, so
// history can't live there). Sweep-sourced NEW failures set pendingNotifyAt; each sweep tick
// flushes them — ≤3 as individual notifications (with the client's own routing), more as ONE
// digest — so a fleet-wide outage is one message, not two hundred. failNotifiedAt suppresses
// repeats until the system recovers. Manual tests update the snapshot but never notify (the
// operator is watching the panel).
import type { PrismaClient } from "@prisma/client";
import { getAppSetting, setAppSetting } from "../settings";
import { fireNotification } from "../notifications/sender";
import { NOTIFICATIONS_SETTING_KEY, normalizeSettings, parseClientOverride } from "../notifications/types";

export const CONN_SWEEP_KEY = "conn_test_sweep";

export type ConnSweepSetting = {
  enabled: boolean;
  intervalHours?: number; // default 24
  lastStartedAt?: string; // ISO — the durable throttle
  cursorClientId?: string | null; // batching cursor; non-null = an enqueue pass is in progress
  lastFinishedAt?: string;
  lastSummary?: { clients: number; tests: number; newFailures: number };
};

export function normalizeConnSweep(raw: unknown): ConnSweepSetting {
  const r = (raw ?? {}) as Partial<ConnSweepSetting>;
  return {
    enabled: Boolean(r.enabled),
    intervalHours: typeof r.intervalHours === "number" && r.intervalHours >= 1 ? Math.floor(r.intervalHours) : 24,
    lastStartedAt: typeof r.lastStartedAt === "string" ? r.lastStartedAt : undefined,
    cursorClientId: typeof r.cursorClientId === "string" ? r.cursorClientId : r.cursorClientId === null ? null : undefined,
    lastFinishedAt: typeof r.lastFinishedAt === "string" ? r.lastFinishedAt : undefined,
    lastSummary: r.lastSummary,
  };
}

// Is a new sweep RUN due (as opposed to continuing an in-progress cursor)?
export function sweepDue(s: ConnSweepSetting, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.cursorClientId !== undefined && s.cursorClientId !== null) return false; // continue, don't restart
  if (!s.lastStartedAt) return true;
  const elapsed = now.getTime() - Date.parse(s.lastStartedAt);
  return elapsed >= (s.intervalHours ?? 24) * 3_600_000;
}

// Pure transition classifier for the durable snapshot.
export function diffConnOutcome(
  prev: { lastStatus: string } | null,
  next: { passed: boolean }
): "new_failure" | "recovered" | "unchanged" {
  if (!next.passed) return !prev || prev.lastStatus === "ok" ? "new_failure" : "unchanged";
  return prev && prev.lastStatus === "fail" ? "recovered" : "unchanged";
}

// Storm guard: a handful of failures notify individually (each with its client's own routing);
// more than that collapse into one digest to the DEFAULT destinations.
export type ConnFailure = { clientName: string; systemKey: string; detail: string | null; restricted: boolean; override: unknown };
export function planConnNotifications(
  failures: ConnFailure[],
  maxIndividual = 3
): { kind: "individual"; items: ConnFailure[] } | { kind: "digest"; count: number; clients: number; sample: ConnFailure[] } | { kind: "none" } {
  if (failures.length === 0) return { kind: "none" };
  if (failures.length <= maxIndividual) return { kind: "individual", items: failures };
  return { kind: "digest", count: failures.length, clients: new Set(failures.map((f) => f.clientName)).size, sample: failures.slice(0, 5) };
}

const BATCH_CLIENTS = 25;
const EXPIRY_RENOTIFY_MS = 7 * 24 * 3_600_000; // renotify a still-expiring credential weekly

// Heartbeats arrive every ~5s from every runner; self-throttle so this only touches the DB about
// once a minute (the sibling sweeps do the same). Delays a failure/expiry alert by <1 min at worst.
let lastTickAt = 0;
const TICK_EVERY_MS = 45_000;

// The heartbeat-driven entry point. Never throws (chained fire-and-forget off procurement-watch).
export async function sweepConnTests(
  db: PrismaClient,
  deps: {
    // Injected so the sweep is testable and reuses the SAME enqueue path as the operator button.
    enqueueClient: (clientSlug: string) => Promise<{ tests: { systemKey: string }[] }>;
    now?: () => Date;
  }
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const tick = now().getTime();
  if (tick - lastTickAt < TICK_EVERY_MS) return; // in-process throttle, before any DB work
  lastTickAt = tick;
  const raw = await getAppSetting<unknown>(db, CONN_SWEEP_KEY);
  const s = normalizeConnSweep(raw);
  if (!s.enabled) return;

  const inProgress = typeof s.cursorClientId === "string";
  if (!inProgress && !sweepDue(s, now())) {
    // No enqueue work — but pending notifications/expiry alerts still flush on the tick.
    await flushConnNotifications(db, now()).catch(() => {});
    return;
  }

  // Claim (or continue) the run with a conditional update: only one instance wins a given step.
  const claimed: ConnSweepSetting = inProgress
    ? s
    : { ...s, lastStartedAt: now().toISOString(), cursorClientId: "" };
  const won = await claimSetting(db, raw, claimed);
  if (!won) return;

  // One batch of clients per tick, resuming from the cursor.
  const after = claimed.cursorClientId || "";
  const clients = await db.client.findMany({
    where: { status: "active", systems: { some: {} }, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: "asc" },
    take: BATCH_CLIENTS,
    select: { id: true, slug: true },
  });
  let tests = 0;
  for (const c of clients) {
    // Never clobber an in-flight manual test run for this client.
    const busy = await db.connectionTest.count({ where: { clientId: c.id, status: { in: ["pending", "running"] } } });
    if (busy > 0) continue;
    try {
      const out = await deps.enqueueClient(c.slug);
      tests += out.tests.length;
      // Sweep-sourced rows notify on NEW failures; the operator button's don't.
      await db.connectionTest.updateMany({ where: { clientId: c.id, status: "pending" }, data: { source: "sweep" } });
    } catch {
      // one bad client must not stall the fleet
    }
  }

  const prevSummary = claimed.lastSummary ?? { clients: 0, tests: 0, newFailures: 0 };
  const done = clients.length < BATCH_CLIENTS;
  const next: ConnSweepSetting = {
    ...claimed,
    cursorClientId: done ? null : clients[clients.length - 1].id,
    ...(done ? { lastFinishedAt: now().toISOString() } : {}),
    lastSummary: inProgress
      ? { clients: prevSummary.clients + clients.length, tests: prevSummary.tests + tests, newFailures: prevSummary.newFailures }
      : { clients: clients.length, tests, newFailures: 0 },
  };
  await setAppSetting(db, CONN_SWEEP_KEY, next);
  await flushConnNotifications(db, now()).catch(() => {});
}

// Conditional claim: update the setting row only if it still holds the value we read. AppSetting
// stores JSON, so "still equals what we read" is checked by re-reading inside a transaction.
async function claimSetting(db: PrismaClient, expected: unknown, next: ConnSweepSetting): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.appSetting.findUnique({ where: { key: CONN_SWEEP_KEY }, select: { value: true } });
      // AppSetting.value is JSON-as-TEXT (see lib/settings.ts). Parse it before comparing, or we'd
      // stringify a raw string on one side and an object on the other — they'd never match and the
      // claim would always fail (the sweep would never run).
      let current: unknown = null;
      if (row) { try { current = JSON.parse(row.value); } catch { current = null; } }
      if (JSON.stringify(current) !== JSON.stringify(expected ?? null)) return false; // someone else moved it
      // AppSetting.value is a String column — store JSON TEXT. Passing the object made Prisma
      // throw, the catch below swallowed it, and the claim never won: the sweep never ran.
      const v = JSON.stringify(next);
      await tx.appSetting.upsert({
        where: { key: CONN_SWEEP_KEY },
        update: { value: v },
        create: { key: CONN_SWEEP_KEY, value: v },
      });
      return true;
    });
  } catch {
    return false;
  }
}

// Flush pending new-failure notifications (individual vs digest) and credential-expiry alerts.
export async function flushConnNotifications(db: PrismaClient, now: Date): Promise<void> {
  const settings = normalizeSettings(await getAppSetting(db, NOTIFICATIONS_SETTING_KEY));

  // --- New sweep-detected failures ---------------------------------------------------------------
  const pending = await db.connHealthState.findMany({
    where: { pendingNotifyAt: { not: null } },
    select: { id: true, systemKey: true, lastDetail: true, client: { select: { name: true, restricted: true, notifyOverride: true } } },
    take: 200,
  });
  if (pending.length > 0) {
    const failures: ConnFailure[] = pending.map((p) => ({
      clientName: p.client.name,
      systemKey: p.systemKey,
      detail: p.lastDetail,
      restricted: p.client.restricted,
      override: p.client.notifyOverride,
    }));
    const plan = planConnNotifications(failures);
    if (plan.kind === "individual") {
      for (const f of plan.items) {
        await fireNotification({
          event: "connTestFailed",
          title: `Connection test failed: ${f.clientName} · ${f.systemKey}`,
          clientName: f.clientName,
          systemKey: f.systemKey,
          detail: f.detail,
          at: now.toISOString(),
          url: "/health/connections",
          restricted: f.restricted,
          override: parseClientOverride(f.override),
        }).catch(() => {});
      }
    } else if (plan.kind === "digest") {
      const sample = plan.sample.map((f) => `${f.clientName}/${f.systemKey}`).join(", ");
      await fireNotification({
        event: "connTestFailed",
        title: `Connection sweep: ${plan.count} systems failing across ${plan.clients} clients`,
        detail: `e.g. ${sample} — see /health/connections`,
        at: now.toISOString(),
        url: "/health/connections",
      }).catch(() => {});
    }
    await db.connHealthState.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { pendingNotifyAt: null, failNotifiedAt: now },
    });
  }

  // --- Credential expiry --------------------------------------------------------------------------
  const horizon = new Date(now.getTime() + (settings.credExpiryDays ?? 30) * 24 * 3_600_000);
  const renotifyBefore = new Date(now.getTime() - EXPIRY_RENOTIFY_MS);
  const [expiringSecrets, expiringCreds] = await Promise.all([
    db.secret.findMany({
      where: {
        expiresAt: { not: null, lt: horizon },
        OR: [{ expiryNotifiedAt: null }, { expiryNotifiedAt: { lt: renotifyBefore } }],
      },
      select: { id: true, name: true, expiresAt: true, client: { select: { name: true, restricted: true, notifyOverride: true } } },
      take: 20,
    }),
    db.connHealthState.findMany({
      where: {
        credExpiresAt: { not: null, lt: horizon },
        OR: [{ expiryNotifiedAt: null }, { expiryNotifiedAt: { lt: renotifyBefore } }],
      },
      select: { id: true, systemKey: true, credExpiresAt: true, client: { select: { name: true, restricted: true, notifyOverride: true } } },
      take: 20,
    }),
  ]);
  for (const sec of expiringSecrets) {
    const days = Math.max(0, Math.round((sec.expiresAt!.getTime() - now.getTime()) / 86_400_000));
    await fireNotification({
      event: "credExpiring",
      title: `Credential expiring: ${sec.client.name} · ${sec.name} (${days}d)`,
      clientName: sec.client.name,
      detail: `Delinea secret '${sec.name}' expires ${sec.expiresAt!.toISOString().slice(0, 10)}`,
      at: now.toISOString(),
      restricted: sec.client.restricted,
      override: parseClientOverride(sec.client.notifyOverride),
    }).catch(() => {});
    await db.secret.update({ where: { id: sec.id }, data: { expiryNotifiedAt: now } }).catch(() => {});
  }
  for (const ch of expiringCreds) {
    const days = Math.max(0, Math.round((ch.credExpiresAt!.getTime() - now.getTime()) / 86_400_000));
    await fireNotification({
      event: "credExpiring",
      title: `App credential expiring: ${ch.client.name} · ${ch.systemKey} (${days}d)`,
      clientName: ch.client.name,
      systemKey: ch.systemKey,
      detail: `The ${ch.systemKey} app credential expires ${ch.credExpiresAt!.toISOString().slice(0, 10)} (reported by the connection test)`,
      at: now.toISOString(),
      restricted: ch.client.restricted,
      override: parseClientOverride(ch.client.notifyOverride),
    }).catch(() => {});
    await db.connHealthState.update({ where: { id: ch.id }, data: { expiryNotifiedAt: now } }).catch(() => {});
  }
}
