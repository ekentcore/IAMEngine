"use client";

// Inline "Create in Delinea" form: one input per required field for a credential, plus (when the
// client has no folder configured yet) a folder-id input. Create → POST /secrets/create, which
// creates the secret in Secret Server and wires the returned id onto the client. The values live only
// in this component's state and the single request; nothing is echoed back or persisted here.
import { useState } from "react";
import type { FieldReq } from "@/lib/secrets/field-requirements";

// Heuristic: which fields render as password inputs (so a shoulder-surfer can't read the value).
const isSecretish = (label: string) => /pass|secret|token|key|certificate|thumbprint/i.test(label);

export type CreateCapability = {
  hasAccount: boolean; // instance-level write account present
  hasTemplate: boolean; // a template id is mapped for this secret
  folderId: string | null; // client's resolved folder id, or null (→ collect inline)
};

export function CreateInDelineaForm({
  slug,
  secretName,
  fieldRequirements,
  capability,
  onCreated,
  onCancel,
}: {
  slug: string;
  secretName: string;
  fieldRequirements: FieldReq[];
  capability: CreateCapability;
  onCreated: (externalId: string) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsFolder = !capability.folderId;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}/secrets/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: secretName, values, folderId: needsFolder ? folderId.trim() : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? res.statusText);
        return;
      }
      onCreated(data.externalId as string);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Only the REQUIRED fields are collected (optional ones have a runner fallback); operators can still
  // add extra fields to the secret in Delinea directly.
  const fields = fieldRequirements.filter((f) => !f.optional);

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.8rem 0.9rem", marginTop: 8, maxWidth: 460 }}>
      <div className="note" style={{ marginBottom: 8 }}>
        Create <code>{secretName}</code> in Delinea — the app creates the secret in this client&rsquo;s folder and wires
        the id. Values are sent once and never stored here.
      </div>
      {needsFolder && (
        <label style={{ display: "block", marginBottom: 8 }}>
          <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea folder id (saved to this client)</span>
          <input value={folderId} onChange={(e) => setFolderId(e.target.value)} placeholder="e.g. 142" style={{ width: 160, fontFamily: "var(--mono, monospace)" }} />
        </label>
      )}
      {fields.map((f) => (
        <label key={f.label} style={{ display: "block", marginBottom: 8 }}>
          <span className="note" style={{ display: "block", marginBottom: 2 }}>{f.label}</span>
          <input
            type={isSecretish(f.label) ? "password" : "text"}
            autoComplete="off"
            value={values[f.label] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.label]: e.target.value }))}
            style={{ width: 280 }}
          />
        </label>
      ))}
      {fields.length === 0 && (
        <p className="note muted">No field requirements known for this secret — add its fields in Delinea directly.</p>
      )}
      <div className="dialog-actions" style={{ justifyContent: "flex-start", marginTop: 8 }}>
        <button className="primary" onClick={submit} disabled={busy || fields.length === 0 || (needsFolder && !folderId.trim())}>
          {busy ? "Creating…" : "Create secret"}
        </button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
        {error && <span className="note danger">{error}</span>}
      </div>
    </div>
  );
}

// Tooltip text for a disabled "Create in Delinea" button — says what config is missing.
export function createDisabledReason(cap: CreateCapability): string | null {
  const missing: string[] = [];
  if (!cap.hasAccount) missing.push("a Delinea write account");
  if (!cap.hasTemplate) missing.push("this secret's template id");
  if (missing.length === 0) return null;
  return `Configure ${missing.join(" and ")} to create secrets in-app (see the Delinea setup guide).`;
}
