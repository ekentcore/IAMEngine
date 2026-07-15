"use client";

// Progress modal for "Update with AI". The update is a single blocking POST, so we show a staged
// checklist that reflects where we are: the change-log read is known instantly (client-side), the
// model call is the long step (spinner + live elapsed + provider name), then parsing and building the
// redline flip when the request resolves. On success we refresh the page so the server-rendered draft
// review appears and close the dialog; on error we show the message with Retry.
//
// The dialog is always mounted and driven by `open` (a native <dialog>, so Escape + focus-trapping
// come for free). Mounting-on-click would double-fire the POST under React StrictMode; instead we
// start exactly one run per open-transition, guarded by a ref, and an in-flight token ignores a
// superseded run. onClose is called after success so the parent's open flag can't linger and
// re-trigger a fresh generation later.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Stage = "idle" | "asking" | "parsing" | "redline" | "done" | "error";

const STEPS: { key: Stage; label: string }[] = [
  { key: "asking", label: "Asking the model" },
  { key: "parsing", label: "Parsing the response" },
  { key: "redline", label: "Building the redline" },
];
const ORDER: Stage[] = ["asking", "parsing", "redline", "done"];

export function AiUpdateModal({ open, slug, entryCount, onClose }: { open: boolean; slug: string; entryCount: number; onClose: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const runToken = useRef(0);
  const startedForOpen = useRef(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [providerName, setProviderName] = useState<string | null>(null);

  // Open/close the native dialog to match the `open` prop.
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);

  // Fetch the provider name lazily when the dialog first opens (cosmetic; failure is silent).
  useEffect(() => {
    if (!open || providerName) return;
    let cancelled = false;
    fetch("/api/admin/docs/provider")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j?.name) setProviderName(j.name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, providerName]);

  const run = useCallback(() => {
    const token = ++runToken.current;
    setStage("asking");
    setError(null);
    setElapsed(0);
    (async () => {
      try {
        const res = await fetch(`/api/admin/docs/${slug}/draft`, { method: "POST", headers: { "content-type": "application/json" } });
        if (token !== runToken.current) return; // superseded (retry) or closed
        setStage("parsing");
        const json = await res.json().catch(() => ({}));
        if (token !== runToken.current) return;
        if (!res.ok) {
          setError(json.error ?? `the update failed (${res.status})`);
          setStage("error");
          return;
        }
        setStage("redline");
        // Let the "redline" tick paint, then bring in the server-rendered review panel and close.
        setTimeout(() => {
          if (token !== runToken.current) return;
          setStage("done");
          router.refresh();
          onClose();
        }, 400);
      } catch (e) {
        if (token !== runToken.current) return;
        setError(e instanceof Error ? e.message : "the update request failed");
        setStage("error");
      }
    })();
  }, [slug, onClose, router]);

  // Start exactly one run per open-transition. On close, arm the next open.
  useEffect(() => {
    if (!open) {
      startedForOpen.current = false;
      runToken.current++; // abandon any in-flight run's UI updates
      setStage("idle");
      return;
    }
    if (startedForOpen.current) return;
    startedForOpen.current = true;
    run();
  }, [open, run]);

  // Live elapsed timer, only while the model call is outstanding.
  useEffect(() => {
    if (stage !== "asking") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const stageIndex = ORDER.indexOf(stage);
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
  const busy = stage === "asking" || stage === "parsing" || stage === "redline";

  return (
    <dialog
      ref={ref}
      className="doc-modal"
      aria-label="Updating document with AI"
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault(); // don't let Escape close mid-request
      }}
    >
      <strong style={{ fontSize: 15 }}>Updating with AI</strong>

      <ul className="doc-steps">
        <li className="doc-step doc-step-done">
          <span className="doc-step-mark">✓</span>
          <span>Read the change log <span className="note">· {entryCount} {entryCount === 1 ? "entry" : "entries"}</span></span>
        </li>
        {STEPS.map((s) => {
          const idx = ORDER.indexOf(s.key);
          const done = stage !== "error" && stageIndex > idx;
          const active = stage === s.key;
          return (
            <li key={s.key} className={`doc-step ${done ? "doc-step-done" : active ? "doc-step-active" : "doc-step-idle"}`}>
              <span className="doc-step-mark">{done ? "✓" : active ? <span className="doc-spinner" aria-hidden /> : "○"}</span>
              <span>
                {s.label}
                {s.key === "asking" && active && (
                  <span className="note"> · {mmss}{providerName ? ` · via ${providerName}` : ""}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {stage === "error" && <p className="doc-modal-error">{error}</p>}
      {stage === "done" && <p className="note" style={{ margin: "6px 0 0" }}>Draft ready — review the redline below.</p>}

      <div className="dialog-actions" style={{ marginTop: 16 }}>
        {stage === "error" ? (
          <>
            <button type="button" className="btn btn-quiet" onClick={onClose}>Close</button>
            <button type="button" className="btn" onClick={run}>Retry</button>
          </>
        ) : (
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>
            {busy ? "Working…" : "Close"}
          </button>
        )}
      </div>
    </dialog>
  );
}
