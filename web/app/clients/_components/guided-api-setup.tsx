"use client";

// "Setup <system> API" — the guided credential-entry modal for a system with no full auto-provisioning
// flow (Mimecast / Spanning / Proofpoint today; see lib/secrets/api-setup-catalog.ts). Mirrors
// M365SetupButton's dialog + openSignal contract (menu-driven open, hideTrigger for a bare-modal use)
// and CreateInDelineaForm's field-requirements rendering, but folds BOTH of that form's paths — paste
// fresh fields, or wire an id already saved in Delinea — into one modal with a mode toggle.
//
//   • paste fields    — one <input> per REQUIRED field (SECRET_FIELD_REQUIREMENTS[secretName], same
//                        !f.optional filter as create-in-delinea) + a region <select> when the catalog
//                        entry carries regionOptions (Proofpoint). POSTs values straight to
//                        /secrets/create, which tests-then-vaults in one call.
//   • existing id     — one <input> for a Delinea secret id already holding this credential. POSTs to
//                        /secrets/test with wireOnPass so a passing test also wires it onto the client.
//
// Values never leave this component except in the one POST that uses them; only the verdict text (ok/
// error/hint) comes back and is rendered — never a credential value.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ApiSetupEntry } from "@/lib/secrets/api-setup-catalog";
import { SECRET_FIELD_REQUIREMENTS } from "@/lib/secrets/field-requirements";
import { buildGuidedValues } from "@/lib/secrets/guided-api-values";
import { isSecretish } from "./create-in-delinea";

type Mode = "paste" | "existing";
type Verdict = { ok: boolean; text: string };

