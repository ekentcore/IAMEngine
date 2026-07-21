"use client";

// Fleet-wide automated M365 setup: a dry-run eligibility preview and a real sweep across every client
// with a wired m365-global-admin GA-login secret. Polls the run roll-up (n/total, succeeded/skipped/failed).
import { useCallback, useEffect, useRef, useState } from "react";

type Run = { id: string; status: string; dryRun: boolean; total: number; completed: number; succeeded: number; skipped: number; failed: number; error?: string | null };
type Row = { slug: string; name: string; status: string; stage?: string | null; appId?: string | null; error?: string | null; warnings?: string[]; skipReason?: string | null };

export function M365SetupFleet() {
  const [run, setRun] = useState<Run | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/m365-setup`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setRun(d.run ?? null); setRows(d.clients ?? []);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    if (!run) return;
    if (timer.current) clearTimeout(timer.current);
    if (run.status === "running") timer.current = setTimeout(load, 4000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [run, load]);
  useEffect(() => { void load(); }, [load]);

  async function start(dryRun: boolean) {
    if (!dryRun && !confirm("Run automated M365 setup across every eligible client? This creates app registrations and writes credentials.")) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/m365-setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) { setError(d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  // Emergency stop for the sweep: cancels the run server-side (in-flight browser job included) and
  // stops the poll on the refreshed "cancelled" status.
  async function cancelRun() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/m365-setup`, { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 409) { setError(d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const running = run?.status === "running";
  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Automated M365 setup</h2>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button disabled={busy || running} onClick={() => start(true)}>Dry run (preview eligible)</button>
        <button disabled={busy || running} onClick={() => start(false)}>Run setup across the fleet</button>
        {running && <button disabled={busy} onClick={() => void cancelRun()}>Cancel run</button>}
        {run && <span className="note">{run.dryRun ? "preview" : "run"}: {run.completed}/{run.total} · {run.succeeded} ok · {run.skipped} skipped · {run.failed} failed{running ? " · running…" : run.status === "cancelled" ? " · cancelled" : ""}</span>}
        {error && <span className="note" style={{ color: "#b91c1c" }}>{error}</span>}
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
          {rows.filter((r) => r.status === "failed" || r.status === "skipped").map((r) => (
            <div key={r.slug}>{r.name} — {r.status}{r.status === "failed" ? `: ${r.error ?? r.stage}${r.warnings?.length ? ` (${r.warnings[0]})` : ""}` : `: ${r.skipReason ?? ""}`}</div>
          ))}
        </div>
      )}
    </section>
  );
}
