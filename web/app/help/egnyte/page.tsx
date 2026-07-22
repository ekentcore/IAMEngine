// In-app setup guide: the Egnyte API credential a client needs so the runner can create /
// deactivate users. Linked from the credential panels and the Health page. Keep in sync with
// Coretelligent.Egnyte.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Egnyte setup" };

export default function EgnyteSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Egnyte setup</h1>
      <p className="note">
        The <code>egnyte</code> step <b>creates the user</b> on onboarding with the client&rsquo;s license tier
        (config <code>userType</code>: <b>power</b> — the default and what core131/Drake Star uses — or
        {" "}<code>standard</code>/<code>admin</code>), and <b>deactivates</b> on offboarding (retention-safe; files and
        links stay — config <code>delete: true</code> removes the account instead). Do this setup once per client.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          <b>OAuth2 bearer token</b> against the tenant&rsquo;s own host (<code>https://&#123;domain&#125;.egnyte.com</code>).
          The runner mints the token itself via the <b>Resource Owner Password grant</b>, so you store four things in
          Delinea: the API application&rsquo;s <b>Key</b> (<code>client_id</code>) and <b>Secret</b> (<code>client_secret</code>),
          plus an <b>admin login email + password</b> (the account the token is minted on behalf of). The API application
          (Key + Secret) is registered once at developers.egnyte.com and reused across clients.
        </p>
      </div>

      <h2>1. Get the API application Key + Secret (once for our org, reusable across clients)</h2>
      <ol>
        <li>Register at <code>developers.egnyte.com</code> → create an application → copy its <b>Key</b> (the OAuth
          {" "}<code>client_id</code>) and its <b>Secret</b> (the <code>client_secret</code> — required for keys issued
          after Jan 2015). Request the <b>User Management</b> scope if asked.</li>
      </ol>

      <h2>2. How the runner mints the token (for reference)</h2>
      <Code>{`curl -X POST "https://<egnyteDomain>.egnyte.com/puboauth/token" \\
  -d "grant_type=password&client_id=<KEY>&client_secret=<SECRET>&username=<adminLoginEmail>&password=<itsPassword>"
# 200 -> { "access_token": "...", ... }   <- the runner does this on each connect`}</Code>
      <p className="note"><code>&lt;egnyteDomain&gt;</code> is the tenant subdomain — <code>coretelligent</code> for
        {" "}<code>coretelligent.egnyte.com</code>. The login account must be an Egnyte admin able to manage users.</p>

      <h2>3. Store it in Delinea</h2>
      <p className="note"><b>Delinea template: Automation - API</b> — fill the fields below (field names are matched leniently, so any template that carries them works).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 220 }}>ClientID <span className="note">(field)</span></th><td>the API application <b>Key</b> (the OAuth <code>client_id</code>)</td></tr>
          <tr><th>ClientSecret <span className="note">(field)</span></th><td>the API application <b>Secret</b> (the <code>client_secret</code>)</td></tr>
          <tr><th>accountid <span className="note">(field)</span></th><td>the admin <b>login email</b> the token is minted on behalf of (the OAuth <code>username</code>)</td></tr>
          <tr><th>Password <span className="note">(field)</span></th><td>that admin account&rsquo;s Egnyte password</td></tr>
          <tr><th>Domain <span className="note">(optional)</span></th><td>the tenant subdomain, e.g. <code>coretelligent</code> — leave blank to derive it from the login email</td></tr>
        </tbody>
      </table>
      <p className="note">
        Alternative (a pre-minted token instead of the four fields above): store a long-lived <code>Token</code> and the
        runner uses it directly — Egnyte tokens don&rsquo;t expire unless revoked. Field-name variants accepted:
        {" "}client id ← <code>ClientID / Key / API Key</code>; client secret ← <code>ClientSecret / Secret</code>;
        account ← <code>accountid / AccountID / Username / Email</code>; token ← <code>Token / AccessToken / ApiToken / Bearer</code>;
        domain ← <code>Domain / EgnyteDomain / Tenant</code>.
      </p>

      <h2>4. Wire + verify</h2>
      <ul>
        <li>Point the client&rsquo;s <code>egnyte</code> reference at the secret (Credentials panel) → <b>Test</b> green.</li>
        <li><b>Update the runner</b>, then run the <code>egnyte</code> step on a real onboarding — the run report shows
          the exact create call and the license tier the user landed on.</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        <li><b>License tier per client:</b> set <code>userType</code> in the egnyte system&rsquo;s onboard config
          (<code>power</code> default). The validator checks the created user landed on the configured tier.</li>
        <li><b>Auth type:</b> default <code>egnyte</code> (native login + email invite). Clients on SSO can set
          {" "}<code>authType: sso</code> (the user is matched to the IdP by their email/UPN — no invite password).</li>
        <li><b>Offboarding never deletes by default</b> — deactivation keeps the user&rsquo;s files and shared links.
          Set <code>delete: true</code> on the offboard config only if that&rsquo;s the client&rsquo;s policy.</li>
        <li>The Egnyte v2 users API shapes are from the public docs; if a live call disagrees, the run report error
          shows the exact method + URL + response body — paste it in chat and the module gets adjusted fast.</li>
      </ul>
    </main>
  );
}
