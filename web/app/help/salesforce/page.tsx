// In-app setup guide for a client's Salesforce integration. Keep in sync with Coretelligent.Salesforce
// + the `salesforce` dispatch block (Use-CtgSalesforceSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Salesforce setup" };

export default function SalesforceSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Salesforce setup</h1>
      <p className="note">
        The <code>salesforce</code> step <b>creates a user</b> with the configured Profile on onboarding and
        <b> deactivates</b> them on offboarding (Salesforce never deletes users). Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          A <b>Connected App</b> using the <b>OAuth 2.0 JWT bearer</b> flow (server-to-server) — the runner signs a JWT
          with the app&rsquo;s certificate private key and exchanges it for an access token. No stored password.
        </p>
      </div>

      <h2>1. Create the Connected App (admin portal)</h2>
      <p className="note">Admin portal: <code>https://&lt;your-domain&gt;.lightning.force.com</code> → <b>Setup</b> (gear icon).</p>
      <ol>
        <li><b>Setup → App Manager → New Connected App.</b></li>
        <li>Enable <b>OAuth Settings</b> → check <b>Use digital signatures</b> and upload a certificate (a self-signed
          cert is fine; keep its private key for the secret).</li>
        <li>OAuth scopes: <b>Manage user data via APIs (api)</b> and <b>Perform requests at any time (refresh_token, offline_access)</b>.</li>
        <li>Save, then <b>Manage → Edit Policies → Permitted Users = &ldquo;Admin approved users are pre-authorized&rdquo;</b>,
          and assign the profile/permission set of your integration user.</li>
        <li>Copy the <b>Consumer Key</b>. Pick an <b>integration user</b> (an admin) the app acts as.</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p className="note"><b>Delinea template: Automation - API</b> — the JWT private key goes in the <code>PrivateKey</code> field. Field names are matched leniently, so any template that carries these fields works.</p>
      <table>
        <tbody>
          <tr><th style={{ width: 170 }}>ConsumerKey</th><td>the Connected App&rsquo;s <b>Consumer Key</b> (client_id)</td></tr>
          <tr><th>Username</th><td>the <b>integration user</b> the app impersonates (an admin login)</td></tr>
          <tr><th>PrivateKey</th><td>the certificate&rsquo;s private key (PEM). Multi-line — or use <b>PrivateKeyBase64</b> (base64 of the PEM)</td></tr>
          <tr><th>IsSandbox</th><td>optional — <code>true</code> for a sandbox (uses <code>test.salesforce.com</code>); default production</td></tr>
        </tbody>
      </table>

      <h2>3. Default licensing</h2>
      <p className="note">
        Config-driven — set on the client&rsquo;s <code>salesforce</code> system: <b><code>profileId</code></b> (required — the
        Profile that grants the user license, e.g. a Salesforce or Salesforce Platform license). Optional:
        {" "}<code>alias</code>, <code>timeZone</code>, <code>locale</code>, <code>language</code>, <code>emailEncoding</code>.
        Find a Profile&rsquo;s Id in <b>Setup → Profiles</b> (the <code>00e…</code> in the URL).
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>salesforce</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: skips create if the username exists and matches the person; offboard sets <code>IsActive=false</code>.</li>
      </ul>
    </main>
  );
}
