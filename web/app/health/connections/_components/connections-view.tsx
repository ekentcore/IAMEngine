"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type Row = {
  client: string; slug: string; systemKey: string;
  status: string; detail: string | null; accessOk: boolean | null;
  rightsMissing: number; rightsUnverified: number; credExpiresAt: string | null;
  onPrem: boolean; finishedAt: string | null; claimedAt: string | null;
};

// A test's display state: terminal ok/fail, or "running"/"pending" (with a note when an on-prem test
// is waiting on a client agent that may be offline).
function phase(r: Row): { label: string; color: string } {
  if (r.status === "ok") return { label: "✓ ok", color: "#15803d" };
  if (r.status === "fail") return { label: "✗ fail", color: "#b91c1c" };
  if (r.status === "running") return { label: "running…", color: "#1d4ed8" };
  return { label: r.onPrem ? "pending (needs the client agent)" : "pending", color: "#8a6d00" };
}

export function ConnectionsView({ rows, v2 = false, schedule }: { rows: Row[]; v2?: boolean; schedule?: { enabled: boolean; intervalHours?: number; lastFinishedAt?: string } }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [redsOnly, setRedsOnly] = useState(false);
  const [sched, setSched] = useState(schedule ?? { enabled: false, intervalHours: 24 });

  async function saveSchedule(next: { enabled: boolean; intervalHours?: number }) {
    setSched(next);
    await fetch("/api/admin/conn-test/schedule", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).catch(() => {});
  }

  const counts = useMemo(() => {
    const c = { ok: 0, fail: 0, pending: 0, running: 0 };
    for (const r of rows) { if (r.status === "ok") c.ok++; else if (r.status === "fail") c.fail++; else if (r.status === "running") c.running++; else c.pending++; }
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (redsOnly && r.status !== "fail") return false;
      if (ql && ![r.client, r.systemKey, r.detail ?? ""].some((v) => v.toLowerCase().includes(ql))) return false;
      return true;
    });
  }, [rows, q, redsOnly]);

  async function sweep() {
    if (!confirm("Queue a connection test for every modeled client/system? This replaces any prior results and the runners will work through them.")) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/admin/conn-test/sweep", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg(d.error ?? `failed (${r.status})`); return; }
      setMsg(`Queued ${d.tests} tests across ${d.clients} clients (${d.onPrem} on-prem — those need each client's agent online). Results fill in as runners claim them; refresh.`);
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="filters" style={{ marginTop: "1rem", alignItems: "center", gap: 8 }}>
        <button className="primary" disabled={busy} onClick={sweep}>{busy ? "Queuing…" : "▶ Run fleet sweep"}</button>
        <label className="note" style={{ display: "inline-flex", gap: 4, alignItems: "center" }} title="Automatically re-run the fleet sweep on a schedule (off the runner heartbeat) and alert on new failures / expiring credentials">
          <input type="checkbox" checked={sched.enabled} onChange={(e) => saveSchedule({ ...sched, enabled: e.target.checked })} />
          scheduled
        </label>
        {sched.enabled && (
          <label className="note" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
            every
            <input type="number" min={1} value={sched.intervalHours ?? 24} onChange={(e) => saveSchedule({ ...sched, intervalHours: Math.max(1, Number(e.target.value) || 24) })} style={{ width: 52 }} />
            h
          </label>
        )}
        {/* v2 shows the counts in the page header instead. */}
        {!v2 && <span className="note">✓ {counts.ok} · ✗ {counts.fail} · running {counts.running} · pending {counts.pending}</span>}
        <span className="grow" />
        <label className="note" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={redsOnly} onChange={(e) => setRedsOnly(e.target.checked)} style={{ width: "auto" }} /> failures only
        </label>
        <input className="search" placeholder="client / system / detail…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
      </div>
      {msg && <p className="note" style={{ color: "#15803d" }}>{msg}</p>}

      <table style={{ width: "100%", tableLayout: "fixed", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            {/* v2: client + system share one identity cell. */}
            {v2 ? (
              <th style={{ width: 320, padding: "4px 8px" }}>Client / system</th>
            ) : (
              <>
                <th style={{ width: 220, padding: "4px 8px" }}>Client</th>
                <th style={{ width: 130, padding: "4px 8px" }}>System</th>
              </>
            )}
            <th style={{ width: 60, padding: "4px 8px" }}>Creds</th>
            <th style={{ width: 90, padding: "4px 8px" }}>Rights</th>
            <th style={{ width: 90, padding: "4px 8px" }}>Expires</th>
            <th style={{ width: 180, padding: "4px 8px" }}>Result</th>
            <th style={{ padding: "4px 8px" }}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r, i) => {
            const p = phase(r);
            return (
              <tr key={i} style={{ borderTop: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top" }}>
                {v2 ? (
                  <td style={{ padding: "4px 8px" }}>
                    <a href={`/clients/${r.slug}`}>{r.client}</a>{" "}
                    <b style={{ marginLeft: 4 }}>{r.systemKey}</b>
                    {r.onPrem && <span className="note" style={{ marginLeft: 4, fontSize: 10 }}>on-prem</span>}
                  </td>
                ) : (
                  <>
                    <td style={{ padding: "4px 8px" }}><a href={`/clients/${r.slug}`}>{r.client}</a></td>
                    <td style={{ padding: "4px 8px" }}><b>{r.systemKey}</b>{r.onPrem && <span className="note" style={{ marginLeft: 4, fontSize: 10 }}>on-prem</span>}</td>
                  </>
                )}
                <td style={{ padding: "4px 8px" }} title="Whether the runner could resolve the secret from Delinea">{r.accessOk === true ? "✓" : r.accessOk === false ? "✗" : "—"}</td>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }} title="Per-operation rights probe results">
                  {r.rightsMissing > 0 ? <span style={{ color: "#b91c1c" }}>✗ {r.rightsMissing}</span>
                    : r.rightsUnverified > 0 ? <span style={{ color: "#92400e" }}>? {r.rightsUnverified}</span>
                    : <span className="note">—</span>}
                </td>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }} title="Nearest credential expiry the probe could read">
                  {(() => {
                    if (!r.credExpiresAt) return <span className="note">—</span>;
                    const days = Math.round((new Date(r.credExpiresAt).getTime() - Date.now()) / 86_400_000);
                    const color = days < 7 ? "#b91c1c" : days < 30 ? "#92400e" : "var(--muted)";
                    return <span style={{ color }}>{days}d</span>;
                  })()}
                </td>
                <td style={{ padding: "4px 8px", color: p.color, whiteSpace: "nowrap" }}>{p.label}</td>
                <td style={{ padding: "4px 8px", overflowWrap: "anywhere", color: r.status === "fail" ? "#b91c1c" : "var(--muted, #6b7280)" }}>{r.detail ?? ""}</td>
              </tr>
            );
          })}
          {visible.length === 0 && <tr><td colSpan={v2 ? 6 : 7} style={{ padding: "1.5rem", textAlign: "center", color: "var(--muted)" }}>{rows.length === 0 ? "No connection tests yet — run a fleet sweep." : "No rows match."}</td></tr>}
        </tbody>
      </table>
    </>
  );
}
