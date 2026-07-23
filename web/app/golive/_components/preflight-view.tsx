"use client";

// Go-live readiness report. Purely a reader: it renders the verdict banner, the global-check table,
// and the per-client table (NO-GO first, expandable). Two explicit actions — "Re-run checks"
// (router.refresh() re-runs the server loader) and "Run fresh M365 sweep" (POSTs the existing
// /api/tools/fleet-m365, polls its GET to advance, then refreshes). NOTHING dispatches on load.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useState } from "react";
import type { GoLiveVM } from "../_lib/loader";
import type { CheckResult, Verdict } from "@/lib/golive/checks";
import type { OverallVerdict } from "@/lib/golive/rollup";

const CHIP: Record<Verdict, { label: string; color: string; border: string; bg: string }> = {
  pass: { label: "pass", color: "#2e7d32", border: "#c4e3c8", bg: "#f1f8f2" },
  warn: { label: "warn", color: "#8a6d00", border: "#ecd24f", bg: "#fdfaed" },
  fail: { label: "fail", color: "#b3261e", border: "#f0c4c1", bg: "#fdf3f2" },
  na: { label: "n/a", color: "#7a7a7a", border: "var(--line)", bg: "var(--bg-soft)" },
};

const BANNER: Record<OverallVerdict, { label: string; color: string; border: string; bg: string }> = {
  GO: { label: "GO", color: "#1b5e20", border: "#c4e3c8", bg: "#eef7ef" },
  GO_WITH_WARNINGS: { label: "GO WITH WARNINGS", color: "#7a5c00", border: "#ecd24f", bg: "#fdfaed" },
  NO_GO: { label: "NO-GO", color: "#8e1a13", border: "#f0c4c1", bg: "#fdf3f2" },
};

function Chip({ v }: { v: Verdict }) {
  const c = CHIP[v];
  return <span className="badge" style={{ color: c.color, borderColor: c.border, background: c.bg }}>{c.label}</span>;
}

function ageLabel(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function CheckRow({ c }: { c: CheckResult }) {
  return (
    <tr style={{ verticalAlign: "top" }}>
      <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}><Chip v={c.verdict} /></td>
      <td style={{ padding: "4px 8px" }}>
        <b>{c.headline}</b>
        <span className="note" style={{ marginLeft: 8, color: "var(--muted)" }}>{c.liveness === "cached" ? "cached" : "live"}</span>
        <div className="note" style={{ marginTop: 2 }}>{c.detail}</div>
        {c.remediation && (c.verdict === "warn" || c.verdict === "fail") && (
          <div className="note" style={{ marginTop: 2, color: c.verdict === "fail" ? "#b3261e" : "#8a6d00" }}>→ {c.remediation}</div>
        )}
      </td>
    </tr>
  );
}

