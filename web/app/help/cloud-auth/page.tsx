// In-app setup guide: the Entra app registration (and, for hybrid clients, the certificate) the
// runner needs for app-only M365 (Graph) and Exchange Online automation. The credential panels
// link here with ?type=cloud or ?type=hybrid so the page shows ONLY the steps that client needs —
// no "do I need a certificate?" homework. Without the param it asks one question up front.
// Keep in sync with Connect-CtgM365 / Connect-CtgExchange in the runner.
import Link from "next/link";

const Code = ({ children }: { children: string }) => (
  <pre style={{ background: "#f6f6f6", border: "1px solid #e2e2e2", borderRadius: 4, padding: "8px 10px", overflowX: "auto", fontSize: 12 }}>
    <code>{children}</code>
  </pre>
);

export default function CloudAuthSetupPage({ searchParams }: { searchParams?: { type?: string } }) {
  const type = searchParams?.type === "cloud" || searchParams?.type === "hybrid" ? searchParams.type : null;

  // No variant chosen (e.g. reached from the Health page): one question, then the right guide.
  if (!type) {
    return (
      <main style={{ maxWidth: 820 }}>
        <p className="note"><Link href="/clients">← Clients</Link></p>
        <h1>Cloud auth setup (M365 + Exchange Online)</h1>
        <p className="note">
          The runner authenticates to Microsoft app-only (no user/MFA) via an <b>Entra app registration</b>,
          set up once per client. What the client needs depends on one thing:
        </p>
        <p style={{ fontSize: 15, fontWeight: 500 }}>Does this client&rsquo;s plan include an <code>exchange</code> step (on-prem Exchange)?</p>
        <ul style={{ lineHeight: 2 }}>
          <li><Link href="/help/cloud-auth?type=cloud"><b>No — cloud-only client</b> → app registration + client secret (no certificate)</Link></li>
          <li><Link href="/help/cloud-auth?type=hybrid"><b>Yes — hybrid client</b> → app registration + client secret + certificate</Link></li>
        </ul>
        <p className="note">Tip: the Credentials panel on the client/case page links straight to the right one.</p>
      </main>
    );
  }

  const hybrid = type === "hybrid";
  let n = 0;
  const step = () => ++n;

  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/clients">← Clients</Link> · <Link href={`/help/cloud-auth?type=${hybrid ? "cloud" : "hybrid"}`}>switch to the {hybrid ? "cloud-only" : "hybrid"} guide</Link></p>
      <h1>M365 auth setup — {hybrid ? "hybrid client" : "cloud-only client"}</h1>
      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        {hybrid ? (
          <>This client has <b>on-prem Exchange</b>, so the app registration needs a <b>client secret</b> (for the M365 / Graph step)
            {" "}<b>and a certificate + the Exchange Administrator role</b> (Exchange Online app-only is certificate-based). Do all the steps below, once.</>
        ) : (
          <>This client is <b>cloud-only</b> — <b>no certificate needed</b>. Just an app registration with a <b>client secret</b>. Do the steps below, once.</>
        )}
      </div>

      <h2>{step()}. Register the app</h2>
      <ol>
        <li>Entra ID → <b>App registrations</b> → <b>New registration</b>.</li>
        <li>Name: <code>iam-engine — &lt;client&gt;</code>. Account types: <b>Single tenant</b>. No redirect URI. <b>Register</b>.</li>
        <li>Copy the <b>Application (client) ID</b> and the <b>Directory (tenant) ID</b>.</li>
      </ol>

      <h2>{step()}. API permissions (application, not delegated)</h2>
      <ul>
        <li><b>Microsoft Graph</b> → Application permissions → <code>User.ReadWrite.All</code>, <code>Group.ReadWrite.All</code>, <code>Organization.Read.All</code> (license/seat counts; add <code>Directory.Read.All</code> if you resolve managers by name).</li>
        {hybrid && (
          <li><b>APIs my organization uses</b> → <b>Office 365 Exchange Online</b> → Application permissions → <code>Exchange.ManageAsApp</code>.</li>
        )}
        <li>Click <b>Grant admin consent</b> (the statuses must show a green check).</li>
      </ul>

      <h2>{step()}. Client secret (for the M365 / Graph step)</h2>
      <ol>
        <li>Certificates &amp; secrets → <b>Client secrets</b> → <b>New client secret</b> (24-month expiry).</li>
        <li>Copy the secret <b>Value</b> immediately (shown once). This is the Graph credential.</li>
      </ol>

      {hybrid && (
        <>
          <h2>{step()}. Certificate (for the Exchange Online step)</h2>
          <p className="note">Create it on the <b>host that runs the exchange job</b> — the client&apos;s on-prem agent (the DC) — so the private key lives there. The runner (SYSTEM) can read keys in <code>LocalMachine\My</code>.</p>
          <Code>{`# On the DC, in an elevated PowerShell:
$cert = New-SelfSignedCertificate -Subject "CN=iam-engine-exo" \\
  -CertStoreLocation "Cert:\\LocalMachine\\My" -KeyExportPolicy Exportable \\
  -KeySpec Signature -NotAfter (Get-Date).AddYears(2)
$cert.Thumbprint                                   # -> Delinea CertificateThumbprint field
Export-Certificate -Cert $cert -FilePath C:\\iam-engine-exo.cer   # upload this .cer to the app`}</Code>
          <ol>
            <li>In the app registration → Certificates &amp; secrets → <b>Certificates</b> → <b>Upload certificate</b> → the <code>.cer</code> from above.</li>
            <li>Note the <b>Thumbprint</b> (also printed above).</li>
          </ol>

          <h2>{step()}. Grant the app Exchange admin rights</h2>
          <p className="note">Exchange.ManageAsApp alone isn&apos;t enough — the app also needs a directory role, assigned as <b>Active</b> (not PIM-eligible).</p>
          <ul>
            <li>Entra ID → <b>Roles and administrators</b> → <b>Exchange Administrator</b> → <b>Add assignments</b> → search the app name → assign.</li>
          </ul>
        </>
      )}

      <h2>{step()}. Store it in Delinea + wire it to the client</h2>
      <p className="note">One secret holds everything the runner needs. Point the client&apos;s <code>m365-admin</code> reference at it (on the client/case Credentials panel).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 220 }}>Username</th><td>the <b>Application (client) ID</b></td></tr>
          <tr><th>Password</th><td>the <b>client secret value</b> — used by the M365 / Graph step</td></tr>
          {hybrid && (
            <tr><th>CertificateThumbprint <span className="note">(field)</span></th><td>the <b>cert thumbprint</b> — used by the Exchange step</td></tr>
          )}
        </tbody>
      </table>

      <h2>{step()}. Verify</h2>
      <ul>
        <li>On the client/case Credentials panel, <b>Test</b> <code>m365-admin</code> resolves green (it confirms the app can read the secret — not that the app logs in).</li>
        <li>Run the <b>m365</b>{hybrid && <> and <b>exchange</b></>} step{hybrid ? "s" : ""} (dry-run first). A green run means the app{hybrid ? " + cert + roles are" : " is"} correct.</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        {hybrid && (
          <li><b>Where each step runs:</b> <code>m365</code> on the central / cloud runner (uses the client secret — no cert needed there); <code>exchange</code> on the on-prem agent (uses the cert — must be installed on that host).</li>
        )}
        <li><b>Rotation:</b> the client secret{hybrid ? " and the certificate both expire" : " expires"} — calendar a renewal and update the Delinea secret.</li>
      </ul>
    </main>
  );
}
