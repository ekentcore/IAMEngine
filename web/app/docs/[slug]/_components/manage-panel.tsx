"use client";

// Admin panel for a document (global_admin+). With no pending draft it offers "Update with AI" (a
// staged progress modal) and "Upload" (drop back an edited .docx/.md as the next draft). With a draft
// pending it shows the change note + redline for review, a preview download, an override for the
// server-side shrink guard, and Publish / Discard. Every action re-guards on the server; this is the
// UI half.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DocDiff, type DiffLine } from "./doc-diff";
import { AiUpdateModal } from "./ai-update-modal";

type Review = {
  draftId: string;
  version: string;
  changeNote: string;
  entriesConsidered: number;
  generatedByAi: boolean;
  shrunk: boolean;
  added: number;
  removed: number;
  diff: DiffLine[];
} | null;

export function ManagePanel({
  slug,
  currentVersion,
  pendingEntries,
  review,
}: {
  slug: string;
  currentVersion: string | null;
  pendingEntries: number;
  review: Review;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState<"minor" | "major">("minor");
  const [allowShrink, setAllowShrink] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  async function upload(file: File) {
    setBusy("upload");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/admin/docs/${slug}/upload`, { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? `upload failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const card: React.CSSProperties = { border: "1px solid var(--line, #e5e7eb)", borderRadius: 10, padding: 16, marginTop: 20 };

  // No draft: the update + upload affordances.
  if (!review) {
    return (
      <div style={card}>
        <div className="row-between" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <strong>Update with AI</strong>
            <p className="note" style={{ margin: "4px 0 0" }}>
              {currentVersion ? (
                pendingEntries > 0
                  ? `Reads the ${pendingEntries} change-log ${pendingEntries === 1 ? "entry" : "entries"} logged since v${currentVersion} and proposes a revised draft for your review.`
                  : `No change-log entries logged since v${currentVersion}. You can still run an update to re-check.`
              ) : "Publish an initial version before running an AI update."}
              {" "}Or download the document, edit it, and upload it back as a draft.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => fileRef.current?.click()}>
              {busy === "upload" ? "Uploading…" : "Upload"}
            </button>
            <button type="button" className="btn" disabled={!currentVersion || busy !== null} onClick={() => setShowModal(true)}>
              Update with AI
            </button>
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".docx,.md,.markdown,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
        {error && <p style={{ color: "var(--danger, #b91c1c)", margin: "10px 0 0", fontSize: 13 }}>{error}</p>}
        {/* Always mounted, toggled by `open` — mounting on click would double-fire the POST under
            React StrictMode, and a lingering flag could re-trigger a generation. */}
        <AiUpdateModal open={showModal} slug={slug} entryCount={pendingEntries} onClose={() => setShowModal(false)} />
      </div>
    );
  }

  // Draft pending: review + publish/discard.
  return (
    <div style={{ ...card, borderColor: "var(--accent, #2563eb)" }}>
      <div className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
        <strong>Draft v{review.version} awaiting review {review.generatedByAi ? "· AI-generated" : "· uploaded"}</strong>
        <span className="note" style={{ fontSize: 13 }}>
          <span style={{ color: "var(--ok, #15803d)" }}>+{review.added}</span> / <span style={{ color: "var(--danger, #b91c1c)" }}>−{review.removed}</span> lines
          {review.generatedByAi && <> · {review.entriesConsidered} change-log {review.entriesConsidered === 1 ? "entry" : "entries"} considered</>}
        </span>
      </div>

      <p style={{ margin: "10px 0 0" }}>{review.changeNote || "No change note provided."}</p>

      {review.shrunk && (
        <div style={{ margin: "10px 0 0", padding: 10, borderRadius: 8, background: "color-mix(in srgb, var(--danger) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--danger) 30%, var(--line))" }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--danger, #b91c1c)" }}>
            ⚠ This draft is much shorter than the current version — it may have dropped content. Review the redline below, then confirm to publish.
          </p>
          <label className="note" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" checked={allowShrink} onChange={(e) => setAllowShrink(e.target.checked)} />
            I reviewed the removals — publish anyway
          </label>
        </div>
      )}

      <details style={{ marginTop: 12 }} open>
        <summary style={{ cursor: "pointer" }}>Redline</summary>
        <DocDiff diff={review.diff} />
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
        <button
          type="button"
          className="btn"
          disabled={busy !== null || (review.shrunk && !allowShrink)}
          title={review.shrunk && !allowShrink ? "Confirm the shrink warning above to publish" : undefined}
          onClick={() => post(`/api/admin/docs/${slug}/publish`, { versionId: review.draftId, bump, allowShrink }, "publish")}
        >
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
