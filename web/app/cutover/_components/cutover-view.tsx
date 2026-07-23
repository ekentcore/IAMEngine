"use client";

// Cutover console (feature #2). One guided screen that sequences the Azure move: stage → drain → push →
// live per-agent re-home board → DB verify → confirm / rollback. It only POSTs to the cutover control
// routes; the heavy lifting (the heartbeat migrate directive, the drain gate, the DB dump/restore) is
// the already-built machinery this console orchestrates. Host design system: flat, minimal borders,
// sentence case, no gradients. Live-polls (router.refresh) while a push/verify is in flight.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { CutoverVM, CutoverAgentRow } from "../_lib/loader";
import type { CutoverPhase, RehomeKind } from "@/lib/jobs/cutover";
import type { DbVerifyResult } from "@/lib/jobs/cutover-db";
import { migrationTargetMatchesCutover } from "../_lib/loader";

const CHIP: Record<RehomeKind, { color: string; border: string; bg: string; label: string }> = {
  green: { color: "#1b5e20", border: "#c4e3c8", bg: "#eef7ef", label: "re-homed" },
  pending: { color: "#8a6d00", border: "#ecd24f", bg: "#fdfaed", label: "moving" },
  red: { color: "#8e1a13", border: "#f0c4c1", bg: "#fdf3f2", label: "not re-homed" },
};

const STEPS: { phase: CutoverPhase; label: string }[] = [
  { phase: "staged", label: "1 · Stage" },
  { phase: "draining", label: "2 · Drain" },
  { phase: "pushing", label: "3 · Push to fleet" },
  { phase: "verifying-agents", label: "4 · Agents re-home" },
  { phase: "verifying-db", label: "5 · Verify DB" },
  { phase: "complete", label: "6 · Confirm" },
];
const PHASE_ORDER: CutoverPhase[] = ["idle", "staged", "draining", "pushing", "verifying-agents", "verifying-db", "complete"];

function reachChip(r: { ok: boolean; detail: string } | null) {
  if (!r) return <span className="note" style={{ color: "var(--muted)" }}>not checked</span>;
  const c = r.ok ? CHIP.green : CHIP.red;
  return <span className="badge" style={{ color: c.color, borderColor: c.border, background: c.bg }}>{r.ok ? "reachable" : "unreachable"} · {r.detail}</span>;
}

