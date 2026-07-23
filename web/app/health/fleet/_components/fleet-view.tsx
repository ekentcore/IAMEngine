"use client";

// Fleet health board. SSR-first (the server passes `initial` from loadFleetHealth) then polls
// /api/health/fleet every ~25s with cache:"no-store" — the health-view pattern, no websockets. Purely
// a reader: it renders aggregated state and never mutates anything.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FleetHealthVM, FleetAgentVM } from "../_lib/loader";
import type { AgentOnlineState } from "@/lib/fleet/health";

const ONLINE_STYLE: Record<AgentOnlineState, { label: string; color: string; border: string; bg: string }> = {
  online: { label: "online", color: "#2e7d32", border: "#c4e3c8", bg: "#f1f8f2" },
  "at-risk": { label: "at risk", color: "#8a6d00", border: "#ecd24f", bg: "#fdfaed" },
  offline: { label: "offline", color: "#b3261e", border: "#f0c4c1", bg: "#fdf3f2" },
};

function Badge({ children, color, border, bg }: { children: React.ReactNode; color: string; border: string; bg: string }) {
  return <span className="badge" style={{ color, borderColor: border, background: bg }}>{children}</span>;
}

function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const MIGRATION_STYLE: Record<FleetAgentVM["migrationState"], { color: string; border: string; bg: string }> = {
  "on target": ONLINE_STYLE.online,
  pending: ONLINE_STYLE["at-risk"],
  error: ONLINE_STYLE.offline,
  unknown: { color: "#7a7a7a", border: "var(--line)", bg: "var(--bg-soft)" },
  "n/a": { color: "#7a7a7a", border: "var(--line)", bg: "var(--bg-soft)" },
};

