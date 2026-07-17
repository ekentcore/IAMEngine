"use client";

// Merge PRs from Settings: list the outstanding PRs (number, title, draft/CI/mergeable) and merge
// one through the host's scripts/prs.sh — the same battle-tested path as the terminal. Renders
// nothing when the server says the feature isn't available on this host (Azure: no checkout/gh).
// Sits beside Restart server on purpose: merge, then restart to pick up what landed.
import { useEffect, useRef, useState } from "react";

type PrRow = { number: number; title: string; isDraft: boolean; mergeStateStatus: string; ci: "pass" | "fail" | "pending" | "none" };

const CI_LABEL: Record<PrRow["ci"], { text: string; color?: string }> = {
  pass: { text: "CI ✓", color: "var(--ok-fg)" },
  fail: { text: "CI ✗", color: "var(--err-fg, #b00)" },
  pending: { text: "CI …", color: "var(--warn-fg)" },
  none: { text: "no CI" },
};

export function MergePrs({ available }: { available: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [prs, setPrs] = useState<PrRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [output, setOutput] = useState<{ number: number; ok: boolean; text: string } | null>(null);

  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);

  async function load() {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/prs", { cache: "no-store" });
      const d = (await r.json().catch(() => ({}))) as { available?: boolean; prs?: PrRow[]; error?: string };
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setPrs(d.prs ?? []);
    } catch { setError("request failed"); } finally { setLoading(false); }
  }

  function openDialog() {
    setPrs(null); setError(null); setOutput(null); setConfirming(null); setOpen(true);
    void load();
  }

  async function merge(n: number) {
    setMerging(n); setConfirming(null); setError(null); setOutput(null);
    try {
      const r = await fetch("/api/admin/prs/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ number: n }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; output?: string; error?: string };
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setOutput({ number: n, ok: d.ok === true, text: d.output ?? "" });
      void load(); // the merged PR drops off the list
    } catch {
      // The merge may still have finished server-side (long request, dropped connection) — say so
      // instead of pretending it failed outright.
      setError("connection dropped while merging — check the PR list (refreshing) and the audit log before retrying");
      void load();
    } finally { setMerging(null); }
  }

  if (!available) return null;

  const mergeable = (p: PrRow) => !p.isDraft && p.mergeStateStatus !== "DIRTY" && merging === null;

  return (
    <>
      {" "}<button onClick={openDialog}>⇅ Merge PRs</button>
      <dialog ref={ref} style={{ maxWidth: 720 }} onClose={() => setOpen(false)}>
        <h2>Outstanding PRs</h2>
        <p className="note">
          Merging runs <code>scripts/prs.sh &lt;n&gt; --yes</code> on the host — the branch is caught up
          to main first, squash-merged, and the local checkout syncs (+ npm install). After a merge that
          changes the app, use <b>Restart server</b> to pick it up. Real conflicts roll back safely.
        </p>
        {loading && <p className="note">Loading…</p>}
        {error && <p className="note danger">{error}</p>}
        {prs && prs.length === 0 && !loading && <p className="note">No open PRs. 🎉</p>}
        {prs && prs.length > 0 && (
          <table style={{ width: "100%", marginTop: "0.5rem" }}>
            <thead><tr><th style={{ width: 60 }}>#</th><th>Title</th><th style={{ width: 90 }}>State</th><th style={{ width: 120 }}></th></tr></thead>
            <tbody>
              {prs.map((p) => (
                <tr key={p.number}>
                  <td className="tnum">#{p.number}</td>
                  <td>
                    {p.title}
                    <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                      {p.isDraft && <span className="badge">draft</span>}
                      {p.mergeStateStatus === "DIRTY" && <span className="badge" style={{ color: "var(--err-fg, #b00)" }}>conflicting</span>}
                      <span className="badge" style={{ color: CI_LABEL[p.ci].color }}>{CI_LABEL[p.ci].text}</span>
                    </div>
                  </td>
                  <td className="note muted">{p.mergeStateStatus.toLowerCase()}</td>
                  <td style={{ textAlign: "right" }}>
                    {confirming === p.number ? (
                      <span style={{ whiteSpace: "nowrap" }}>
                        <button className="btn-danger" onClick={() => merge(p.number)} disabled={merging !== null}>Confirm</button>{" "}
                        <button onClick={() => setConfirming(null)} disabled={merging !== null}>✕</button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirming(p.number)}
                        disabled={!mergeable(p)}
                        title={p.isDraft ? "Draft — finish it first (prs.sh leaves drafts alone by design)" : p.mergeStateStatus === "DIRTY" ? "Conflicting — resolve at a terminal" : "Merge via scripts/prs.sh"}>
                        {merging === p.number ? "Merging…" : "Merge"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {merging !== null && <p className="note">Merging #{merging}… this can take a couple of minutes (branch sync + npm install).</p>}
        {output && (
          <div style={{ marginTop: "0.75rem" }}>
            <p className="note" style={{ color: output.ok ? "var(--ok-fg)" : "var(--err-fg, #b00)" }}>
              {output.ok ? `✓ PR #${output.number} merged` : `✗ merge of #${output.number} did not complete — output below`}
            </p>
            <pre style={{ maxHeight: 260, overflow: "auto", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, padding: "0.5rem", fontSize: 11, whiteSpace: "pre-wrap" }}>{output.text}</pre>
          </div>
        )}
        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <button onClick={() => void load()} disabled={loading || merging !== null}>Refresh</button>
          <span className="grow" />
          <button className="primary" onClick={() => setOpen(false)} disabled={merging !== null}>Close</button>
        </div>
      </dialog>
    </>
  );
}
