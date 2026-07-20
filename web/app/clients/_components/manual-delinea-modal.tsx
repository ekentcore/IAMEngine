"use client";

// Manual-fallback modal: shown when the app CAN'T write a secret to Delinea itself — no write account
// / folder / template configured (the common dev case), or a Delinea auth/create error. Instead of a
// dead-end red note, it shows exactly how to create the secret BY HAND in Secret Server: which
// template, which folder, and each field with the value the operator already typed (copyable) — then
// lets them paste the resulting Secret ID back to finish wiring it (the same end state as the
// automatic path). The values are only re-displayed from the create form's own in-memory state;
// nothing new is persisted or logged here.
import { useEffect, useRef, useState } from "react";
import type { FieldReq } from "@/lib/secrets/field-requirements";
import { copyText } from "@/lib/clipboard";
import { isSecretish } from "./create-in-delinea";

export function ManualDelineaModal({
  open,
  onClose,
  slug,
  secretName,
  templateName,
  folderId,
  fields,
  values,
  reason,
  onWired,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  secretName: string;
  templateName: string | null;
  folderId: string | null;
  fields: FieldReq[];
  values: Record<string, string>;
  reason: string | null;
  onWired: (externalId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pastedId, setPastedId] = useState("");
  const [wiring, setWiring] = useState(false);
  const [wireErr, setWireErr] = useState<string | null>(null);

  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);

  // Reset the paste-back state each time the modal (re)opens.
  useEffect(() => {
    if (open) { setPastedId(""); setWireErr(null); setWiring(false); }
  }, [open]);

  async function wire() {
    const id = pastedId.trim();
    if (!id) return;
    setWiring(true); setWireErr(null);
    try {
      const res = await fetch(`/api/clients/${slug}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: [{ name: secretName, externalId: id, label: null }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setWireErr((data as { error?: string }).error ?? res.statusText); return; }
      onWired(id);
    } catch (e) {
      setWireErr((e as Error).message);
    } finally {
      setWiring(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} style={{ width: 620, maxWidth: "95vw" }}>
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Create this secret in Delinea by hand</h2>
        <button onClick={onClose}>Close</button>
      </div>
      <p className="note" style={{ marginTop: 4 }}>
        The app couldn&rsquo;t write <code>{secretName}</code> to Delinea automatically
        {reason ? <> — {reason}</> : null}. Create it yourself in Secret Server using the values below, then
        paste the new Secret ID back here to wire it onto this client.
      </p>

      {/* Where it goes */}
      <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "0.5rem 0.7rem", margin: "0.6rem 0", display: "grid", gap: 4, fontSize: 13 }}>
        <div><span className="muted" style={{ display: "inline-block", minWidth: 90 }}>Template</span> <b>{templateName ?? "the appropriate credential template"}</b></div>
        <div><span className="muted" style={{ display: "inline-block", minWidth: 90 }}>Folder</span> {folderId ? <code>{folderId}</code> : <span>this client&rsquo;s Delinea folder</span>}</div>
        <div><span className="muted" style={{ display: "inline-block", minWidth: 90 }}>Secret name</span> anything descriptive (the runner finds it by the id you paste back, not the name)</div>
      </div>

      {/* Fields to fill out */}
      <label className="note" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Fields to fill out</label>
      <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "0.4rem 0.6rem", display: "grid", gap: 8 }}>
        {fields.map((f) => (
          <FieldRow key={f.label} field={f} value={values[f.label] ?? ""} />
        ))}
        {fields.length === 0 && <span className="muted" style={{ fontSize: 13 }}>No known fields for this secret — add its fields in Delinea directly.</span>}
      </div>

      {/* Paste-back */}
      <label className="note" style={{ display: "block", fontWeight: 600, marginTop: 12 }}>
        Secret ID (paste after you create it in Delinea)
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
        <input
          value={pastedId}
          onChange={(e) => setPastedId(e.target.value)}
          placeholder="e.g. 40213"
          style={{ width: 200, fontFamily: "var(--mono, monospace)" }}
        />
        <button className="primary" onClick={wire} disabled={wiring || !pastedId.trim()}>
          {wiring ? "Wiring…" : "Wire it"}
        </button>
        {wireErr && <span className="note danger" style={{ flexBasis: "100%" }}>{wireErr}</span>}
      </div>

      <div className="dialog-actions">
        <button onClick={onClose}>Done</button>
      </div>
    </dialog>
  );
}

// One field row: the Delinea field NAME (the first synonym is the canonical template field), the value
// the operator already typed (copyable; secret-ish values masked behind a reveal toggle), and the hint.
function FieldRow({ field, value }: { field: FieldReq; value: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const secret = isSecretish(field.label);
  const delineaField = field.anyOf[0];
  const shown = value === "" ? "" : secret && !revealed ? "••••••••" : value;

  return (
    <div style={{ display: "grid", gap: 2 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b style={{ minWidth: 130, fontSize: 13 }}>{delineaField}</b>
        <code style={{ flex: 1, fontSize: 13, wordBreak: "break-all", opacity: value === "" ? 0.5 : 1 }}>
          {value === "" ? "(you didn't enter this)" : shown}
        </code>
        {secret && value !== "" && (
          <button style={{ fontSize: 12 }} onClick={() => setRevealed((r) => !r)}>{revealed ? "Hide" : "Show"}</button>
        )}
        {value !== "" && (
          <button
            style={{ fontSize: 12 }}
            onClick={() => { void copyText(value).then((ok) => setCopied(ok)); setTimeout(() => setCopied(false), 1500); }}
          >
            {copied ? "Copied ✓" : "Copy"}
          </button>
        )}
      </div>
      <span className="muted" style={{ fontSize: 11 }}>
        {field.label}{field.hint ? ` — ${field.hint}` : ""}
      </span>
    </div>
  );
}
