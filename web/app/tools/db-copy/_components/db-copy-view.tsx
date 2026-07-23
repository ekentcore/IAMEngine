"use client";

import { useCallback, useEffect, useState } from "react";

type ProbeStep = {
  step: "config" | "reachable" | "authenticated" | "database" | "version" | "tables";
  label: string;
  status: "ok" | "fail" | "skipped";
  detail?: string;
  ms?: number;
  error?: string;
};
type ProbeResult = { ok: boolean; label: string; steps: ProbeStep[] };
type ProbePair = { source: ProbeResult; dest: ProbeResult };
type TablePreview = { name: string; inDest: boolean; approxRows: number };
type Preview = {
  sourceLabel: string;
  destLabel: string;
  sameTarget: boolean;
  destDbName: string;
  tables: TablePreview[];
  missingCount: number;
  existingCount: number;
};
type CopyResult = { totalTables: number; createdTables: string[]; truncatedTables: string[]; durationMs: number };
type DestForm = { host: string; port: string; user: string; database: string; schema: string; password: string };

const EMPTY: DestForm = { host: "", port: "5432", user: "", database: "", schema: "public", password: "" };

const box: React.CSSProperties = { border: "1px solid var(--border, #333)", borderRadius: 6, padding: "12px 14px" };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 };
const field: React.CSSProperties = { padding: "6px 8px", ...mono, width: "100%", boxSizing: "border-box" };
const muted = "var(--muted-fg, #888)";
const errFg = "var(--err-fg, #c0392b)";
const okFg = "var(--ok-fg, #2e7d32)";