export function GuidedApiSetup({
  slug,
  entry,
  openSignal,
  hideTrigger,
}: {
  slug: string;
  entry: ApiSetupEntry;
  openSignal?: number;
  hideTrigger?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("paste");
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [region, setRegion] = useState(entry.regionOptions?.[0] ?? "");
  const [externalId, setExternalId] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [done, setDone] = useState(false);
  // Refresh the page ONCE per successful save, mirroring M365SetupButton's refreshedOnDone guard.
  const refreshedOnDone = useRef(false);

  // Required fields only — optional ones (incl. Proofpoint's `Region`, which the select below owns
  // exclusively) have a runner fallback and are never collected here, same filter as create-in-delinea.
  const fields = (SECRET_FIELD_REQUIREMENTS[entry.secretName] ?? []).filter((f) => !f.optional);

  const openModal = useCallback(() => {
    setVerdict(null);
    setDone(false);
    setBusy(false);
    setValues({});
    setExternalId("");
    setRegion(entry.regionOptions?.[0] ?? "");
    setMode("paste");
    refreshedOnDone.current = false;
    dialogRef.current?.showModal();
  }, [entry.regionOptions]);

  // Menu-driven open: a change in openSignal (an incrementing counter) requests the modal — same
  // contract as M365SetupButton.
  useEffect(() => {
    if (openSignal === undefined || openSignal === 0) return;
    openModal();
  }, [openSignal, openModal]);

  function closeModal() {
    dialogRef.current?.close();
  }

  function markDone() {
    setDone(true);
    if (!refreshedOnDone.current) {
      refreshedOnDone.current = true;
      router.refresh();
    }
  }

  async function verifyAndSavePaste() {
    setBusy(true);
    setVerdict(null);
    try {
      const body = {
        name: entry.secretName,
        // Keyed by each field's CANONICAL synonym (f.anyOf[0]), not its human label — see
        // guided-api-values.ts. The region <select> (Proofpoint) contributes under "Region" only when
        // the catalog entry offers region options.
        values: buildGuidedValues(fields, values, entry.regionOptions ? region : undefined),
        label: `${entry.label} (auto)`,
      };
      const r = await fetch(`/api/clients/${slug}/secrets/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setVerdict({ ok: false, text: [d.error, d.hint].filter(Boolean).join(" — ") || `failed (${r.status})` });
        return;
      }
      setVerdict({ ok: true, text: `Saved — wired as ${entry.secretName} (Delinea id ${d.externalId}).` });
      markDone();
    } catch (e) {
      setVerdict({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function verifyAndSaveExisting() {
    const id = externalId.trim();
    if (!id) return;
    setBusy(true);
    setVerdict(null);
    try {
      const r = await fetch(`/api/clients/${slug}/secrets/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: [{ name: entry.secretName, externalId: id }], wireOnPass: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setVerdict({ ok: false, text: d.error ?? `failed (${r.status})` });
        return;
      }
      const result = Array.isArray(d.results) ? d.results[0] : null;
      if (!result) {
        setVerdict({ ok: false, text: "no result returned" });
        return;
      }
      if (result.ok && result.wired) {
        setVerdict({ ok: true, text: `Verified & wired${result.label ? ` as ${result.label}` : ""}.` });
        markDone();
      } else if (result.ok && !result.wired) {
        setVerdict({ ok: false, text: result.wireError ?? "verified but could not be wired" });
      } else {
        setVerdict({ ok: false, text: result.error ?? "verification failed" });
      }
    } catch (e) {
      setVerdict({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const canSubmitPaste = fields.every((f) => (values[f.label] ?? "").trim() !== "");
  const canSubmitExisting = externalId.trim() !== "";

  return (
    <>
      {!hideTrigger && (
        <button disabled={busy} onClick={openModal}>
          Setup {entry.label} API
        </button>
      )}

      <dialog ref={dialogRef} className="m365-setup-dialog">
        <h2>Setup {entry.label} API</h2>

        <ol className="note" style={{ paddingLeft: 18, margin: "0 0 0.5rem" }}>
          {entry.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <a className="button" href={entry.consoleUrl} target="_blank" rel="noreferrer">
          Open console ↗
        </a>

        <div className="toolbar" style={{ marginTop: "0.75rem" }}>
          <button type="button" className={mode === "paste" ? "primary" : undefined} disabled={busy} onClick={() => { setMode("paste"); setVerdict(null); }}>
            Paste fields
          </button>
          <button type="button" className={mode === "existing" ? "primary" : undefined} disabled={busy} onClick={() => { setMode("existing"); setVerdict(null); }}>
            Existing Delinea id
          </button>
        </div>

        {mode === "paste" ? (
          <div style={{ marginTop: "0.75rem" }}>
            {fields.map((f) => (
              <label key={f.label} style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>{f.label}</span>
                <input
                  type={isSecretish(f.label) ? "password" : "text"}
                  autoComplete="off"
                  disabled={busy}
                  value={values[f.label] ?? ""}
                  placeholder={f.hint ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setValues((prev) => ({ ...prev, [f.label]: v }));
                    setVerdict(null);
                  }}
                  style={{ width: 320 }}
                />
              </label>
            ))}
            {fields.length === 0 && (
              <p className="note muted">No field requirements known for this secret — add its fields in Delinea directly.</p>
            )}
            {entry.regionOptions && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span className="note" style={{ display: "block", marginBottom: 2 }}>Region</span>
                <select
                  value={region}
                  disabled={busy}
                  onChange={(e) => {
                    setRegion(e.target.value);
                    setVerdict(null);
                  }}
                >
                  {entry.regionOptions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : (
          <div style={{ marginTop: "0.75rem" }}>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span className="note" style={{ display: "block", marginBottom: 2 }}>Delinea secret id</span>
              <input
                type="text"
                autoComplete="off"
                disabled={busy}
                value={externalId}
                onChange={(e) => {
                  setExternalId(e.target.value);
                  setVerdict(null);
                }}
                style={{ width: 320 }}
              />
            </label>
          </div>
        )}

        {verdict && (
          <p className="note" style={{ color: verdict.ok ? "#2e7d32" : "#b91c1c" }}>
            {verdict.ok ? "✓ " : "✗ "}{verdict.text}
          </p>
        )}

        <div className="toolbar" style={{ marginTop: "0.9rem" }}>
          <span className="grow" />
          <button type="button" onClick={closeModal} disabled={busy}>{done ? "Close" : "Cancel"}</button>
          {!done && (
            <button
              type="button"
              className="primary"
              disabled={busy || (mode === "paste" ? !canSubmitPaste : !canSubmitExisting)}
              onClick={mode === "paste" ? verifyAndSavePaste : verifyAndSaveExisting}
            >
              {busy ? "Verifying…" : "Verify & save"}
            </button>
          )}
        </div>
      </dialog>
    </>
  );
}
