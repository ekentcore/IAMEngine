"use client";

import { useEffect, useState } from "react";

type Breakdown = {
  number: string;
  filled: { name: string; label: string; value: string }[];
  empty: { name: string; label: string }[];
};

// The full intake form for the case's UM — every field the requester filled in (with values),
// then the blanks. Loaded lazily so a slow/down ServiceNow can't block the case page render.
export function IntakePanel({ caseId }: { caseId: string }) {
  const [data, setData] = useState<Breakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cases/${caseId}/intake`)
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (r.ok) setData(j as Breakdown);
        else setError(j.error ?? r.statusText);
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [caseId]);

  if (loading) return <p className="note">Loading intake form…</p>;
  if (error) return <p className="note muted">Intake form unavailable: {error}</p>;
  if (!data) return null;

  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>{data.filled.length} filled, {data.empty.length} blank.</p>
      <table>
        <tbody>
          {data.filled.map((f) => (
            <tr key={f.name}>
              <th style={{ width: 260 }}>{f.label}</th>
              <td>{f.value}</td>
            </tr>
          ))}
          {data.filled.length === 0 && (
            <tr><td className="muted">Nothing filled in on this ticket.</td></tr>
          )}
        </tbody>
      </table>
      {data.empty.length > 0 && (
        <details style={{ marginTop: "0.5rem" }}>
          <summary className="note" style={{ cursor: "pointer" }}>Not filled in ({data.empty.length})</summary>
          <p className="muted" style={{ marginTop: "0.3rem" }}>{data.empty.map((e) => e.label).join(" · ")}</p>
        </details>
      )}
    </div>
  );
}
