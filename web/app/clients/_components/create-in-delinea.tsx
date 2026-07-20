"use client";

// Inline "Create in Delinea" form: the guided-setup path where an operator ENTERS a credential's raw
// fields, the app TESTS them, and only then writes the secret to Secret Server and wires the returned
// id. Flow: type fields → Test & create → (probe the values) → on success POST /secrets/create → the
// created id comes back via onCreated. The values live only in this component's state and the two
// requests; nothing is echoed back or persisted here.
import { useState } from "react";
import type { FieldReq } from "@/lib/secrets/field-requirements";
import { ManualDelineaModal } from "./manual-delinea-modal";

// Heuristic: which fields render as password inputs (so a shoulder-surfer can't read the value).
export const isSecretish = (label: string) => /pass|secret|token|key|certificate|thumbprint/i.test(label);

// The verdict shape returned by POST /secrets/probe (mirrors ValueProbe in lib/secrets/value-probe.ts).
type ProbeResult = { probeable: boolean; blocking: boolean; ok?: boolean; error?: string; hint?: string; label?: string; kind?: "live" | "agent" };

export type CreateCapability = {
  hasAccount: boolean; // instance-level write account present
  hasTemplate: boolean; // a template id is mapped for this secret
  folderId: string | null; // client's resolved folder id, or null (→ collect inline)
  templateName: string | null; // the Delinea template's human name (for the manual fallback guide)
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
  const [phase, setPhase] = useState<"idle" | "testing" | "creating">("idle");
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // When the app can't write to Delinea itself, we pop a "do it by hand" modal instead of dead-ending.
  const [manual, setManual] = useState<{ open: boolean; reason: string | null }>({ open: false, reason: null });
  const needsFolder = !capability.folderId;
  const busy = phase !== "idle";

  // Test the entered values without writing anything. Returns the verdict so the caller (Test & create)
  // can decide whether to proceed.
  async function runProbe(): Promise<ProbeResult | null> {
    setError(null);
    try {
      const res = await fetch(`/api/clients/${slug}/secrets/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: secretName, values }),
      });
      const data = (await res.json().catch(() => ({}))) as ProbeResult & { error?: string };
      if (!res.ok) {
        setError(data.error ?? res.statusText);
        return null;
      }
      setProbe(data);
      return data;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  async function create() {
    try {
      const res = await fetch(`/api/clients/${slug}/secrets/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: secretName, values, folderId: needsFolder ? folderId.trim() : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The app couldn't write it (no write config, or a Delinea auth/create error) → offer the
        // manual "create it in Delinea by hand" path instead of a dead-end error.
        if (data.manualFallback) {
          setManual({ open: true, reason: data.error ?? null });
          return;
        }
        // The create route re-checks a blocking probe server-side; surface its hint too.
        setError([data.error, data.hint].filter(Boolean).join(" — ") || res.statusText);
        return;
      }
      onCreated(data.externalId as string);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // "Test only" — show the verdict, write nothing.
  async function onTest() {
    setPhase("testing");
    await runProbe();
    setPhase("idle");
  }

  // "Test & create" — probe first; a BLOCKING failure stops before any write. An advisory verdict
  // (e.g. ad-dc's runner-comms check) is shown but never blocks — the secret must exist before the
  // runner can do the real bind.
  async function onTestAndCreate() {
    setPhase("testing");
    const p = await runProbe();
    if (p && p.probeable && p.blocking && p.ok === false) {
      setPhase("idle"); // refuse the write — the credential was proven not to work
      return;
    }
    if (!p) {
      setPhase("idle"); // probe request itself failed (error already set)
      return;
    }
    setPhase("creating");
    await create();
    setPhase("idle");
  }

  // Only the REQUIRED fields are collected (optional ones have a runner fallback); operators can still
  // add extra fields to the secret in Delinea directly.
  const fields = fieldRequirements.filter((f) => !f.optional);
  const canSubmit = fields.length > 0 && !(needsFolder && !folderId.trim());

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.8rem 0.9rem", marginTop: 8, maxWidth: 480 }}>
      <div className="note" style={{ marginBottom: 8 }}>
        Enter this credential&rsquo;s fields — the app tests them, then creates the secret in{" "}
        <code>{secretName}</code>&rsquo;s Delinea folder and wires the id. Values are sent to test/create and never stored here.
      </div>
      {needsFolder && (
        <label style={{ display: "block", marginBottom: 8 }}>
          <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea folder id (saved to this client)</span>
          <input value={folderId} onChange={(e) => setFolderId(e.target.value)} placeholder="e.g. 142" style={{ width: 160, fontFamily: "var(--mono, monospace)" }} />
        </label>
      )}
      {fields.map((f) => (
        <label key={f.label} style={{ display: "block", marginBottom: 10 }}>
          <span className="note" style={{ display: "block", marginBottom: 2 }}>{f.label}</span>
          <input
            type={isSecretish(f.label) ? "password" : "text"}
            autoComplete="off"
            value={values[f.label] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setValues((prev) => ({ ...prev, [f.label]: v }));
              setProbe(null); // an edit invalidates a prior test verdict
            }}
            style={{ width: 300 }}
          />
          {f.hint && <span className="note muted" style={{ display: "block", fontSize: 11, marginTop: 2 }}>{f.hint}</span>}
        </label>
      ))}
      {fields.length === 0 && (
        <p className="note muted">No field requirements known for this secret — add its fields in Delinea directly.</p>
      )}

      {/* Test verdict */}
      {probe && (
        <div style={{ marginBottom: 8 }}>
          {probe.ok
            ? <span className="badge" style={{ color: "var(--ok-fg)", background: "var(--ok-bg)", borderColor: "transparent" }}>✓ {probe.label ?? "tested ok"}</span>
            : probe.blocking
              ? <span className="badge" style={{ color: "var(--err-fg)", background: "var(--err-bg)", borderColor: "transparent" }}>✗ {probe.error ?? "failed"}</span>
              : <span className="badge" style={{ color: "var(--warn-fg)", background: "var(--warn-bg)", borderColor: "transparent" }}>⚠ {probe.error ?? "not verified"}</span>}
          {probe.hint && <span className="note muted" style={{ display: "block", fontSize: 12, marginTop: 4 }}>{probe.hint}</span>}
          {!probe.ok && !probe.blocking && (
            <span className="note muted" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
              You can still create it — the runner verifies the credential once it&rsquo;s online.
            </span>
          )}
        </div>
      )}

      <div className="dialog-actions" style={{ justifyContent: "flex-start", marginTop: 4, flexWrap: "wrap" }}>
        <button className="primary" onClick={onTestAndCreate} disabled={busy || !canSubmit}>
          {phase === "testing" ? "Testing…" : phase === "creating" ? "Creating…" : "Test & create"}
        </button>
        <button onClick={onTest} disabled={busy || !canSubmit} style={{ fontSize: 13 }}>Test only</button>
        <button onClick={onCancel} disabled={busy}>Cancel</button>
        {error && <span className="note danger" style={{ flexBasis: "100%" }}>{error}</span>}
      </div>

      <ManualDelineaModal
        open={manual.open}
        onClose={() => setManual({ open: false, reason: null })}
        slug={slug}
        secretName={secretName}
        templateName={capability.templateName}
        folderId={capability.folderId}
        fields={fields}
        values={values}
        reason={manual.reason}
        onWired={(id) => { setManual({ open: false, reason: null }); onCreated(id); }}
      />
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
