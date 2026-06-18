"use client";

// Self-service Exchange Online certificate generator. Enter a password -> get the public .cer to
// download (upload to the app registration) and the exact Delinea fields to paste
// (CertificateBase64 / CertificatePassword), plus the thumbprint to verify the upload. No openssl,
// no Finder, no private key left on disk.
import { useState } from "react";
import { generateExoCertAction } from "../cert-actions";

type Cert = { cerPem: string; pfxBase64: string; password: string; thumbprintSha1: string; subject: string; notAfter: string };

function CopyField({ label, value, mono = true, area = false }: { label: string; value: string; mono?: boolean; area?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <b style={{ fontSize: 13 }}>{label}</b>
        <button type="button" onClick={copy} style={{ fontSize: 11, padding: "1px 8px" }}>{copied ? "✓ copied" : "Copy"}</button>
      </div>
      {area ? (
        <textarea readOnly value={value} rows={4} onFocus={(e) => e.currentTarget.select()}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 11, wordBreak: "break-all" }} />
      ) : (
        <code onClick={(e) => { const r = document.createRange(); r.selectNodeContents(e.currentTarget); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }}
          style={{ display: "block", padding: "4px 8px", background: "#f6f8fa", borderRadius: 4, fontFamily: mono ? "monospace" : "inherit", fontSize: 12, wordBreak: "break-all", cursor: "text" }}>{value}</code>
      )}
    </div>
  );
}

export function ExoCertTool() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [cn, setCn] = useState("iam-engine-exo");
  const [days, setDays] = useState(730);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cert, setCert] = useState<Cert | null>(null);

  async function generate() {
    setBusy(true); setError(null); setCert(null);
    const res = await generateExoCertAction({ password, commonName: cn, days });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    setCert(res.cert);
  }

  function downloadCer() {
    if (!cert) return;
    const blob = new Blob([cert.cerPem], { type: "application/x-x509-ca-cert" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${cert.subject}.cer`; a.click();
    URL.revokeObjectURL(url);
  }

  if (!open) {
    return (
      <div style={{ margin: "0.6rem 0" }}>
        <button onClick={() => setOpen(true)}>🔐 Generate the certificate for me</button>
        <span className="note" style={{ marginLeft: 8 }}>no openssl needed — get the .cer to upload + the exact Delinea fields to paste.</span>
      </div>
    );
  }

  return (
    <div style={{ border: "1px solid #bfdbfe", background: "#f8fbff", borderRadius: 8, padding: "0.8rem 1rem", margin: "0.6rem 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <b>Generate Exchange Online certificate</b>
        <button onClick={() => setOpen(false)} aria-label="Close" style={{ fontSize: 12 }}>×</button>
      </div>
      <p className="note" style={{ margin: "0.3rem 0 0.6rem" }}>
        Creates a fresh 2048-bit self-signed cert in your browser session (nothing is stored). Pick a password for the
        private key — you&rsquo;ll paste it into Delinea as <code>CertificatePassword</code>.
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
        <label style={{ fontSize: 12 }}>Private-key password<br />
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="at least 8 characters" style={{ width: 220 }} />
        </label>
        <label style={{ fontSize: 12 }}>Common name<br />
          <input value={cn} onChange={(e) => setCn(e.target.value)} style={{ width: 160 }} />
        </label>
        <label style={{ fontSize: 12 }}>Valid (days)<br />
          <input type="number" value={days} min={30} max={1095} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 90 }} />
        </label>
        <button className="primary" onClick={generate} disabled={busy || password.trim().length < 8}>{busy ? "Generating…" : "Generate"}</button>
      </div>
      {error && <p className="note danger">{error}</p>}

      {cert && (
        <div style={{ marginTop: 12, borderTop: "1px solid #dbeafe", paddingTop: 10 }}>
          <p className="note" style={{ marginTop: 0 }}>✓ Generated. Do these three things:</p>

          <ol style={{ fontSize: 13, marginTop: 4 }}>
            <li style={{ marginBottom: 8 }}>
              <b>Download the public cert and upload it to the app registration</b> (Certificates &amp; secrets → Certificates → Upload):
              <div><button onClick={downloadCer} style={{ marginTop: 4 }}>⬇ Download {cert.subject}.cer</button></div>
            </li>
            <li style={{ marginBottom: 8 }}>
              <b>Paste these into the m365-admin secret in Delinea:</b>
              <div style={{ marginTop: 6 }}>
                <CopyField label="CertificateBase64" value={cert.pfxBase64} area />
                <CopyField label="CertificatePassword" value={cert.password} />
              </div>
            </li>
            <li>
              <b>Verify</b> the uploaded cert&rsquo;s thumbprint in Entra matches:
              <div style={{ marginTop: 4 }}><CopyField label="Thumbprint (SHA-1)" value={cert.thumbprintSha1} /></div>
              <span className="note">Expires {new Date(cert.notAfter).toLocaleDateString()}. The private key only exists in the base64 above — it&rsquo;s never written to disk or stored by the app.</span>
            </li>
          </ol>
          <p className="note" style={{ color: "#92400e" }}>⚠ Keep this page private while the base64 is shown — it contains the private key. It clears when you close this tool or reload.</p>
        </div>
      )}
    </div>
  );
}
