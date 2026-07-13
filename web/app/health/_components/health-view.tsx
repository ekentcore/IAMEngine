"use client";

// Shared health view: fetches /api/health and renders the check table.
// Rendered by /health (classic) and /health/v2 (denser: identity cell = badge + name with the
// detail as a note line underneath; counts live in the page header).
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type HealthStatus = "ok" | "fail" | "not_configured";
type HealthResult = { name: string; status: HealthStatus; detail: string; latencyMs: number | null };

const STYLE: Record<HealthStatus, { label: string; color: string; border: string; bg: string }> = {
  ok: { label: "healthy", color: "#2e7d32", border: "#c4e3c8", bg: "#f1f8f2" },
  fail: { label: "failing", color: "#b3261e", border: "#f0c4c1", bg: "#fdf3f2" },
  not_configured: { label: "not configured", color: "#7a7a7a", border: "var(--line)", bg: "var(--bg-soft)" },
};

export function HealthView({ v2 = false }: { v2?: boolean }) {
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

  const legend = (
    <p className="note" style={{ marginTop: "1rem", color: "var(--muted)" }}>
      &ldquo;Not configured&rdquo; means the env vars are absent (the integration is off, not broken).
      &ldquo;Failing&rdquo; means it&rsquo;s configured but the credential/connection didn&rsquo;t work.
    </p>
  );

  if (!v2) {
    return (
      <main style={{ maxWidth: 880, margin: "0 auto", padding: "1.5rem 1rem" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "1rem" }}>
          <h1 style={{ margin: 0 }}>System health</h1>
          <button onClick={run} disabled={busy}>{busy ? "Checking…" : "Re-run checks"}</button>
        </div>
        <p className="note" style={{ marginTop: "0.4rem" }}>
          Live credential + connection checks for the app&rsquo;s integrations. Reads <code>web/.env</code> and the
          repo-root <code>env.env</code>. For per-client/system preflights across the whole fleet, see{" "}
          <Link href="/health/connections">Connection tests</Link>.
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

        {legend}
      </main>
    );
  }

  // v2: denser table — the status badge + service name share one identity cell, the detail sits
  // under the name as a note line, latency is right-aligned tabular. Counts move into the header.
  return (
    <main>
      <div className="row-between">
        <div>
          <h1>System health <span className="note">(v2)</span></h1>
          <p className="note">
            {counts
              ? <>{counts.ok ?? 0} ok · {counts.fail ?? 0} failing · {counts.not_configured ?? 0} not configured{at ? ` · ${new Date(at).toLocaleTimeString()}` : ""}</>
              : <>checking…</>}
            {" — "}live credential checks for the app&rsquo;s integrations; for fleet-wide preflights see{" "}
            <Link href="/health/connections/v2">Connection tests</Link>.
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", alignSelf: "flex-start" }}>
          <button onClick={run} disabled={busy}>{busy ? "Checking…" : "Re-run checks"}</button>
          <Link href="/health" className="note" style={{ whiteSpace: "nowrap" }}>← back to System health</Link>
        </div>
      </div>

      {error && <p className="note danger">{error}</p>}

      {!checks && busy && <p className="note"><span className="spinner" />Running checks…</p>}

      {checks && (
        <table style={{ width: "100%", marginTop: "0.75rem", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th style={{ padding: "4px 8px" }}>Service</th>
              <th className="num" style={{ width: 90, padding: "4px 8px" }}>Latency</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const s = STYLE[c.status];
              return (
                <tr key={c.name} style={{ verticalAlign: "top" }}>
                  <td style={{ padding: "4px 8px" }}>
                    <span className="badge" style={{ color: s.color, borderColor: s.border, background: s.bg, marginRight: 8 }}>
                      {s.label}
                    </span>
                    <b>{c.name}</b>
                    <div className="note" style={{ marginTop: 2 }}>{c.detail}</div>
                  </td>
                  <td className="num tnum" style={{ padding: "4px 8px", color: "var(--muted)" }}>
                    {c.latencyMs == null ? "—" : `${c.latencyMs} ms`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {legend}
    </main>
  );
}
