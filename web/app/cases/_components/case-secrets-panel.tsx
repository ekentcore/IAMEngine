"use client";

// Per-case credentials: the Delinea references this case's jobs need. Each shows where it resolves
// from (client default / overridden / missing) and the host the step runs on. You can override or
// fill one inline, and preflight (test) it — references only; the value never enters the app.
import { useEffect, useState } from "react";

type CaseSecret = {
  name: string;
  label: string | null;
  source: "case" | "client" | "missing";
  externalId: string | null;
  clientExternalId: string | null;
  overridden: boolean;
  server: string | null;
  systems: string[];
};
type TestResult = { ok: boolean; label?: string; error?: string };

const SRC: Record<CaseSecret["source"], { text: string; color: string }> = {
  client: { text: "from client", color: "var(--muted)" },
  case: { text: "overridden", color: "#7b3fa0" },
  missing: { text: "missing", color: "#b3261e" },
};

export function CaseSecretsPanel({ caseId }: { caseId: string }) {
  const [secrets, setSecrets] = useState<CaseSecret[] | null>(null);
  const [delineaOk, setDelineaOk] = useState(true);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/cases/${caseId}/secrets`, { cache: "no-store" });
    const d = await r.json();
    setSecrets(d.secrets ?? []);
    setDelineaOk(Boolean(d.delineaConfigured));
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [caseId]);

  async function saveOverride(name: string, externalId: string) {
    setBusy(name); setError(null);
    const r = await fetch(`/api/cases/${caseId}/secrets`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, externalId }) });
    if (!r.ok) { setError((await r.json().catch(() => ({})))?.error ?? `save failed (${r.status})`); setBusy(null); return; }
    setEdit((e) => { const x = { ...e }; delete x[name]; return x; });
    await load();
    setBusy(null);
  }

  async function test(name?: string) {
    setBusy(name ?? "all");
    // test the on-screen edits if any, else the saved effective refs
    const items = (secrets ?? [])
      .filter((s) => !name || s.name === name)
      .map((s) => ({ name: s.name, externalId: edit[s.name] ?? s.externalId ?? "" }));
    const r = await fetch(`/api/cases/${caseId}/secrets/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secrets: items }) });
    const d = await r.json();
    setResults((prev) => { const x = { ...prev }; for (const res of d.results ?? []) x[res.name] = res; return x; });
    setBusy(null);
  }

  if (!secrets) return <p className="note">Loading credentials…</p>;
  if (secrets.length === 0) return <p className="note">No credentials needed for this case.</p>;

  const anyMissing = secrets.some((s) => s.source === "missing");

  return (
    <div>
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <p className="note" style={{ margin: 0 }}>
          Delinea references this case needs. Set on the client by default; override or fill one here for a one-off.
          {anyMissing && <span style={{ color: "#b3261e" }}> · some are missing — fill them before dispatch.</span>}
        </p>
        <button onClick={() => test()} disabled={!!busy || !delineaOk} title={delineaOk ? "" : "Delinea not configured — see /health"}>Test all</button>
      </div>
      {!delineaOk && <p className="note danger">Delinea isn&apos;t configured on the app — fill DELINEA_* and check /health before testing.</p>}
      {error && <p className="note danger">{error}</p>}
      <table style={{ width: "100%", marginTop: "0.5rem" }}>
        <thead>
          <tr><th style={{ textAlign: "left" }}>Secret</th><th style={{ textAlign: "left" }}>Runs on</th><th style={{ textAlign: "left" }}>Reference (Delinea id)</th><th></th><th></th></tr>
        </thead>
        <tbody>
          {secrets.map((s) => {
            const val = edit[s.name] ?? s.externalId ?? "";
            const res = results[s.name];
            return (
              <tr key={s.name}>
                <td>
                  <div style={{ fontWeight: 500 }}>{s.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{s.label ?? s.systems.join(", ")}</div>
                </td>
                <td className="muted" style={{ fontSize: 12 }}>{s.server ? <b>{s.server}</b> : <span className="muted">—</span>}<div style={{ fontSize: 11 }}>{s.systems.join(", ")}</div></td>
                <td>
                  <input value={val} placeholder="Delinea secret id" onChange={(e) => setEdit((x) => ({ ...x, [s.name]: e.target.value }))}
                    style={{ fontFamily: "monospace", width: "100%", minWidth: 140 }} />
                  <span className="badge" style={{ marginTop: 2, color: SRC[s.source].color }}>{SRC[s.source].text}</span>
                  {s.overridden && s.clientExternalId && (
                    <button className="note" style={{ marginLeft: 6 }} onClick={() => saveOverride(s.name, "")}>reset to client</button>
                  )}
                  {res && <span className="badge" style={{ marginLeft: 6, color: res.ok ? "#2e7d32" : "#b3261e" }}>{res.ok ? `✓ ${res.label ?? "ok"}` : `✗ ${res.error ?? "fail"}`}</span>}
                </td>
                <td><button onClick={() => saveOverride(s.name, val)} disabled={busy === s.name || (edit[s.name] ?? "") === ""}>Save</button></td>
                <td><button onClick={() => test(s.name)} disabled={!!busy || !delineaOk}>Test</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
