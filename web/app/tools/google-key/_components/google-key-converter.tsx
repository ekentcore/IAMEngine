"use client";

// The interactive half of the Google key converter. Reads a picked JSON key file locally (never
// uploads it), parses it with the SAME seeder the guided create form uses
// (parseGoogleServiceAccountKey), and shows each Automation - API field value with a copy button.
// A parse failure names what was wrong with the file (not JSON / an OAuth-client download / missing
// client_email or private_key) — same messages the in-form upload gives.
import { useState } from "react";
import { parseGoogleServiceAccountKey, type SeededFields } from "@/lib/secrets/field-seeders";
import { CopyButton } from "@/app/_components/copy-button";

type Parsed = { values: SeededFields["values"]; note: string };

export function GoogleKeyConverter() {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same (fixed) file re-trigger onChange
    setError(null);
    setParsed(null);
    setReveal(false);
    if (!file) return;
    try {
      const seeded = parseGoogleServiceAccountKey(await file.text());
      setParsed({ values: seeded.values, note: seeded.note });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const base64 = parsed?.values.ClientSecret ?? "";
  const accountId = parsed?.values.accountid ?? "";

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ padding: "0.8rem 0.9rem", border: "1px dashed var(--line)", borderRadius: 8, maxWidth: 560 }}>
        <label className="note" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          Choose the downloaded <code>.json</code> key file
        </label>
        <input type="file" accept=".json,application/json" onChange={onFile} />
        <p className="note muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
          From the service account&rsquo;s <b>Keys → Add key → Create new key → JSON</b> in the Google Cloud Console.
        </p>
      </div>

      {error && (
        <p className="note danger" role="alert" style={{ marginTop: 12 }}>✗ {error}</p>
      )}

      {parsed && (
        <div style={{ marginTop: 16 }}>
          <p className="note" style={{ color: "var(--ok-fg)", marginBottom: 12 }}>✓ {parsed.note}</p>
          <p className="note" style={{ marginBottom: 10 }}>
            Create the secret from Delinea&rsquo;s <b>Automation - API</b> template and paste these in:
          </p>

          {/* ClientSecret — the base64 of the whole key file. Masked until revealed (it's key material),
              but always copyable; the copy button works even on plain-HTTP LAN (lib/clipboard fallback). */}
          <Field name="ClientSecret" required desc="base64 of the whole JSON key file (the private key material)">
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <textarea
                readOnly
                value={reveal ? base64 : "•".repeat(Math.min(base64.length, 64))}
                onFocus={(e) => e.currentTarget.select()}
                rows={3}
                style={{ flex: "1 1 320px", minWidth: 260, fontFamily: "var(--mono, monospace)", fontSize: 12, resize: "vertical" }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <CopyButton text={base64} label="⧉ copy" />
                <button type="button" style={{ fontSize: 11, padding: "1px 7px" }} onClick={() => setReveal((v) => !v)}>
                  {reveal ? "hide" : "reveal"}
                </button>
              </div>
            </div>
          </Field>

          <Field name="accountid" desc="the service account's own email (client_email) — needed only if ClientSecret ever holds a bare PEM instead of the JSON; harmless to include">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                readOnly
                value={accountId}
                onFocus={(e) => e.currentTarget.select()}
                style={{ flex: "1 1 320px", minWidth: 260, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
              />
              <CopyButton text={accountId} label="⧉ copy" />
            </div>
          </Field>

          <Field name="apiURL" required desc="you supply this — the Workspace super-admin email the service account impersonates (it's an email, not a URL; the stock template has no better field for it)">
            <p className="note muted" style={{ fontSize: 12, margin: 0 }}>
              Not in the key file — type the super-admin&rsquo;s email here in Delinea.
            </p>
          </Field>

          <Field name="ClientID" desc="optional — the Workspace customer ID (Admin Console → Account settings). Leave blank for my_customer">
            <p className="note muted" style={{ fontSize: 12, margin: 0 }}>Optional; leave blank unless you have a specific customer ID.</p>
          </Field>

          <p className="note muted" style={{ fontSize: 12, marginTop: 12 }}>
            Then wire the created secret&rsquo;s Delinea id to the client&rsquo;s <code>google-admin</code> reference, or
            paste these into the guided setup&rsquo;s <b>Create in Delinea</b> form. Nothing here is stored — reload and
            it&rsquo;s gone.
          </p>
        </div>
      )}
    </div>
  );
}

// One labelled Automation - API field row.
function Field({ name, desc, required, children }: { name: string; desc: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginBottom: 3 }}>
        <code style={{ fontSize: 13 }}>{name}</code>
        {required ? <span className="note" style={{ color: "var(--warn-fg)", fontSize: 11, marginLeft: 6 }}>required</span>
          : <span className="note muted" style={{ fontSize: 11, marginLeft: 6 }}>optional</span>}
      </div>
      <div className="note muted" style={{ fontSize: 11, marginBottom: 5 }}>{desc}</div>
      {children}
    </div>
  );
}
