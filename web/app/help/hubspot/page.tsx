// In-app setup guide for a client's HubSpot integration. Keep in sync with Coretelligent.HubSpot
// + the `hubspot` dispatch block (Use-CtgHubSpotSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "HubSpot setup" };

export default function HubSpotSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>HubSpot setup</h1>
      <p className="note">
        The <code>hubspot</code> step <b>creates/invites a user</b> with the configured role + team on onboarding and
        <b> removes</b> them on offboarding. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          A <b>private-app access token</b> (Bearer), against <code>api.hubapi.com</code>. The private app needs the
          {" "}<b>settings.users.read / write</b> scopes; only a Super Admin can create it.
        </p>
      </div>

      <h2>1. Create the private app (admin portal)</h2>
      <p className="note">Admin portal: <code>https://app.hubspot.com</code> → <b>Settings</b> (gear icon).</p>
      <ol>
        <li><b>Settings → Integrations → Private Apps → Create a private app.</b></li>
        <li>Under <b>Scopes</b>, add <b>settings.users.read</b> and <b>settings.users.write</b> (and
          {" "}<b>settings.users.teams.write</b> if assigning teams).</li>
        <li>Create it and copy the <b>Access token</b>.</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>AccessToken</th><td>the private-app <b>access token</b> (Bearer)</td></tr>
        </tbody>
      </table>

      <h2>3. Default licensing (role + team)</h2>
      <p className="note">
        Config-driven — set on the client&rsquo;s <code>hubspot</code> system: <b><code>roleId</code></b> (the permission
        set / role), optional <b><code>primaryTeamId</code></b> and <b><code>secondaryTeamIds</code></b>, and
        {" "}<code>sendWelcomeEmail</code> (default true). A paid seat is consumed if the role is a paid one. Find role
        and team Ids under <b>Settings → Users &amp; Teams</b> (or via the <code>settings/v3/users/roles</code> and
        {" "}<code>/teams</code> API).
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>hubspot</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: a user is keyed by email, so an existing email is adopted (no duplicate). Offboard removes the user.</li>
      </ul>
    </main>
  );
}
