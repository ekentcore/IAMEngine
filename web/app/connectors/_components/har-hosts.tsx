"use client";

// HAR host-seeding for BROWSER connectors. A HAR can't become browser steps (it records network
// calls, not clicks — codegen paste does the steps), but it knows two things a browser definition
// wants: every host the portal actually touches (the `hosts` allowlist candidates), and whether the
// portal has an API underneath worth building as an http connector instead. Reuses the read-only
// POST /api/connectors/import-har parse.
import { useState } from "react";
import type { HarImportResult } from "@/lib/connectors/import-har";

export function HarHosts({ onApply, currentJson }: { onApply: (def: unknown) => void; currentJson: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<HarImportResult | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  const onFile = async (file: File) => {
    setErr(null); setBusy(true); setResult(null); setPicked({});
    try {
      const text = await file.text();
      const res = await fetch("/api/connectors/import-har", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ har: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const r = data as HarImportResult;
      setResult(r);
      setPicked(Object.fromEntries(r.hosts.map((h) => [h, true])));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    const chosen = Object.entries(picked).filter(([, v]) => v).map(([h]) => h);
    if (chosen.length === 0) { setErr("tick at least one host"); return; }
    let cur: Record<string, unknown>;
    try {
      cur = JSON.parse(currentJson) as Record<string, unknown>;
    } catch {
      setErr("the definition JSON below doesn't parse yet — fix it first, then add hosts");
      return;
    }
    const existing = Array.isArray(cur.hosts) ? (cur.hosts as unknown[]).filter((h): h is string => typeof h === "string") : [];
    onApply({ ...cur, hosts: [...new Set([...existing, ...chosen])].sort() });
    setOpen(false);
  };

  return (
    <div style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: "0.6rem 0.8rem", margin: "0.5rem 0" }}>
      <button type="button" onClick={() => setOpen((v) => !v)}>{open ? "Hide HAR hosts" : "Seed hosts from a HAR capture"}</button>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <p className="note" style={{ marginTop: 0 }}>
            Upload a HAR recorded while clicking through the portal; every host it touched becomes a candidate for the
            {" "}<span className="mono">hosts</span> allowlist (navigation off-allowlist fails at runtime). Steps still come from codegen paste.
          </p>
          <input type="file" accept=".har,application/json" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          {busy && <p className="note">Parsing…</p>}
          {err && <p style={{ color: "var(--err, #b91c1c)" }}>{err}</p>}
          {result && (
            <div style={{ marginTop: "0.5rem" }}>
              {result.hosts.length === 0 && <p className="note">No https hosts found in the capture.</p>}
              {result.hosts.map((h) => (
                <label key={h} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" checked={picked[h] ?? false} onChange={(e) => setPicked((s) => ({ ...s, [h]: e.target.checked }))} />
                  <span className="mono" style={{ fontSize: "0.8rem" }}>{h}</span>
                </label>
              ))}
              {result.hosts.length > 0 && <button type="button" onClick={apply} style={{ marginTop: "0.5rem" }}>Add ticked hosts to the definition</button>}
              {result.operations.length > 0 && (
                <p className="note" style={{ marginTop: "0.5rem" }}>
                  This capture also carries {result.operations.length} API-looking call{result.operations.length === 1 ? "" : "s"} — the portal may have a usable
                  (private) API. Consider an <strong>http</strong> connector instead: create one and use its HAR import + credential probe.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
