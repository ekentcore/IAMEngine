// In-app setup guide for a client's Jira (Atlassian) integration. Keep in sync with Coretelligent.Jira
// + the `jira` dispatch block (Use-CtgJiraSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "Jira (Atlassian) setup" };

export default function JiraSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Jira (Atlassian) setup</h1>
      <p className="note">
        The <code>jira</code> step <b>invites/creates a user</b> with the configured product access on onboarding and
        <b> removes site access</b> on offboarding. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          <b>HTTP Basic auth</b> = an <b>admin email : API token</b>, against <code>https://&lt;site&gt;.atlassian.net</code>.
          The admin must be an organization / user-access admin, and Jira must be added to the site.
        </p>
      </div>

      <h2>1. Create an API token (admin portal)</h2>
      <p className="note">Admin portal: <code>https://admin.atlassian.com</code> (org) and <code>https://&lt;site&gt;.atlassian.net</code> (site).</p>
      <ol>
        <li>As the admin user, go to <code>https://id.atlassian.com/manage-profile/security/api-tokens</code> →
          <b> Create API token</b> → copy it.</li>
        <li>Confirm that admin has <b>user-access admin</b> rights in <b>admin.atlassian.com → Directory</b>.</li>
        <li>Note the <b>site URL</b> (<code>https://&lt;site&gt;.atlassian.net</code>).</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p className="note"><b>Delinea template: username/password</b> — the admin email is the username and the API token is the password (plus <code>SiteUrl</code>). Field names are matched leniently, so any template that carries these fields works.</p>
      <table>
        <tbody>
          <tr><th style={{ width: 130 }}>Email</th><td>the admin user&rsquo;s <b>email</b> (Basic-auth username)</td></tr>
          <tr><th>ApiToken</th><td>the <b>API token</b> from step 1</td></tr>
          <tr><th>SiteUrl</th><td><code>https://&lt;site&gt;.atlassian.net</code></td></tr>
        </tbody>
      </table>

      <h2>3. Default licensing (product access)</h2>
      <p className="note">
        Config-driven — set <b><code>products</code></b> on the client&rsquo;s <code>jira</code> system: a list of
        {" "}<code>jira-software</code>, <code>jira-servicedesk</code>, <code>jira-core</code>,
        {" "}<code>jira-product-discovery</code>. An empty list grants the site&rsquo;s <b>default product access</b>.
        Each granted product consumes a paid seat.
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>jira</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: a user is keyed by email, so an existing email is adopted (no duplicate). Offboard removes the
          user from the site (revokes product access); the Atlassian account itself is org/SCIM-managed.</li>
      </ul>
    </main>
  );
}
