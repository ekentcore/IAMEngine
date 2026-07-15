"use client";

// Admin panel for a document (global_admin+). With no pending draft it offers "Update with AI",
// which reads the change log since the current version and produces a draft. With a draft pending it
// shows the change note + a diff for review, a preview download, and Publish / Discard. Every action
// re-guards on the server; this is the UI half.
import { useRouter } from "next/navigation";
import { useState } from "react";

type Review = {
  draftId: string;
  version: string;
  changeNote: string;
  entriesConsidered: number;
  generatedByAi: boolean;
  shrunk: boolean;
  added: number;
  removed: number;
  diff: { type: string; text: string }[];
} | null;

export function ManagePanel({ slug, currentVersion, pendingEntries, review }: { slug: string; currentVersion: string | null; pendingEntries: number; review: Review }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState<"minor" | "major">("minor");

  async function post(url: string, body?: unknown, action?: string) {
    setBusy(action ?? url);
    setError(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const card: React.CSSProperties = { border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, padding: 16, marginTop: 20 };

  // No draft: the update affordance.
  if (!review) {
    return (
      <div style={card}>
        <div className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
          <div>
            <strong>Update with AI</strong>
            <p className="note" style={{ margin: "4px 0 0" }}>
              {currentVersion ? (
                pendingEntries > 0
                  ? `Reads the ${pendingEntries} change-log ${pendingEntries === 1 ? "entry" : "entries"} logged since v${currentVersion} and proposes a revised draft for your review.`
                  : `No change-log entries logged since v${currentVersion}. You can still run an update to re-check.`
              ) : "Publish an initial version before running an AI update."}
            </p>
          </div>
          <button type="button" className="btn" disabled={!currentVersion || busy !== null} onClick={() => post(`/api/admin/docs/${slug}/draft`, undefined, "draft")}>
            {busy === "draft" ? "Generating…" : "Update with AI"}
          </button>
        </div>
        {error && <p style={{ color: "var(--danger, #b91c1c)", margin: "10px 0 0", fontSize: 13 }}>{error}</p>}
      </div>
    );
  }

  // Draft pending: review + publish/discard.
  return (
    <div style={{ ...card, borderColor: "var(--accent, #2563eb)" }}>
      <div className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
        <strong>Draft v{review.version} awaiting review {review.generatedByAi ? "· AI-generated" : ""}</strong>
        <span className="note" style={{ fontSize: 13 }}>
          <span style={{ color: "var(--ok, #15803d)" }}>+{review.added}</span> / <span style={{ color: "var(--danger, #b91c1c)" }}>−{review.removed}</span> lines · {review.entriesConsidered} change-log {review.entriesConsidered === 1 ? "entry" : "entries"} considered
        </span>
      </div>

      <p style={{ margin: "10px 0 0" }}>{review.changeNote || "No change note provided."}</p>

      {review.shrunk && (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--danger, #b91c1c)" }}>
          ⚠ The draft is much shorter than the current version — check the diff for dropped content before publishing.
        </p>
      )}

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer" }}>Show changes</summary>
        <pre className="doc-diff">
          {review.diff.map((l, i) =>
            l.type === "same" && l.text === "" ? (
              <span key={i} className="doc-diff-gap">{"  ⋯\n"}</span>
            ) : (
              <span key={i} className={`doc-diff-${l.type}`}>{(l.type === "add" ? "+ " : l.type === "del" ? "- " : "  ") + l.text + "\n"}</span>
            )
          )}
        </pre>
      </details>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 14 }}>
        <a className="nav-link" style={{ padding: 0 }} href={`/api/docs/${slug}/download?format=html&version=${review.draftId}`} target="_blank" rel="noreferrer">
          Preview draft →
        </a>
        <span style={{ flex: 1 }} />
        <label className="note" style={{ fontSize: 13 }}>
          <input type="radio" name="bump" checked={bump === "minor"} onChange={() => setBump("minor")} /> Minor
        </label>
        <label className="note" style={{ fontSize: 13 }}>
          <input type="radio" name="bump" checked={bump === "major"} onChange={() => setBump("major")} /> Major
        </label>
        <button type="button" className="btn" disabled={busy !== null} onClick={() => post(`/api/admin/docs/${slug}/publish`, { versionId: review.draftId, bump }, "publish")}>
          {busy === "publish" ? "Publishing…" : "Publish"}
        </button>
        <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => post(`/api/admin/docs/${slug}/discard`, { versionId: review.draftId }, "discard")}>
          {busy === "discard" ? "Discarding…" : "Discard"}
        </button>
      </div>
      {error && <p style={{ color: "var(--danger, #b91c1c)", margin: "10px 0 0", fontSize: 13 }}>{error}</p>}
    </div>
  );
}
