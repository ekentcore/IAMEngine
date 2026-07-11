"use client";

// Shared health view: fetches /api/health and renders the check table + credential setup guides.
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

  const guides = (
    <div style={{ marginTop: "1.25rem", borderTop: "1px solid var(--line)", paddingTop: "0.85rem" }}>
      <b style={{ fontSize: 14 }}>Credential setup guides</b>
      <ul className="note" style={{ margin: "0.35rem 0 0" }}>
        <li><Link href="/help/cloud-auth">Cloud auth (M365 + Exchange Online)</Link> — Entra app registration, client secret + certificate.</li>
        <li><Link href="/help/spanning">Spanning Backup (Microsoft 365)</Link> — Client ID + Secret, region host, Delinea template.</li>
        <li><Link href="/help/mimecast">Mimecast</Link> — API 2.0 application (client ID + secret), directory sync + user checks.</li>
        <li><Link href="/help/proofpoint">Proofpoint Essentials</Link> — admin account (X-User / X-Password), pod/region + org domain; read-only sync verification.</li>
        <li><Link href="/help/tap">Temporary Access Pass</Link> <span className="note">(optional)</span> — Graph UserAuthenticationMethod.ReadWrite.All + TAP enabled in the Authentication methods policy.</li>
        <li><Link href="/help/egnyte">Egnyte</Link> — API token (or API key + service account), per-tenant domain, license tiers.</li>
        <li><Link href="/help/google">Google Workspace</Link> — service account + domain-wide delegation (JSON key, base64 into Delinea), impersonated super-admin.</li>
        <li><Link href="/help/salesforce">Salesforce</Link> — Connected App + JWT certificate, integration user, config-driven Profile.</li>
        <li><Link href="/help/knowbe4">KnowBe4</Link> — SCIM token (no create-user REST API); skip if provisioned via Entra/Okta sync.</li>
        <li><Link href="/help/jira">Jira (Atlassian)</Link> — admin email + API token, site URL, product access list.</li>
        <li><Link href="/help/hubspot">HubSpot</Link> — private-app access token, config-driven role + team.</li>
      </ul>
    </div>
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

        {guides}
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

      {guides}
    </main>
  );
}
