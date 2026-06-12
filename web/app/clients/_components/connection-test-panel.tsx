"use client";

// Live connection / permission preflight. "Test connections" queues a probe per cloud/on-prem
// system; the runner connects with the brokered credential, does one read, and reports back. This
// panel polls the results until every test settles. Distinct from the Secrets panel's field check:
// that's app-side (does the secret read + carry the right fields); this proves the cred actually
// has access by connecting from where the runner runs.
import { useCallback, useEffect, useRef, useState } from "react";

type Test = { systemKey: string; status: "pending" | "running" | "ok" | "fail"; detail: string | null; onPrem: boolean; finishedAt: string | null };

const BADGE: Record<Test["status"], { text: string; color: string }> = {
  pending: { text: "queued", color: "var(--muted)" },
  running: { text: "testing…", color: "#92400e" },
  ok: { text: "✓ connected", color: "#15803d" },
  fail: { text: "✗ failed", color: "#b91c1c" },
};

export function ConnectionTestPanel({ slug, systemNames }: { slug: string; systemNames: Record<string, string> }) {
  const [tests, setTests] = useState<Test[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clients/${slug}/conn-test`, { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setTests(d.tests ?? []);
    } catch (e) { setError((e as Error).message); }
  }, [slug]);

  // Poll while anything is unsettled; stop once all tests are ok/fail.
  useEffect(() => {
    if (!tests) return;
    const pending = tests.some((t) => t.status === "pending" || t.status === "running");
    if (timer.current) clearTimeout(timer.current);
    if (pending) timer.current = setTimeout(load, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [tests, load]);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/conn-test`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      if ((d.tests ?? []).length === 0) { setTests([]); setError("No testable systems — add an api system with a wired secret first."); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: "0.6rem" }}>
      <div className="toolbar">
        <button className="primary" onClick={run} disabled={busy}>{busy ? "Queuing…" : "Test connections"}</button>
        <span className="note">Connects to each system with its credential and does one read — proves real access, not just that the secret resolves. Needs the matching runner online (cloud → central; on-prem → the client agent).</span>
      </div>
      {error && <p className="note danger">{error}</p>}
      {tests && tests.length > 0 && (
        <table style={{ marginTop: "0.5rem" }}>
          <thead><tr><th>System</th><th>Where</th><th>Result</th><th>Detail</th></tr></thead>
          <tbody>
            {tests.map((t) => {
              const b = BADGE[t.status];
              return (
                <tr key={t.systemKey}>
                  <td>{systemNames[t.systemKey] ?? t.systemKey}</td>
                  <td className="muted">{t.onPrem ? "client agent" : "central runner"}</td>
                  <td><span className="badge" style={{ color: b.color }}>{b.text}</span></td>
                  <td className="muted" style={{ maxWidth: 360, whiteSpace: "normal" }}>{t.detail ?? (t.status === "pending" ? "waiting for a runner to claim it…" : t.status === "running" ? "connecting…" : "")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
