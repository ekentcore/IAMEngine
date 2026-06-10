// In-app setup guide: the Mimecast API 2.0 application a client needs so the runner can trigger
// directory syncs, check/create users, and manage group membership. Linked from the credential
// panels and the Health page. Keep in sync with Coretelligent.Mimecast.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Mimecast setup" };

export default function MimecastSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Mimecast setup (API 2.0 application)</h1>
      <p className="note">
        The <code>mimecast</code> step triggers a <b>directory sync</b> (so the new user flows in from AD/365),
        confirms the user is <b>visible in Mimecast</b>, and can <b>create a cloud user</b> in the Internal Directory
        for clients without directory sync (config <code>createIfMissing</code>). Offboarding removes the user from
        configured Mimecast groups. Do this setup once per client.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          <b>OAuth2 client-credentials</b>: a <b>Client ID + Client Secret</b> from an API 2.0 application registered in
          the client&rsquo;s Mimecast Administration Console. The runner exchanges them for a bearer token at
          {" "}<code>api.services.mimecast.com/oauth/token</code> (tokens last ~30 minutes; refreshed automatically).
          No certificates, no legacy 1.0 signing keys.
        </p>
      </div>

      <h2>1. Register the API 2.0 application</h2>
      <ol>
        <li>Sign in to the client&rsquo;s <b>Mimecast Administration Console</b> as an admin.</li>
        <li>Go to <b>Services → API and Platform Integrations</b> (on newer consoles: <b>Integrations → API</b>).</li>
        <li><b>Add API Application</b> → name it <code>iam-engine — &lt;client&gt;</code>, category <b>SIEM/Integration</b>,
          fill the contact details, and <b>enable</b> it. (New applications can take a few minutes to activate.)</li>
        <li>Open the application → <b>Manage API 2.0 credentials</b> → <b>Generate</b> → copy the
          {" "}<b>Client ID</b> and <b>Client Secret</b> (the secret is shown once).</li>
      </ol>
      <p className="note">
        The application acts with the permissions granted to it — for this module it needs directory read/edit
        (sync + groups) and user read/create. If a call fails with a permissions error, the run report will show the
        exact endpoint; grant the matching role on the application.
      </p>

      <h2>2. Store it in Delinea</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 200 }}>Username</th><td>the <b>Client ID</b></td></tr>
          <tr><th>Password</th><td>the <b>Client Secret</b></td></tr>
        </tbody>
      </table>
      <p className="note">A plain username/password template works — the runner reads Username/Password directly. Unsure which template to use? Copy whichever an existing <code>mimecast</code> secret uses.</p>

      <h2>3. Wire + verify</h2>
      <ul>
        <li>Point the client&rsquo;s <code>mimecast</code> reference at the secret (Credentials panel) → <b>Test</b> green.</li>
        <li><b>Update the runner</b>, then run the <code>mimecast</code> step <b>dry-run first</b>.</li>
        <li>Manual check of the credential:</li>
      </ul>
      <Code>{`curl -X POST https://api.services.mimecast.com/oauth/token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials&client_id=<CLIENT_ID>&client_secret=<SECRET>"
# 200 + access_token = credential is correct`}</Code>

      <h2>Notes</h2>
      <ul>
        <li><b>Users come from directory sync.</b> The step triggers a sync (<code>/api/directory/execute-sync</code>) and
          checks visibility (<code>/api/user/get-profile</code>); Mimecast syncs on its own schedule too, so a brand-new
          user may show as a validation warning until the sync lands — re-run to confirm.</li>
        <li><b>createIfMissing:</b> only for clients with no directory sync — creates a cloud user in the Internal
          Directory with a forced password change.</li>
        <li><b>Offboarding</b> removes group memberships; the mailbox itself follows the disabled directory account.</li>
      </ul>
    </main>
  );
}