export function PreflightView({ vm }: { vm: GoLiveVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const rerun = useCallback(() => {
    setBusy(true); setError(null); setMsg(null);
    router.refresh();
    // router.refresh resolves without a promise we can await; drop the spinner shortly after.
    setTimeout(() => setBusy(false), 1200);
  }, [router]);

  // Explicit, guarded fresh sweep — reuses the fleet-m365 lifecycle. Starts a sweep, polls its GET to
  // advance until the run settles (bounded), then refreshes the preflight to read the fresh cached rows.
  const runSweep = useCallback(async () => {
    setSweeping(true); setError(null); setMsg("Starting fresh M365 sweep…");
    try {
      const res = await fetch("/api/tools/fleet-m365", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (res.status === 409) { setMsg("A fleet M365 sweep is already running — polling it…"); }
      else if (!res.ok) throw new Error(`could not start sweep (${res.status})`);
      // Poll GET to advance the run (advance-on-poll), bounded so a stuck sweep never hangs the UI.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const g = await fetch("/api/tools/fleet-m365", { cache: "no-store" });
        if (!g.ok) break;
        const rollup = (await g.json()) as { run: { status: string } | null };
        setMsg(`Sweep in progress… (${i * 5}s)`);
        if (!rollup.run || rollup.run.status !== "running") break;
      }
      setMsg("Sweep settled — refreshing the report.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSweeping(false);
    }
  }, [router]);

  const b = BANNER[vm.overall.verdict];
  const { blockingFailures, warnings, clientsNotReady } = vm.overall;

  return (
    <main>
      <div className="row-between">
        <div>
          <h1 style={{ margin: 0 }}>Go-live readiness</h1>
          <p className="note" style={{ marginTop: "0.35rem", maxWidth: 760 }}>
            One point-in-time gate before the first real Azure case: every readiness signal — integrations, runners,
            migrations, backups, and per-client credential + agent state — rolled into a single verdict. Read-only;
            this page dispatches nothing. For the ongoing live board see <Link href="/health/fleet">Fleet health</Link>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", alignSelf: "flex-start" }}>
          {vm.canRunSweep && <button onClick={runSweep} disabled={sweeping || busy}>{sweeping ? "Sweeping…" : "Run fresh M365 sweep"}</button>}
          <button onClick={rerun} disabled={busy || sweeping}>{busy ? "Re-running…" : "Re-run checks"}</button>
        </div>
      </div>

      {/* Verdict banner */}
      <div style={{ marginTop: "1rem", border: `1px solid ${b.border}`, background: b.bg, borderRadius: 8, padding: "0.9rem 1.1rem" }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: b.color }}>{b.label}</div>
        <div className="note" style={{ marginTop: 4 }}>
          {blockingFailures} blocking failure(s) · {warnings} warning(s) · {clientsNotReady} client(s) not ready
          {" · snapshot "}{new Date(vm.at).toLocaleString()}
        </div>
        <div className="note" style={{ marginTop: 2, color: "var(--muted)" }}>
          M365 sweep: last {ageLabel(vm.m365SweepAgeMs)}{vm.m365SweepStale ? " — stale, run a fresh sweep for a confident GO" : ""}
        </div>
      </div>

      {error && <p className="note danger" style={{ marginTop: 8 }}>{error}</p>}
      {msg && <p className="note" style={{ marginTop: 8, color: "var(--muted)" }}>{msg}</p>}

      {/* Global checks */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Global checks</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "4px 8px", width: 70 }}>Verdict</th>
                <th style={{ padding: "4px 8px" }}>Check</th>
              </tr>
            </thead>
            <tbody>
              {vm.global.map((c) => <CheckRow key={c.id} c={c} />)}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-client checks */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>Per-client readiness</h2>
        <p className="note" style={{ marginTop: 0 }}>{vm.clients.length} in-scope client(s). Expand a row for its individual checks.</p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "4px 8px", width: 70 }}>Verdict</th>
                <th style={{ padding: "4px 8px" }}>Client</th>
                <th style={{ padding: "4px 8px" }}>Checks</th>
              </tr>
            </thead>
            <tbody>
              {vm.clients.map((c) => {
                const open = expanded.has(c.slug);
                return (
                  <Fragment key={c.slug}>
                    <tr style={{ verticalAlign: "top", cursor: "pointer" }} onClick={() => setExpanded((prev) => { const n = new Set(prev); if (n.has(c.slug)) n.delete(c.slug); else n.add(c.slug); return n; })}>
                      <td style={{ padding: "4px 8px" }}><Chip v={c.verdict} /></td>
                      <td style={{ padding: "4px 8px" }}>
                        <b>{c.name}</b>
                        <div className="note"><Link href={`/clients/${c.slug}`} onClick={(e) => e.stopPropagation()}>{c.slug}</Link></div>
                      </td>
                      <td style={{ padding: "4px 8px" }}>
                        {c.checks.map((ck) => (
                          <span key={ck.id} style={{ marginRight: 6, whiteSpace: "nowrap" }}>
                            <Chip v={ck.verdict} /> <span className="note">{ck.headline.toLowerCase()}</span>
                          </span>
                        ))}
                        <span className="note" style={{ marginLeft: 4, color: "var(--muted)" }}>{open ? "▲" : "▼"}</span>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td />
                        <td colSpan={2} style={{ padding: "0 8px 8px" }}>
                          <table style={{ width: "100%", fontSize: 13 }}>
                            <tbody>{c.checks.map((ck) => <CheckRow key={ck.id} c={ck} />)}</tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {vm.clients.length === 0 && <tr><td colSpan={3} className="note" style={{ padding: "8px" }}>no in-scope, modeled clients to gate</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
