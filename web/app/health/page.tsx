"use client";

import { useCallback, useEffect, useState } from "react";

type HealthStatus = "ok" | "fail" | "not_configured";
type HealthResult = { name: string; status: HealthStatus; detail: string; latencyMs: number | null };

const STYLE: Record<HealthStatus, { label: string; color: string; border: string; bg: string }> = {
  ok: { label: "healthy", color: "#2e7d32", border: "#c4e3c8", bg: "#f1f8f2" },
  fail: { label: "failing", color: "#b3261e", border: "#f0c4c1", bg: "#fdf3f2" },
  not_configured: { label: "not configured", color: "#7a7a7a", border: "var(--line)", bg: "var(--bg-soft)" },
};

export default function HealthPage() {
  const [checks, setChecks] = useState<HealthResult[] | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = (await res.json()) as { at: string; checks: HealthResult[] };
      setChecks(data.checks);
      setAt(data.at);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { run(); }, [run]);

  const counts = checks?.reduce(
    (a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a),
    {} as Record<HealthStatus, number>
  );

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "1.5rem 1rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem" }}>
        <h1 style={{ margin: 0 }}>System health</h1>
        <button onClick={run} disabled={busy}>{busy ? "Checking…" : "Re-run checks"}</button>
      </div>
      <p className="note" style={{ marginTop: "0.4rem" }}>
        Live credential + connection checks for the app&rsquo;s integrations. Reads <code>web/.env</code> and the
        repo-root <code>env.env</code>.
        {counts && (
          <> {" · "}{counts.ok ?? 0} healthy, {counts.fail ?? 0} failing, {counts.not_configured ?? 0} not configured
            {at ? ` · ${new Date(at).toLocaleTimeString()}` : ""}</>
        )}
      </p>

      {error && <p className="note danger">{error}</p>}

      {!checks && busy && <p className="note"><span className="spinner" />Running checks…</p>}

      {checks && (
        <table style={{ width: "100%", marginTop: "0.75rem" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Service</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Detail</th>
              <th style={{ textAlign: "right" }}>Latency</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const s = STYLE[c.status];
              return (
                <tr key={c.name}>
                  <td style={{ fontWeight: 500 }}>{c.name}</td>
                  <td>
                    <span className="badge" style={{ color: s.color, borderColor: s.border, background: s.bg }}>
                      {s.label}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>{c.detail}</td>
                  <td style={{ textAlign: "right", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                    {c.latencyMs == null ? "—" : `${c.latencyMs} ms`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="note" style={{ marginTop: "1rem", color: "var(--muted)" }}>
        &ldquo;Not configured&rdquo; means the env vars are absent (the integration is off, not broken).
        &ldquo;Failing&rdquo; means it&rsquo;s configured but the credential/connection didn&rsquo;t work.
      </p>
    </main>
  );
}
