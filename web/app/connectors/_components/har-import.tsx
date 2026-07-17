"use client";

// HAR import panel inside the http editor. Upload a HAR captured while doing the task by hand; the
// server parses it into candidate operations (POST /api/connectors/import-har — read-only, saves
// nothing). The admin ticks the operations to keep, and we assemble a STARTER definition into the
// JSON editor for them to finish (name lanes, add {{templates}}). Everything still passes the same
// server validation on save.
import { useState } from "react";
import type { HarImportResult, ImportedOperation } from "@/lib/connectors/import-har";

type Kept = ImportedOperation & { keep: boolean; name: string };

function slugToBaseUrl(op: ImportedOperation): string {
  // Guess a baseUrl from the first operation's host + the common leading path segment (e.g. /v1).
  const first = op.path.split("?")[0].split("/").filter(Boolean)[0];
  const prefix = first && /^v\d+$|^api$/i.test(first) ? `/${first}` : "";
  return `https://${op.host}${prefix}`;
}

export function HarImport({ onApply, currentJson }: { onApply: (def: unknown) => void; currentJson: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<HarImportResult | null>(null);
  const [ops, setOps] = useState<Kept[]>([]);

  const onFile = async (file: File) => {
    setErr(null); setBusy(true); setResult(null); setOps([]);
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
      setOps(r.operations.map((o) => ({ ...o, keep: true, name: o.suggestedName })));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const assemble = () => {
    const keep = ops.filter((o) => o.keep);
    if (keep.length === 0) { setErr("tick at least one operation to keep"); return; }
    const hosts = [...new Set(keep.map((o) => o.host))];
    const baseUrl = slugToBaseUrl(keep[0]);
    const operations: Record<string, unknown> = {};
    for (const o of keep) {
      // Relativize the path against the guessed baseUrl prefix so the definition reads cleanly.
      let path = o.path;
      try {
        const bp = new URL(baseUrl).pathname.replace(/\/$/, "");
        if (bp && (path.startsWith(bp + "/") || path.startsWith(bp + "?"))) path = path.slice(bp.length);
      } catch { /* keep absolute path */ }
      operations[o.name] = {
        request: { method: o.method, path, ...(Object.keys(o.headers).length ? { headers: o.headers } : {}), ...(o.body != null ? { body: o.body } : {}) },
        ...(o.responseStatus ? { expect: { status: [o.responseStatus] } } : {}),
      };
    }
    // Preserve the author's existing auth block if they already set one; else scaffold a bearer.
    let auth: unknown = { type: "bearer", secretName: "custom-vendor-api" };
    try { const cur = JSON.parse(currentJson); if (cur?.auth) auth = cur.auth; } catch { /* ignore */ }
    const def = {
      version: 1,
      kind: "http",
      baseUrl,
      hosts,
      auth,
      operations,
      // A starter lane the author edits — every op, in capture order, in the offboard lane.
      lanes: { offboard: keep.map((o) => ({ op: o.name })) },
    };
    onApply(def);
    setOpen(false);
  };

  return (
    <div style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: "0.6rem 0.8rem", margin: "0.5rem 0" }}>
      <button type="button" onClick={() => setOpen((v) => !v)}>{open ? "Hide HAR import" : "Import from a HAR capture"}</button>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <p className="note" style={{ marginTop: 0 }}>
            In the vendor portal/API tool, open the browser Network tab, do the task once (e.g. create then disable a test user),
            then right-click → “Save all as HAR”. Upload it here. Auth headers and cookies are stripped — you declare auth yourself.
          </p>
          <input type="file" accept=".har,application/json" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          {busy && <p className="note">Parsing…</p>}
          {err && <p style={{ color: "var(--err, #b91c1c)" }}>{err}</p>}
          {result && (
            <div style={{ marginTop: "0.5rem" }}>
              <p className="note">{result.note}</p>
              {ops.length > 0 && (
                <>
                  <table style={{ width: "100%", fontSize: "0.8rem", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ textAlign: "left" }}>
                        <th style={{ padding: "0.2rem" }}>keep</th>
                        <th style={{ padding: "0.2rem" }}>name</th>
                        <th style={{ padding: "0.2rem" }}>method</th>
                        <th style={{ padding: "0.2rem" }}>path</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ops.map((o, i) => (
                        <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "0.2rem" }}>
                            <input type="checkbox" checked={o.keep} onChange={(e) => setOps((s) => s.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} />
                          </td>
                          <td style={{ padding: "0.2rem" }}>
                            <input value={o.name} onChange={(e) => setOps((s) => s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="mono" style={{ width: 140 }} />
                          </td>
                          <td style={{ padding: "0.2rem" }} className="mono">{o.method}</td>
                          <td style={{ padding: "0.2rem" }} className="mono note">{o.path}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button type="button" onClick={assemble} style={{ marginTop: "0.5rem" }}>Build definition from ticked operations</button>
                  <p className="note">Fills the JSON editor below. You still name the lanes, add {"{{templates}}"} for the user’s fields, and set auth.</p>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
