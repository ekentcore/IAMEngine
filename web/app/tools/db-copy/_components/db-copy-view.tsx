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
type CopyResult = { tables: number; durationMs: number };
type DestForm = { host: string; port: string; user: string; database: string; schema: string; password: string; sslmode: "disable" | "require" };

// Default the toggle ON: the primary destination is managed Postgres (Azure), which refuses non-TLS
// connections ("no pg_hba.conf entry … SSL off"). A saved profile or LAN target can turn it off.
const EMPTY: DestForm = { host: "", port: "5432", user: "", database: "", schema: "public", password: "", sslmode: "require" };

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
  const [showPw, setShowPw] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrateOutput, setMigrateOutput] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tools/db-copy", { cache: "no-store" });
      const data = await res.json();
      setSourceLabel(data.source?.label ?? null);
      setSourceError(data.source?.error ?? null);
      const p = data.destProfile;
      if (p) setForm((f) => ({ ...f, host: p.host ?? "", port: String(p.port ?? 5432), user: p.user ?? "", database: p.database ?? "", schema: p.schema ?? "public", sslmode: p.sslmode === "require" ? "require" : "disable" }));
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

  const migrate = async () => {
    setMigrating(true);
    setError(null);
    setMigrateOutput(null);
    try {
      const res = await fetch("/api/tools/db-copy/migrate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      setMigrateOutput(data.output ?? (data.ok ? "done" : data.error ?? "migration failed"));
      if (data.ok) await test(); // re-probe so the preview refreshes (tables now exist → Copy unlocks)
      else if (data.error) setError(data.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMigrating(false);
    }
  };

  const destOk = !!probe?.dest.ok && !!probe?.source.ok;
  const canTest = form.host.trim() && form.user.trim() && form.database.trim() && form.password && !testing && !running;
  const canRun = destOk && !!preview && !preview.sameTarget && preview.missingCount === 0 && confirm.trim() === preview.destDbName && !running;

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>DB copy</h1>
        <p style={{ margin: 0, color: muted, fontSize: 14 }}>
          Copy this app&apos;s data (source) into a destination Postgres you fill in below. Fill the form and{" "}
          <strong>Test</strong>; use <strong>Build schema (migrate)</strong> to create the destination schema
          (runs <code>prisma migrate deploy</code> against it); then <strong>Copy</strong> clears the destination tables
          and loads the source data (data only — it never touches schema, so it works on managed Postgres like Azure).
          The Prisma migration ledger is not copied. The destination password is used only for these actions — it is
          never stored.
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
              <div style={{ position: "relative" }}>
                <input
                  type={showPw ? "text" : "password"}
                  value={form.password}
                  onChange={set("password")}
                  placeholder="(re-typed each time)"
                  style={{ ...field, paddingRight: 36 }}
                  disabled={running}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  aria-pressed={showPw}
                  title={showPw ? "Hide password" : "Show password"}
                  style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", padding: 4, lineHeight: 1, color: muted }}
                >
                  {showPw ? "🙈" : "👁"}
                </button>
              </div>
            </Labeled>
            <label style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={form.sslmode === "require"}
                onChange={(e) => setForm((f) => ({ ...f, sslmode: e.target.checked ? "require" : "disable" }))}
                disabled={running}
              />
              Require SSL <code>sslmode=require</code>
              <span style={{ color: muted }}>— needed for Azure / managed Postgres</span>
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button onClick={() => void test()} disabled={!canTest}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <button onClick={() => void migrate()} disabled={!destOk || migrating || running || testing} title="Runs `prisma migrate deploy` against the destination to create its schema">
              {migrating ? "Building schema…" : "Build schema (migrate)"}
            </button>
          </div>
          {probe?.dest && (
            <div style={{ marginTop: 10 }}>
              <StepList steps={probe.dest.steps} />
            </div>
          )}
          {migrateOutput != null && (
            <pre style={{ marginTop: 10, padding: "8px 10px", background: "var(--muted-bg, #1b1b1b)", borderRadius: 4, ...mono, fontSize: 12, whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}>
              {migrateOutput}
            </pre>
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
          <div style={{ ...box, ...(preview.missingCount > 0 ? { borderColor: errFg } : {}) }}>
            {preview.missingCount > 0 ? (
              <p style={{ margin: 0, fontSize: 14, color: errFg }}>
                {preview.missingCount} of {preview.tables.length} source table(s) don&apos;t exist on the destination yet.
                Click <strong>Build schema (migrate)</strong> above to create the schema on the destination, then Test again — then copy.
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 14 }}>
                {preview.tables.length} table(s) of data will be copied. Each destination table is cleared
                (TRUNCATE … RESTART IDENTITY) and reloaded from the source — idempotent, safe to re-run.
              </p>
            )}
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
                    <td style={{ padding: "6px 12px", color: t.inDest ? undefined : errFg }}>{t.inDest ? "load data" : "missing — migrate first"}</td>
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
            Copied data for {result.tables} table(s) in {Math.round(result.durationMs / 100) / 10}s.
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
