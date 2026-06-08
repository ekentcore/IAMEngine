// In-app setup guide: the Entra app registration + certificate a client needs so the runner can do
// M365 (Graph) and Exchange Online automation app-only (no user/MFA). Linked from the client Secrets
// panel. Static content — keep in sync with Connect-CtgM365 / Connect-CtgExchange in the runner.
import Link from "next/link";

const Code = ({ children }: { children: string }) => (
  <pre style={{ background: "#f6f6f6", border: "1px solid #e2e2e2", borderRadius: 4, padding: "8px 10px", overflowX: "auto", fontSize: 12 }}>
    <code>{children}</code>
  </pre>
);

export default function CloudAuthSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/clients">← Clients</Link></p>
      <h1>Cloud auth setup (M365 + Exchange Online)</h1>
      <p className="note">
        Unattended M365/Exchange automation can&apos;t use a username + password (Microsoft requires modern auth /
        MFA). Instead the runner uses one <b>Entra app registration</b> per client, app-only:
        <b> Microsoft Graph via a client secret</b> (M365 step) and <b>Exchange Online via a certificate</b> (exchange
        step). Do this once per client.
      </p>

      <h2>1. Register the app</h2>
      <ol>
        <li>Entra ID → <b>App registrations</b> → <b>New registration</b>.</li>
        <li>Name: <code>iam-engine — &lt;client&gt;</code>. Account types: <b>Single tenant</b>. No redirect URI. <b>Register</b>.</li>
        <li>Copy the <b>Application (client) ID</b> and the <b>Directory (tenant) ID</b>.</li>
      </ol>

      <h2>2. API permissions (application, not delegated)</h2>
      <ul>
        <li><b>Microsoft Graph</b> → Application permissions → <code>User.ReadWrite.All</code>, <code>Group.ReadWrite.All</code> (add <code>Directory.Read.All</code> if you resolve managers by name).</li>
        <li><b>APIs my organization uses</b> → <b>Office 365 Exchange Online</b> → Application permissions → <code>Exchange.ManageAsApp</code>.</li>
        <li>Click <b>Grant admin consent</b> (the statuses must show a green check).</li>
      </ul>

      <h2>3. Client secret (for the M365 / Graph step)</h2>
      <ol>
        <li>Certificates &amp; secrets → <b>Client secrets</b> → <b>New client secret</b> (24-month expiry).</li>
        <li>Copy the secret <b>Value</b> immediately (shown once). This is the Graph credential.</li>
      </ol>

      <h2>4. Certificate (for the Exchange Online step)</h2>
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

      <h2>5. Grant the app Exchange admin rights</h2>
      <p className="note">Exchange.ManageAsApp alone isn&apos;t enough — the app also needs a directory role.</p>
      <ul>
        <li>Entra ID → <b>Roles and administrators</b> → <b>Exchange Administrator</b> → <b>Add assignments</b> → search the app name → assign.</li>
      </ul>

      <h2>6. Store it in Delinea + wire it to the client</h2>
      <p className="note">One secret holds everything the runner needs. Point the client&apos;s <code>m365-admin</code> reference at it (on the client/case Credentials panel).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 220 }}>Username</th><td>the <b>Application (client) ID</b></td></tr>
          <tr><th>Password</th><td>the <b>client secret value</b> (step 3) — used by the M365 / Graph step</td></tr>
          <tr><th>CertificateThumbprint <span className="note">(field)</span></th><td>the <b>cert thumbprint</b> (step 4) — used by the Exchange step</td></tr>
        </tbody>
      </table>

      <h2>7. Verify</h2>
      <ul>
        <li>On the client/case Credentials panel, <b>Test</b> <code>m365-admin</code> resolves green (it confirms the app can read the secret — not that the app logs in).</li>
        <li>Run the <b>m365</b> and <b>exchange</b> steps (dry-run first). A green run means the app + cert + roles are correct.</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        <li><b>Where each step runs:</b> <code>m365</code> on the central / cloud runner (uses the client secret — no cert needed there); <code>exchange</code> on the on-prem agent (uses the cert — must be installed on that host).</li>
        <li><b>When we host this:</b> the central runner moves off a laptop to a server — nothing about the app registration changes, but the M365 step will run from that server. For tighter security, switch the M365 step to certificate auth too (one cert on the central host) instead of a client secret — a small runner change.</li>
        <li><b>Rotation:</b> the client secret and the certificate both expire — calendar a renewal and update the Delinea secret.</li>
      </ul>
    </main>
  );
}
