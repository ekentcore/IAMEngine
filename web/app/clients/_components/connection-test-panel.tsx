"use client";

// Live connection / permission preflight. "Test connections" queues a probe per cloud/on-prem
// system; the runner connects with the brokered credential, does one read, and reports back. This
// panel polls the results until every test settles. Four stages per system: Fields (app-side —
// does the secret read + carry the right fields, stamped at queue time), Can access (runner
// resolved the secret), API works (connect + one live read), Rights (per-operation permission
// check where the probe supports it). Per-row "Retest" replaces only that system's row.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { StageBadge, RightsBadge, RightsDetail, stageDetail, hasRights, type ConnTest } from "@/lib/jobs/conn-test-badges";

type Test = ConnTest;

export function ConnectionTestPanel({ slug, systemNames }: { slug: string; systemNames: Record<string, string> }) {
  const [tests, setTests] = useState<Test[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [retesting, setRetesting] = useState<string | null>(null);
  const [openRights, setOpenRights] = useState<string | null>(null);
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

  // The secrets panel dispatches this after "Save & test" so freshly queued rows show up here.
  useEffect(() => {
    const onQueued = () => { void load(); };
    window.addEventListener("iam:conn-test-queued", onQueued);
    return () => window.removeEventListener("iam:conn-test-queued", onQueued);
  }, [load]);

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

  async function retest(systemKey: string) {
    setRetesting(systemKey); setError(null);
    try {
      // deep: an operator explicitly testing ONE system is the only thing that may run an interactive
      // probe (e.g. actually signing in to Spanning's console in a browser). Save-and-test and the
      // whole-client / fleet runs deliberately don't — one scripted M365 sign-in per client per sweep
      // is the burst that risk-based Conditional Access starts challenging.
      const r = await fetch(`/api/clients/${slug}/conn-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemKey, deep: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setRetesting(null); }
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
          <thead><tr>
            <th>System</th><th>Where</th>
            <th title="App-side: does the secret resolve and carry the fields its connector needs?">Fields</th>
            <th title="Can the runner resolve the secret from Delinea?">Can access</th>
            <th title="Does connecting + one live read against the vendor API work?">API works</th>
            <th title="Per-operation permission check, where the system's probe can verify it">Rights</th>
            <th>Detail</th>
            <th></th>
          </tr></thead>
          <tbody>
            {tests.map((t) => {
              const rightsOpen = openRights === t.systemKey;
              return (
                <Fragment key={t.systemKey}>
                  <tr>
                    <td>{systemNames[t.systemKey] ?? t.systemKey}</td>
                    <td className="muted">{t.onPrem ? "client agent" : "central runner"}</td>
                    <td><StageBadge test={t} kind="fields" /></td>
                    <td><StageBadge test={t} kind="access" /></td>
                    <td><StageBadge test={t} kind="api" /></td>
                    <td><RightsBadge test={t} open={rightsOpen} onToggle={() => setOpenRights(rightsOpen ? null : t.systemKey)} /></td>
                    <td className="muted" style={{ maxWidth: 300, whiteSpace: "normal" }}>{stageDetail(t)}</td>
                    <td>
                      <button onClick={() => retest(t.systemKey)} disabled={retesting !== null || busy || t.status === "pending" || t.status === "running"}>
                        {retesting === t.systemKey ? "Queuing…" : "Retest"}
                      </button>
                    </td>
                  </tr>
                  {hasRights(t) && rightsOpen && (
                    <tr>
                      <td colSpan={8} style={{ background: "var(--panel, transparent)" }}>
                        <RightsDetail rows={t.rights ?? []} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
