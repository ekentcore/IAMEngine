"use client";

// Maintenance & drain card (feature #7). The operator's Azure-cutover instrument: flip the global
// drain on → watch the in-flight count fall to zero ("fully drained — safe to cut over") → pull the
// switch → clear it on the new host. Also a general maintenance switch: pause dispatch of specific
// systems or clients without draining the whole fleet. Mutations are guarded server-side by
// /api/admin/maintenance (settings.manage); this only presents + polls the live count.
import { useEffect, useState } from "react";
import type { MaintenanceLoad } from "../_lib/loader";
import type { MaintenanceState } from "@/lib/jobs/maintenance";

const POLL_MS = 5000;

export function MaintenanceCard({ initial, clients }: { initial: MaintenanceLoad; clients: MaintenanceLoad["clients"] }) {
  const [state, setState] = useState<MaintenanceState>(initial.state);
  const [inFlight, setInFlight] = useState(initial.inFlight);
  const [reason, setReason] = useState(initial.state.reason ?? "");
  const [systems, setSystems] = useState((initial.state.systems ?? []).join(", "));
  const [pausedClients, setPausedClients] = useState<string[]>(initial.state.clients ?? []);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Live status poll: keep the in-flight count (and the drained/audit transition) fresh while the
  // card is open, on the same cadence the Agents page uses. Read-only GET; any active operator may read.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/admin/maintenance", { cache: "no-store" });
        if (!r.ok || !alive) return;
        const d = (await r.json()) as { state: MaintenanceState; inFlight: number };
        if (!alive) return;
        setState(d.state);
        setInFlight(d.inFlight);
      } catch { /* transient — the next tick retries */ }
    };
    const h = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(h); };
  }, []);

  async function post(next: { global: boolean; systems: string[]; clients: string[]; reason: string }) {
    setSaving(true); setErr(null);
    try {
      const r = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; state?: MaintenanceState; inFlight?: number };
      if (!r.ok) { setErr(d.error ?? `failed (${r.status})`); return; }
      if (d.state) { setState(d.state); setReason(d.state.reason ?? ""); setSystems((d.state.systems ?? []).join(", ")); setPausedClients(d.state.clients ?? []); }
      if (typeof d.inFlight === "number") setInFlight(d.inFlight);
    } catch { setErr("request failed"); } finally { setSaving(false); }
  }

  const parseSystems = () => systems.split(",").map((s) => s.trim()).filter(Boolean);

  const toggleGlobal = (on: boolean) =>
    post({ global: on, systems: parseSystems(), clients: pausedClients, reason });
  const saveScope = () =>
    post({ global: state.global, systems: parseSystems(), clients: pausedClients, reason });
  const clearAll = () => post({ global: false, systems: [], clients: [], reason: "" });

  const scopedActive = state.systems.length > 0 || state.clients.length > 0;
  const drainedFully = state.global && inFlight === 0;

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>Maintenance &amp; drain</h2>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        Pause dispatch server-side. A global drain claims nothing new fleet-wide and tells every runner to
        finish the job in hand and idle — use it to quiesce the fleet before a host cutover, then watch the
        in-flight count reach zero before you pull the switch. Scoped pauses (below) hold specific systems or
        clients without idling the runners on their other work.
      </p>

      {/* Banner — the cutover instrument. */}
      {state.global && (
        <div
          className="note"
          style={{ padding: "0.6rem 0.8rem", border: "1px solid", borderRadius: 6, marginBottom: "0.9rem", fontSize: 14 }}
        >
          {drainedFully
            ? "Fully drained — no jobs running. Safe to cut over."
            : `Draining — dispatch is paused; ${inFlight} job${inFlight === 1 ? "" : "s"} still running.`}
        </div>
      )}

      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14 }}>
        <input type="checkbox" checked={state.global} disabled={saving} onChange={(e) => toggleGlobal(e.target.checked)} style={{ width: "auto" }} />
        Pause all dispatch (drain the fleet)
      </label>

      <div style={{ marginTop: "0.6rem", maxWidth: 460 }}>
        <label className="note" style={{ display: "block", marginBottom: 4 }}>Reason (shown in the banner + audit)</label>
        <input
          type="text"
          value={reason}
          disabled={saving}
          placeholder="e.g. Azure host cutover"
          onChange={(e) => setReason(e.target.value)}
          onBlur={() => { if (state.global || scopedActive) saveScope(); }}
          style={{ width: "100%" }}
        />
      </div>

      {/* Scoped pauses — secondary, collapsed by default. */}
      <details style={{ marginTop: "1rem" }}>
        <summary className="note" style={{ cursor: "pointer" }}>
          Scoped pauses (pause specific systems or clients without a full drain)
        </summary>
        <div style={{ marginTop: "0.7rem", maxWidth: 460 }}>
          <label className="note" style={{ display: "block", marginBottom: 4 }}>Paused systems (comma-separated system keys, e.g. mimecast, spanning)</label>
          <input type="text" value={systems} disabled={saving} onChange={(e) => setSystems(e.target.value)} style={{ width: "100%" }} />

          <label className="note" style={{ display: "block", margin: "0.9rem 0 4px" }}>Paused clients</label>
          <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid", borderRadius: 6, padding: "0.4rem 0.6rem" }}>
            {clients.length === 0 && <p className="note">No clients.</p>}
            {clients.map((c) => (
              <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, padding: "2px 0" }}>
                <input
                  type="checkbox"
                  checked={pausedClients.includes(c.id)}
                  disabled={saving}
                  onChange={(e) => setPausedClients((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))}
                  style={{ width: "auto" }}
                />
                {c.name}
              </label>
            ))}
          </div>
          <button type="button" onClick={saveScope} disabled={saving} style={{ marginTop: "0.7rem" }}>
            {saving ? "Saving…" : "Save scoped pauses"}
          </button>
        </div>
      </details>

      <div className="note" style={{ marginTop: "0.9rem", fontSize: 13 }}>
        In-flight now: {inFlight} (dispatched + running)
        {state.since && <> · since {new Date(state.since).toLocaleString()}</>}
        {state.by && <> · by {state.by}</>}
      </div>

      {(state.global || scopedActive) && (
        <button type="button" onClick={clearAll} disabled={saving} style={{ marginTop: "0.6rem" }}>
          Clear all maintenance
        </button>
      )}

      {err && <p className="note danger" style={{ marginTop: 6 }}>{err}</p>}
    </section>
  );
}
