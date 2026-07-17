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
        <li>Go to <b>Integrations → API and Platform Integrations</b>.</li>
        <li><b>Add API Application</b> → name it <code>iam-engine — &lt;client&gt;</code>, category <b>SIEM/Integration</b>,
          set the point of contact to <b>Coretelligent</b> with email <code>&lt;coreid&gt;@help.support.tech</code>
          {" "}(the client&rsquo;s core id, e.g. <code>core1234@help.support.tech</code>), and <b>enable</b> it.
          (New applications can take a few minutes to activate.)</li>
        <li>Open the application → <b>Manage API 2.0 credentials</b> → <b>Generate</b> → copy the
          {" "}<b>Client ID</b> and <b>Client Secret</b> (the secret is shown once).</li>
      </ol>
      <h2>2. Set its role + products</h2>
      <p className="note">
        The application acts with the <b>role</b> and <b>products</b> you grant it. Set the role to
        {" "}<b>Basic Administrator</b> or <b>Help Desk Administrator</b>, and enable these <b>three products</b>:
      </p>
      <ul>
        <li><b>Account Management</b> — read the account</li>
        <li><b>Domain Management</b> — read internal domains</li>
        <li><b>User &amp; Group Management</b> — read / create users, list sync connections + trigger a directory
          sync, manage group membership. <b>Required.</b> Without it, every user call fails
          with <code>app_forbidden</code> (&ldquo;resource or method … does not exist in any product assigned to the
          application&rdquo;).</li>
      </ul>
      <p className="note">
        Quick check that it&rsquo;s the products and not the domain: existing users (e.g. <code>postmaster@&lt;client&gt;</code>)
        should read fine. If they do but a <i>new hire</i> is &ldquo;Forbidden To Perform Operation For Address&rdquo;, that&rsquo;s
        just <b>not-synced-yet</b> (see Notes), not a permissions problem.
      </p>

      <h2>3. Store it in Delinea</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 200 }}>Username <span className="note">(or ClientID field)</span></th><td>the <b>Client ID</b></td></tr>
          <tr><th>Password <span className="note">(or ClientSecret field)</span></th><td>the <b>Client Secret</b></td></tr>
        </tbody>
      </table>
      <p className="note">
        Both common templates work: a plain <b>username/password</b> secret, or <b>Automation - API</b>
        (ClientID + ClientSecret fields). If neither pair is found the step fails naming the fields it saw.
      </p>

      <h2>4. Wire + verify</h2>
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
        <li><b>&ldquo;Forbidden To Perform Operation For Address&rdquo; on a new hire is normal.</b> Mimecast returns that
          (<code>err_xdk_operation_forbidden_for_address</code>) for an address it doesn&rsquo;t manage <i>yet</i> — i.e. the
          user hasn&rsquo;t synced in. The runner detects this (by confirming a known address still reads) and treats it as
          &ldquo;not present yet,&rdquo; auto-retrying every 15 min until the sync lands — it is <b>not</b> a permission
          error. A real permission gap fails for <i>every</i> address, including <code>postmaster@</code>.</li>
        <li><b>createIfMissing:</b> only for clients with no directory sync — creates a cloud user in the Internal
          Directory with a forced password change.</li>
        <li><b>Offboarding</b> removes group memberships; the mailbox itself follows the disabled directory account.</li>
      </ul>
    </main>
  );
}