export function DbCopyView() {
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [form, setForm] = useState<DestForm>(EMPTY);
  const [probe, setProbe] = useState<ProbePair | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CopyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/db-copy", { cache: "no-store" });
      const data = await res.json();
      setSourceLabel(data.source?.label ?? null);
      setSourceError(data.source?.error ?? null);
      const p = data.destProfile;
      if (p) setForm((f) => ({ ...f, host: p.host ?? "", port: String(p.port ?? 5432), user: p.user ?? "", database: p.database ?? "", schema: p.schema ?? "public" }));
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof DestForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const test = async () => {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/tools/db-copy/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "connection test failed");
        setProbe(null);
        setPreview(null);
      } else {
        setProbe(data.probe as ProbePair);
        setPreview((data.preview as Preview) ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/tools/db-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, confirm }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.error ?? "copy failed");
      else {
        setResult(data.result as CopyResult);
        setConfirm("");
        setForm((f) => ({ ...f, password: "" }));
        setProbe(null);
        setPreview(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const destOk = !!probe?.dest.ok && !!probe?.source.ok;
  const canTest = form.host.trim() && form.user.trim() && form.database.trim() && form.password && !testing && !running;
  const canRun = destOk && !!preview && !preview.sameTarget && confirm.trim() === preview.destDbName && !running;

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>DB copy</h1>
        <p style={{ margin: 0, color: muted, fontSize: 14 }}>
          Copy this app&apos;s database (source) into a destination Postgres you fill in below. Tables missing in the
          destination are created; tables that already exist are truncated and reloaded. The Prisma migration ledger is
          not copied. The destination password is used only for this test/copy — it is never stored.
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Source — read-only */}
        <div style={box}>
          <strong style={{ fontSize: 14 }}>Source (this app)</strong>
          <p style={{ margin: "6px 0 10px", ...mono, color: sourceError ? errFg : undefined }}>
            {sourceError ?? sourceLabel ?? "…"}
          </p>
          {probe?.source && <StepList steps={probe.source.steps} />}
        </div>

        {/* Destination — form */}
        <div style={box}>
          <strong style={{ fontSize: 14 }}>Destination</strong>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <Labeled label="Host" wide>
              <input value={form.host} onChange={set("host")} placeholder="db.example.com" style={field} disabled={running} />
            </Labeled>
            <Labeled label="Port">
              <input value={form.port} onChange={set("port")} placeholder="5432" style={field} disabled={running} />
            </Labeled>
            <Labeled label="Schema">
              <input value={form.schema} onChange={set("schema")} placeholder="public" style={field} disabled={running} />
            </Labeled>
            <Labeled label="User">
              <input value={form.user} onChange={set("user")} placeholder="iam" style={field} disabled={running} />
            </Labeled>
            <Labeled label="Database">
              <input value={form.database} onChange={set("database")} placeholder="automationUM" style={field} disabled={running} />
            </Labeled>
            <Labeled label="Password" wide>
              <input type="password" value={form.password} onChange={set("password")} placeholder="(re-typed each time)" style={field} disabled={running} autoComplete="off" />
            </Labeled>
          </div>
          <button onClick={() => void test()} disabled={!canTest} style={{ marginTop: 10 }}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          {probe?.dest && (
            <div style={{ marginTop: 10 }}>
              <StepList steps={probe.dest.steps} />
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={{ ...box, borderColor: errFg }}>
          <strong>Couldn&apos;t {running ? "copy" : "test"}.</strong>
          <p style={{ margin: "6px 0 0", ...mono }}>{error}</p>
        </div>
      )}

      {preview && !preview.sameTarget && (
        <>
          <div style={box}>
            <p style={{ margin: 0, fontSize: 14 }}>
              {preview.tables.length} table(s): <strong>{preview.missingCount}</strong> to create,{" "}
              <strong>{preview.existingCount}</strong> already in the destination (their data will be replaced).
            </p>
          </div>

          <div style={{ ...box, maxHeight: 280, overflow: "auto", padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", ...mono }}>
              <thead>
                <tr style={{ textAlign: "left", color: muted }}>
                  <th style={{ padding: "8px 12px" }}>Table</th>
                  <th style={{ padding: "8px 12px" }}>Action</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Rows (approx)</th>
                </tr>
              </thead>
              <tbody>
                {preview.tables.map((t) => (
                  <tr key={t.name} style={{ borderTop: "1px solid var(--border, #2a2a2a)" }}>
                    <td style={{ padding: "6px 12px" }}>{t.name}</td>
                    <td style={{ padding: "6px 12px" }}>{t.inDest ? "replace" : "create"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right" }}>{t.approxRows.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={box}>
            <label style={{ fontSize: 14 }}>
              To run, type the destination database name <code>{preview.destDbName}</code> to confirm:
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={preview.destDbName} disabled={running} style={{ flex: 1, ...field }} />
              <button onClick={() => void run()} disabled={!canRun}>
                {running ? "Copying…" : "Copy database"}
              </button>
            </div>
          </div>
        </>
      )}

      {preview?.sameTarget && (
        <div style={{ ...box, borderColor: errFg }}>
          Source and destination point at the same database — nothing to copy.
        </div>
      )}

      {result && (
        <div style={{ ...box, borderColor: okFg }}>
          <strong>Copied.</strong>
          <p style={{ margin: "6px 0 0", fontSize: 14 }}>
            {result.totalTables} table(s) in {Math.round(result.durationMs / 100) / 10}s — created{" "}
            {result.createdTables.length}, replaced {result.truncatedTables.length}.
          </p>
        </div>
      )}
    </main>
  );
}

function Labeled({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: muted, gridColumn: wide ? "1 / -1" : undefined }}>
      {label}
      {children}
    </label>
  );
}

function StepList({ steps }: { steps: ProbeStep[] }) {
  const glyph = (s: ProbeStep["status"]) => (s === "ok" ? "✓" : s === "fail" ? "✗" : "—");
  const color = (s: ProbeStep["status"]) => (s === "ok" ? okFg : s === "fail" ? errFg : muted);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, ...mono }}>
      {steps.map((s) => (
        <div key={s.step} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span aria-hidden style={{ width: 14, color: color(s.status) }}>{glyph(s.status)}</span>
          <span style={{ width: 120, color: s.status === "skipped" ? muted : undefined }}>{s.label}</span>
          <span style={{ flex: 1, color: s.status === "fail" ? errFg : muted }}>
            {s.status === "fail" ? s.error : s.status === "skipped" ? "(skipped)" : s.detail}
            {s.ms != null && s.status === "ok" ? "" : null}
          </span>
        </div>
      ))}
    </div>
  );
}