function ageLabel(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function CutoverView({ vm }: { vm: CutoverVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [azureUrl, setAzureUrl] = useState(vm.state.azureUrl || vm.migration.targetUrl || "");

  const phase = vm.state.phase;
  const live = phase === "pushing" || phase === "verifying-agents" || phase === "verifying-db";

  // Live-poll while a push/verify is in flight so the board goes green/red without a manual refresh.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [live, router]);

  const post = useCallback(async (url: string, body: unknown, label: string) => {
    setBusy(label); setError(null); setMsg(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `${label} failed (${res.status})`);
      router.refresh();
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, [router]);

  const act = useCallback((action: string, extra: Record<string, unknown> = {}, label = action) => post("/api/admin/cutover", { action, ...extra }, label), [post]);

  // Drain delegates to feature #7's maintenance endpoint — this console does not own draining.
  const drain = useCallback(() => post("/api/admin/maintenance", { global: true, reason: "Azure cutover" }, "drain"), [post]);
  const verifyDb = useCallback(async () => {
    setBusy("verify"); setError(null); setMsg("Recounting rows and sampling Delinea from this host…");
    try {
      const res = await fetch("/api/admin/cutover/db-verify", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = (await res.json().catch(() => ({}))) as { error?: string; result?: DbVerifyResult };
      if (!res.ok) throw new Error(j.error ?? `verify failed (${res.status})`);
      setMsg(j.result?.ok ? "Database verification passed." : "Database verification found problems — see the panel.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [router]);

  const targetMatches = migrationTargetMatchesCutover(vm);
  const dv = vm.state.dbVerify;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1 style={{ margin: 0 }}>Azure cutover</h1>
          <p className="note" style={{ marginTop: "0.35rem", maxWidth: 780 }}>
            Guided, verified, reversible move of the brain from the Mac to Azure. It orchestrates the
            existing re-homing directive, feature #7&rsquo;s drain, and the pg_dump/restore verification —
            never dispatching a job. The old app stays up as a redirect &ldquo;lighthouse&rdquo; so stragglers
            re-home. For the ongoing live board see <Link href="/health/fleet">Fleet health</Link>.
          </p>
        </div>
        <button onClick={() => router.refresh()} disabled={Boolean(busy)}>{busy ? "Working…" : "Refresh"}</button>
      </div>

      {/* Phase stepper */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "1rem 0" }}>
        {STEPS.map((s) => {
          const done = PHASE_ORDER.indexOf(phase) > PHASE_ORDER.indexOf(s.phase);
          const cur = phase === s.phase || (s.phase === "verifying-agents" && phase === "pushing");
          const rolled = phase === "rolled-back";
          const bg = rolled ? "var(--bg-soft)" : cur ? "#eef4fd" : done ? "#eef7ef" : "var(--bg-soft)";
          const color = rolled ? "var(--muted)" : cur ? "#1a4fa0" : done ? "#1b5e20" : "var(--muted)";
          const border = cur ? "#b9d0f2" : done ? "#c4e3c8" : "var(--line)";
          return <span key={s.phase} className="badge" style={{ background: bg, color, borderColor: border }}>{done ? "✓ " : ""}{s.label}</span>;
        })}
        {phase === "rolled-back" && <span className="badge" style={{ background: "#fdf3f2", color: "#8e1a13", borderColor: "#f0c4c1" }}>rolled back</span>}
        {phase === "complete" && <span className="badge" style={{ background: "#eef7ef", color: "#1b5e20", borderColor: "#c4e3c8" }}>✓ cutover complete</span>}
      </div>

      {error && <p className="note danger" style={{ marginTop: 8 }}>{error}</p>}
      {msg && <p className="note" style={{ marginTop: 8, color: "var(--muted)" }}>{msg}</p>}
      {!targetMatches && (
        <p className="note danger" style={{ marginTop: 8 }}>
          Warning: the live migration target ({vm.migration.targetUrl ?? "unset"}) doesn&rsquo;t match this cutover&rsquo;s
          expected URL — something changed agent_migration out of band. The console should be the sole driver during the window.
        </p>
      )}

      {/* Stage */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Stage</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Capture the new Azure URL and the fleet&rsquo;s current common URL (for rollback), and write the DB baseline into
          the database so it travels inside pg_dump.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="url" placeholder="https://iam.your-azure-domain.com" value={azureUrl}
            onChange={(e) => setAzureUrl(e.target.value)} disabled={!vm.gates.canStage || Boolean(busy)}
            style={{ minWidth: 340, padding: "6px 8px" }}
          />
          <button onClick={() => act("stage", { azureUrl }, "stage")} disabled={!vm.gates.canStage || Boolean(busy) || !azureUrl.trim()}>
            {busy === "stage" ? "Staging…" : vm.state.stagedAt ? "Re-stage" : "Stage Azure URL"}
          </button>
        </div>
        {vm.state.oldUrl && (
          <p className="note" style={{ marginTop: 6 }}>
            Rollback target (captured): <code>{vm.state.oldUrl}</code> · {reachChip(vm.oldHostReachable)}
          </p>
        )}
        {vm.state.baseline && (
          <p className="note" style={{ marginTop: 4, color: "var(--muted)" }}>
            Baseline captured {ageLabel(vm.state.baseline.capturedAt)}: {Object.keys(vm.state.baseline.tables).length} tables,
            {" "}{vm.state.baseline.secretCount} secret references (hash {vm.state.baseline.secretRefHash.slice(0, 12)}…).
            Take the pg_dump now, restore it on Azure, then run step 5 there.
          </p>
        )}
        {vm.azureHostReachable && <p className="note" style={{ marginTop: 4 }}>Azure host: {reachChip(vm.azureHostReachable)}</p>}
      </section>

      {/* Drain */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Drain</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Freeze dispatch on the old host and let in-flight work finish before pushing the fleet (feature #7). This is the
          structural split-brain guard.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={drain} disabled={vm.drain.global || Boolean(busy)}>{vm.drain.global ? "Drain engaged" : "Engage global drain"}</button>
          <span className="note">
            {vm.drain.global
              ? vm.drain.quiesced ? "✓ quiesced — 0 in flight" : `draining… ${vm.drain.inFlight} in flight`
              : "dispatch is live"}
          </span>
          <Link href="/settings" className="note">manage in settings →</Link>
        </div>
      </section>

      {/* Push */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Push to fleet</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Point the migration directive at the Azure URL. Every agent re-homes on its next heartbeat (verify → rewrite its
          supervisor entry → relaunch). Re-running is a harmless no-op.
        </p>
        <button onClick={() => act("push", {}, "push")} disabled={!vm.gates.canPush || Boolean(busy)}>
          {busy === "push" ? "Pushing…" : "Push to fleet"}
        </button>
        {vm.gates.pushBlockedReason && <span className="note danger" style={{ marginLeft: 10 }}>{vm.gates.pushBlockedReason}</span>}
        {vm.state.pushedAt && <span className="note" style={{ marginLeft: 10, color: "var(--muted)" }}>pushed {ageLabel(vm.state.pushedAt)}</span>}
      </section>

      {/* Agent re-home board */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Agents re-homing</h2>
        <p className="note" style={{ marginTop: 0 }}>
          {vm.summary.green} of {vm.summary.total} re-homed · {vm.summary.red} not re-homed
          {vm.summary.offlineUnconverged > 0 ? ` (${vm.summary.offlineUnconverged} offline)` : ""} · {vm.summary.pending} moving
          {live ? " · live" : ""}
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "4px 8px", width: 110 }}>State</th>
                <th style={{ padding: "4px 8px" }}>Agent</th>
                <th style={{ padding: "4px 8px" }}>Current URL</th>
                <th style={{ padding: "4px 8px" }}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {vm.agents.map((a: CutoverAgentRow) => {
                const c = CHIP[a.kind];
                return (
                  <tr key={a.agentId} style={{ verticalAlign: "top" }}>
                    <td style={{ padding: "4px 8px" }}><span className="badge" style={{ color: c.color, borderColor: c.border, background: c.bg }}>{c.label}</span></td>
                    <td style={{ padding: "4px 8px" }}>
                      <b>{a.name}</b>
                      <div className="note">{a.clientName ?? a.scope}</div>
                      {a.statusLabel && <div className="note" style={{ color: "var(--muted)" }}>{a.statusLabel}</div>}
                    </td>
                    <td style={{ padding: "4px 8px" }}><code className="note">{a.currentAppUrl ?? "—"}</code></td>
                    <td style={{ padding: "4px 8px" }} className="note">{ageLabel(a.lastSeenAt)}</td>
                  </tr>
                );
              })}
              {vm.agents.length === 0 && <tr><td colSpan={4} className="note" style={{ padding: 8 }}>no enabled agents</td></tr>}
            </tbody>
          </table>
        </div>
        {vm.summary.offlineUnconverged > 0 && !vm.state.acknowledgedStragglers && (phase === "pushing" || phase === "verifying-agents" || phase === "verifying-db") && (
          <p className="note" style={{ marginTop: 8 }}>
            {vm.summary.offlineUnconverged} agent(s) are offline and can&rsquo;t re-home right now. The lighthouse keeps serving
            the directive so they move when they surface.{" "}
            <button onClick={() => act("ackStragglers", {}, "ack")} disabled={Boolean(busy)}>Acknowledge stragglers</button>
          </p>
        )}
        {vm.state.acknowledgedStragglers && <p className="note" style={{ marginTop: 6, color: "var(--muted)" }}>offline stragglers acknowledged — they may re-home later via the lighthouse</p>}
      </section>

      {/* DB verify */}
      <section style={{ marginTop: "1.25rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Verify the database move</h2>
        <p className="note" style={{ marginTop: 0 }}>
          Run this <b>on the Azure app</b> after the restore. It recounts every table and re-hashes the Secret→Delinea
          references against the carried baseline, then samples whether secrets still resolve <b>from this host</b>.
        </p>
        <button onClick={verifyDb} disabled={!vm.state.baseline || Boolean(busy)}>{busy === "verify" ? "Verifying…" : dv ? "Re-run DB verify" : "Verify DB"}</button>
        {!vm.state.baseline && <span className="note" style={{ marginLeft: 10, color: "var(--muted)" }}>no baseline yet — stage first</span>}
        {dv && (
          <div style={{ marginTop: 10, border: `1px solid ${dv.ok ? "#c4e3c8" : "#f0c4c1"}`, background: dv.ok ? "#eef7ef" : "#fdf3f2", borderRadius: 8, padding: "0.75rem 1rem" }}>
            <div style={{ fontWeight: 700, color: dv.ok ? "#1b5e20" : "#8e1a13" }}>{dv.ok ? "PASS — the move verifies" : "NOT VERIFIED"}</div>
            {dv.note && <div className="note" style={{ marginTop: 2 }}>{dv.note}</div>}
            <div className="note" style={{ marginTop: 4 }}>
              Secret references: {dv.secretRefMatch ? "✓ match" : "✗ changed"} · Delinea from this host:{" "}
              {!dv.delineaConfigured ? "not configured" : !dv.delineaReachable ? "⚠ NOT REACHABLE (D1)" : `${dv.resolvable}/${dv.sampled} resolvable`}
              {dv.unresolvable.length > 0 && ` · ${dv.unresolvable.length} unresolvable`}
            </div>
            {dv.unresolvable.length > 0 && (
              <ul className="note" style={{ marginTop: 4 }}>
                {dv.unresolvable.slice(0, 12).map((u, i) => <li key={i}>{u.name}{u.clientId ? ` (${u.clientId})` : ""}: {u.error}</li>)}
              </ul>
            )}
            <details style={{ marginTop: 6 }}>
              <summary className="note">Per-table counts ({dv.tables.length})</summary>
              <div style={{ overflowX: "auto", marginTop: 6 }}>
                <table style={{ fontSize: 12 }}>
                  <thead><tr style={{ textAlign: "left" }}><th style={{ padding: "2px 8px" }}>Table</th><th style={{ padding: "2px 8px" }}>Baseline</th><th style={{ padding: "2px 8px" }}>Current</th><th style={{ padding: "2px 8px" }}>Δ</th></tr></thead>
                  <tbody>
                    {dv.tables.map((t) => (
                      <tr key={t.name} style={{ color: t.ok ? undefined : "#8e1a13" }}>
                        <td style={{ padding: "2px 8px" }}>{t.name}</td>
                        <td style={{ padding: "2px 8px" }}>{t.baseline}</td>
                        <td style={{ padding: "2px 8px" }}>{t.current}</td>
                        <td style={{ padding: "2px 8px" }}>{t.delta === 0 ? "—" : (t.delta > 0 ? `+${t.delta}` : t.delta)}{t.status !== "match" ? ` (${t.status})` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
            <div className="note" style={{ marginTop: 4, color: "var(--muted)" }}>verified {ageLabel(dv.at)}</div>
          </div>
        )}
      </section>

      {/* Confirm / rollback */}
      <section style={{ marginTop: "1.5rem", borderTop: "1px solid var(--line)", paddingTop: "1rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Finish</h2>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={() => act("confirm", {}, "confirm")} disabled={!vm.gates.canConfirm || Boolean(busy)}>
            {busy === "confirm" ? "Confirming…" : "Confirm cutover"}
          </button>
          {vm.gates.confirmBlockedReason && phase !== "complete" && <span className="note" style={{ color: "var(--muted)" }}>{vm.gates.confirmBlockedReason}</span>}
          <button onClick={() => act("rollback", {}, "rollback")} disabled={!vm.gates.canRollback || Boolean(busy)} style={{ marginLeft: "auto" }}>
            {busy === "rollback" ? "Rolling back…" : "Roll back to old host"}
          </button>
          {vm.gates.rollbackBlockedReason && <span className="note danger">{vm.gates.rollbackBlockedReason}</span>}
        </div>
        {phase === "complete" && <p className="note" style={{ marginTop: 8, color: "#1b5e20" }}>Cutover confirmed {ageLabel(vm.state.completedAt)}. The migration directive stays enabled so late/offline agents still re-home via the lighthouse.</p>}
        {phase === "rolled-back" && <p className="note" style={{ marginTop: 8 }}>Rolled back {ageLabel(vm.state.rolledBackAt)} — agents are re-homing to <code>{vm.state.oldUrl}</code>. Re-stage to try again.</p>}
      </section>
    </main>
  );
}
