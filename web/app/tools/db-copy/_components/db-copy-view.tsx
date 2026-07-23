"use client";

import { useCallback, useEffect, useState } from "react";

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

const box: React.CSSProperties = { border: "1px solid var(--border, #333)", borderRadius: 6, padding: "12px 14px" };
const mono: React.CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13 };

export function DbCopyView() {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CopyResult | null>(null);

  const loadPreview = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch("/api/tools/db-copy", { cache: "no-store" });
      const data = await res.json();
      if (data.error || data.ok === false) {
        setError(data.error ?? "could not build the preview");
        setStatus("error");
        return;
      }
      setPreview(data.preview as Preview);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/tools/db-copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      const data = await res.json();
      if (!data.ok) setError(data.error ?? "copy failed");
      else {
        setResult(data.result as CopyResult);
        setConfirm("");
        await loadPreview();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const canRun = !!preview && !preview.sameTarget && confirm.trim() === preview.destDbName && !running;

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>DB copy</h1>
        <p style={{ margin: 0, color: "var(--muted-fg, #888)", fontSize: 14 }}>
          Copy the source database (<code>POSTGRES_*</code>) into the destination (<code>POSTGRES_*1</code>). Tables that
          don&apos;t exist in the destination are created; tables that already exist are truncated and reloaded. The
          Prisma migration ledger is not copied.
        </p>
      </div>

      {status === "loading" && <div style={box}>Loading preview…</div>}

      {status === "error" && (
        <div style={{ ...box, borderColor: "var(--err-fg, #c0392b)" }}>
          <strong>Not ready.</strong>
          <p style={{ margin: "6px 0 0", ...mono }}>{error}</p>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--muted-fg, #888)" }}>
            Set the destination in <code>env.env</code> (<code>POSTGRES_HOST1</code>, <code>POSTGRES_USER1</code>,{" "}
            <code>POSTGRES_PASSWORD1</code>, <code>POSTGRES_DB1</code>; optional <code>POSTGRES_PORT1</code>,{" "}
            <code>POSTGRES_SCHEMA1</code>) then reload.
          </p>
          <button onClick={() => void loadPreview()} style={{ marginTop: 10 }}>
            Reload
          </button>
        </div>
      )}

      {status === "ready" && preview && (
        <>
          <div style={box}>
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", ...mono }}>
              <span style={{ color: "var(--muted-fg, #888)" }}>from</span>
              <span>{preview.sourceLabel}</span>
              <span style={{ color: "var(--muted-fg, #888)" }}>to</span>
              <span>{preview.destLabel}</span>
            </div>
            <p style={{ margin: "10px 0 0", fontSize: 14 }}>
              {preview.tables.length} table(s): <strong>{preview.missingCount}</strong> to create,{" "}
              <strong>{preview.existingCount}</strong> already in the destination (their data will be replaced).
            </p>
          </div>

          {preview.sameTarget && (
            <div style={{ ...box, borderColor: "var(--err-fg, #c0392b)" }}>
              Source and destination point at the same database — nothing to copy. Fix the <code>POSTGRES_*1</code> vars.
            </div>
          )}

          <div style={{ ...box, maxHeight: 280, overflow: "auto", padding: 0 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", ...mono }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted-fg, #888)" }}>
                  <th style={{ padding: "8px 12px" }}>Table</th>
                  <th style={{ padding: "8px 12px" }}>In destination?</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Rows (approx)</th>
                </tr>
              </thead>
              <tbody>
                {preview.tables.map((t) => (
                  <tr key={t.name} style={{ borderTop: "1px solid var(--border, #2a2a2a)" }}>
                    <td style={{ padding: "6px 12px" }}>{t.name}</td>
                    <td style={{ padding: "6px 12px" }}>
                      {t.inDest ? "replace" : "create"}
                    </td>
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
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={preview.destDbName}
                disabled={running || preview.sameTarget}
                style={{ flex: 1, padding: "6px 8px", ...mono }}
              />
              <button onClick={() => void run()} disabled={!canRun}>
                {running ? "Copying…" : "Copy database"}
              </button>
            </div>
          </div>

          {result && (
            <div style={{ ...box, borderColor: "var(--ok-fg, #2e7d32)" }}>
              <strong>Copied.</strong>
              <p style={{ margin: "6px 0 0", fontSize: 14 }}>
                {result.totalTables} table(s) in {Math.round(result.durationMs / 100) / 10}s — created{" "}
                {result.createdTables.length}, replaced {result.truncatedTables.length}.
              </p>
            </div>
          )}

          {error && (
            <div style={{ ...box, borderColor: "var(--err-fg, #c0392b)" }}>
              <strong>Copy failed.</strong>
              <p style={{ margin: "6px 0 0", ...mono }}>{error}</p>
            </div>
          )}
        </>
      )}
    </main>
  );
}
