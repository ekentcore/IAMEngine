"use client";

// Redline any two versions of a document. Managers pick a "from" and "to" version (a published
// version, or the pending draft) and get the same line diff the draft review uses. Defaults to the
// two newest versions so a single click shows "what changed last".
import { useState } from "react";
import { DocDiff, type DiffLine } from "./doc-diff";

export type VersionOption = { id: string; version: string; status: string };

type Result = { from: { version: string }; to: { version: string }; added: number; removed: number; diff: DiffLine[] } | null;

export function VersionCompare({ slug, options }: { slug: string; options: VersionOption[] }) {
  const label = (o: VersionOption) => `v${o.version}${o.status === "draft" ? " (draft)" : ""}`;
  // Default: compare the second-newest → newest (the most recent change). Fall back sensibly.
  const [from, setFrom] = useState(options[1]?.id ?? options[0]?.id ?? "");
  const [to, setTo] = useState(options[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);

  if (options.length < 2) return null; // nothing to compare against

  async function compare() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/docs/${slug}/redline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `compare failed (${res.status})`);
        return;
      }
      setResult(json as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "compare failed");
    } finally {
      setBusy(false);
    }
  }

  const sel: React.CSSProperties = { padding: "4px 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg)", color: "inherit", fontSize: 13 };

  return (
    <details className="doc-compare">
      <summary style={{ cursor: "pointer" }}>Compare versions (redline)</summary>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <select style={sel} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Compare from">
          {options.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}
        </select>
        <span className="note">→</span>
        <select style={sel} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Compare to">
          {options.map((o) => <option key={o.id} value={o.id}>{label(o)}</option>)}
        </select>
        <button type="button" className="btn" disabled={busy || from === to} onClick={compare}>
          {busy ? "Comparing…" : "Compare"}
        </button>
        {from === to && <span className="note" style={{ fontSize: 12 }}>Pick two different versions.</span>}
      </div>

      {error && <p style={{ color: "var(--danger)", margin: "10px 0 0", fontSize: 13 }}>{error}</p>}
      {result && (
        <>
          <p className="note" style={{ margin: "12px 0 0", fontSize: 13 }}>
            v{result.from.version} → v{result.to.version} · <span style={{ color: "var(--ok)" }}>+{result.added}</span> / <span style={{ color: "var(--danger)" }}>−{result.removed}</span> lines
          </p>
          {result.diff.length ? <DocDiff diff={result.diff} /> : <p className="note" style={{ marginTop: 8 }}>No differences.</p>}
        </>
      )}
    </details>
  );
}
