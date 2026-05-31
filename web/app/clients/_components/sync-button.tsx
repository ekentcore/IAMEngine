"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type SyncResult = {
  total: number;
  created: number;
  updated: number;
  reconciled: number;
  errors: Array<{ sysId: string; name: string; reason: string }>;
};

export function SyncButton() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Open the modal as soon as a refresh starts so the user sees progress.
  function openModal() {
    if (!ref.current?.open) ref.current?.showModal();
  }

  async function refresh() {
    setBusy(true);
    setResult(null);
    setError(null);
    openModal();
    try {
      const res = await fetch("/api/clients/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? res.statusText);
      else setResult(data as SyncResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    ref.current?.close();
    if (result) router.refresh(); // pull the freshly-synced rows into the list
  }

  // Refresh the list when the dialog is dismissed via Esc as well.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClose = () => {
      if (result) router.refresh();
    };
    el.addEventListener("close", onClose);
    return () => el.removeEventListener("close", onClose);
  }, [result, router]);

  return (
    <>
      <button className="primary" onClick={refresh} disabled={busy}>
        Refresh from ServiceNow
      </button>

      <dialog ref={ref}>
        <h2>Refresh from ServiceNow</h2>

        {busy && (
          <p className="note">
            <span className="spinner" />
            Pulling the in-scope client roster…
          </p>
        )}

        {!busy && error && (
          <p className="note danger">Sync failed: {error}</p>
        )}

        {!busy && result && (
          <div style={{ marginTop: "0.5rem" }}>
            <div className="kv"><span className="muted">Records seen</span><span>{result.total}</span></div>
            <div className="kv"><span className="muted">Created</span><span>{result.created}</span></div>
            <div className="kv"><span className="muted">Linked to profiles</span><span>{result.reconciled}</span></div>
            <div className="kv"><span className="muted">Updated</span><span>{result.updated}</span></div>
            <div className="kv">
              <span className="muted">Errors</span>
              <span className={result.errors.length ? "danger" : ""}>{result.errors.length}</span>
            </div>
            {result.errors.length > 0 && (
              <ul className="note" style={{ marginTop: "0.5rem", maxHeight: 120, overflow: "auto" }}>
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={i}>{e.name || e.sysId}: {e.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button onClick={close} disabled={busy} className={result || error ? "primary" : ""}>
            {busy ? "Working…" : "Close"}
          </button>
        </div>
      </dialog>
    </>
  );
}