export function FleetView({ initial }: { initial: FleetHealthVM }) {
  const [vm, setVm] = useState<FleetHealthVM>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/health/fleet", { cache: "no-store" });
      if (!res.ok) throw new Error(`refresh failed (${res.status})`);
      setVm((await res.json()) as FleetHealthVM);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, 25_000);
    return () => clearInterval(id);
  }, [refresh]);

  const healthy = vm.conditions.length === 0 && vm.db.up;
  const s = vm.agentSummary;

  return (
    <main>
      {/* Header strip — one-line verdict + firing alerts + refresh */}
      <div className="row-between">
        <div>
          <h1 style={{ margin: 0 }}>Fleet health</h1>
          <p className="note" style={{ marginTop: "0.35rem" }}>
            {healthy ? (
              <Badge {...ONLINE_STYLE.online}>Fleet healthy</Badge>
            ) : (
              <Badge {...ONLINE_STYLE.offline}>{vm.conditions.length} condition(s) need attention</Badge>
            )}
            {" "}Aggregated fleet posture — agents, queue, failures, backups, DB. Read-only.
            {" · "}last refreshed {new Date(vm.at).toLocaleTimeString()}
          </p>
          {vm.conditions.length > 0 && (
            <p className="note" style={{ color: "var(--muted)" }}>{vm.conditions.join(" · ")}</p>
          )}
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", alignSelf: "flex-start" }}>
          <button onClick={refresh} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
          <Link href="/agents" className="note" style={{ whiteSpace: "nowrap" }}>Agents →</Link>
        </div>
      </div>

      {error && <p className="note danger">{error}</p>}

      {/* Currently-firing alerts (read from alerts.state) */}
      {vm.alerts.firing.length > 0 && (
        <p className="note" style={{ marginTop: 4 }}>
          Alerts firing: {vm.alerts.firing.map((f) => `${f.key} (${ageLabel(f.firedAt)})`).join(", ")}
        </p>
      )}

      {/* Agents (feature #2 re-homing panel) */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Agents</h2>
        <p className="note" style={{ marginTop: 0 }}>
          {s.online} online · {s.atRisk} at risk · {s.offline} offline · {s.buildCurrent}/{s.total} on served build{" "}
          <code>{vm.build.short}</code>{vm.build.version ? ` (v${vm.build.version})` : ""} · {s.standby} on standby
          {vm.migrationTarget ? <> · migration target <code>{vm.migrationTarget}</code></> : null}
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "4px 8px" }}>Agent</th>
                <th style={{ padding: "4px 8px" }}>State</th>
                <th style={{ padding: "4px 8px" }}>Last seen</th>
                <th style={{ padding: "4px 8px" }}>Build</th>
                <th style={{ padding: "4px 8px" }}>Role</th>
                <th style={{ padding: "4px 8px" }}>Migration</th>
              </tr>
            </thead>
            <tbody>
              {vm.agents.map((a) => {
                const st = ONLINE_STYLE[a.onlineState];
                const mg = MIGRATION_STYLE[a.migrationState];
                return (
                  <tr key={a.id} style={{ verticalAlign: "top" }}>
                    <td style={{ padding: "4px 8px" }}>
                      <b>{a.name}</b>
                      <div className="note">{a.scope === "central" ? "central" : a.clientName ?? "client"}</div>
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <Badge {...st}>{st.label}</Badge>
                      {a.stuckPhase && <div className="note" style={{ color: "#b3261e", marginTop: 2 }}>stuck on {a.stuckPhase}</div>}
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--muted)" }}>{ageLabel(a.lastSeenAt)}</td>
                    <td style={{ padding: "4px 8px" }}>
                      {a.buildCurrent
                        ? <Badge {...ONLINE_STYLE.online}>current</Badge>
                        : <Badge {...ONLINE_STYLE.offline}>old build</Badge>}
                      <div className="note">{a.semver ? `v${a.semver}` : "—"}{a.buildShort ? ` · ${a.buildShort}` : ""}</div>
                    </td>
                    <td style={{ padding: "4px 8px", color: "var(--muted)" }}>{a.standby ? "standby" : "active"}</td>
                    <td style={{ padding: "4px 8px" }}>
                      <Badge {...mg}>{a.migrationState}</Badge>
                      {a.migrateError && <div className="note" style={{ color: "#b3261e", marginTop: 2 }}>{a.migrateError}</div>}
                    </td>
                  </tr>
                );
              })}
              {vm.agents.length === 0 && <tr><td colSpan={6} className="note" style={{ padding: "8px" }}>no enabled agents</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {/* Queue */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Queue</h2>
        <p className="note" style={{ marginTop: 0 }}>
          {vm.queue.pending} pending · {vm.queue.dispatched} dispatched · {vm.queue.running} running
          {vm.queue.oldestPendingAgeMinutes !== null ? ` · oldest pending ${vm.queue.oldestPendingAgeMinutes}m` : ""}
          {" · "}<span style={{ color: vm.queue.wedged ? "#b3261e" : "inherit" }}>{vm.queue.wedged} wedged</span>
          {" · "}<span style={{ color: vm.queue.staleDispatched ? "#b3261e" : "inherit" }}>{vm.queue.staleDispatched} stale leases</span>
          {" · "}{vm.queue.autoStopped24h} auto-stopped (24h)
        </p>
      </section>

      {/* Recent failures */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Recent failures</h2>
        <p className="note" style={{ marginTop: 0 }}>
          {vm.failures.inWindow} in the last {vm.failures.window} min · {vm.failures.last24h} in 24h
        </p>
        {vm.failures.clusters.length > 0 && (
          <ul className="note" style={{ marginTop: 4 }}>
            {vm.failures.clusters.map((c) => (
              <li key={c.key}>{c.clientName ?? "—"} · {c.systemKey} — {c.count}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Backups + DB */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Backups & database</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Backup:{" "}
          {vm.backups.backupStale
            ? <Badge {...ONLINE_STYLE.offline}>stale</Badge>
            : <Badge {...ONLINE_STYLE.online}>fresh</Badge>}
          {" "}last {ageLabel(vm.backups.lastBackupAt)}
          {vm.backups.backupAgeHours !== null ? ` (${Math.round(vm.backups.backupAgeHours)}h)` : ""}
          {" · drill "}
          {vm.backups.drillStale
            ? <Badge {...ONLINE_STYLE["at-risk"]}>stale</Badge>
            : <Badge {...ONLINE_STYLE.online}>ok</Badge>}
          {" last "}{ageLabel(vm.backups.lastDrillAt)}
        </p>
        <p className="note" style={{ marginTop: 4 }}>
          Database:{" "}
          {vm.db.up ? <Badge {...ONLINE_STYLE.online}>up</Badge> : <Badge {...ONLINE_STYLE.offline}>unreachable</Badge>}
          {" "}{vm.db.detail}
          {" — "}for per-integration credential checks see <Link href="/health">System health</Link>.
        </p>
      </section>

      <p className="note" style={{ marginTop: "1.5rem", color: "var(--muted)" }}>
        Alerts ride runner heartbeats: if the whole fleet is down, this board still renders (query-time)
        but alerts won&rsquo;t fire — external uptime monitoring is the backstop. Cooldown{" "}
        {vm.alerts.thresholds.cooldownMinutes}m; offline &gt;{vm.alerts.thresholds.agentOfflineMinutes}m.
      </p>
    </main>
  );
}
