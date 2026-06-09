// In-app setup guide: how to wire a client's Spanning Backup (Microsoft 365) so the runner can
// assign/retain backup licenses during onboarding and offboarding. Linked from the Health page and
// the client Secrets panel. Static content — keep in sync with Coretelligent.Spanning + the
// `spanning` dispatch block in runner/Start-IamRunner.ps1.
import Link from "next/link";

const Code = ({ children }: { children: string }) => (
  <pre style={{ background: "#f6f6f6", border: "1px solid #e2e2e2", borderRadius: 4, padding: "8px 10px", overflowX: "auto", fontSize: 12 }}>
    <code>{children}</code>
  </pre>
);

export default function SpanningSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Spanning Backup setup (Microsoft 365)</h1>
      <p className="note">
        Spanning Backup protects each user&rsquo;s mailbox / OneDrive / SharePoint. The <code>spanning</code> step
        <b> assigns a Standard backup license</b> on onboarding and, on offboarding, <b>retains the backup</b> (data is
        never deleted) by swapping the user to the <b>Archive</b> license. Do this setup once per client that has a
        <code> spanning</code> system in its plan.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The Spanning API uses <b>HTTP Basic auth</b> over HTTPS: <b>username = the client&rsquo;s domain</b>,
          {" "}<b>password = an access token</b>, against a region-specific host
          {" "}(<code>https://api-&#123;region&#125;.spanningbackup.com</code>, region = US/EU/AP/UK/CA). There is no
          certificate and no key pair.
        </p>
      </div>

      <h2>1. Get the access token</h2>
      <ol>
        <li>Sign in to the <b>Spanning Backup admin console</b> for the client&rsquo;s tenant.</li>
        <li>Open <b>Settings</b> (direct link: <code>https://spanningbackup.com/auth/redirectTo?initialPath=/app/settings/backup</code>)
          and copy the <b>API access token</b> — a single opaque string.</li>
        <li>Note the tenant&rsquo;s <b>region</b> (US/EU/AP/UK/CA) and the <b>domain</b> Spanning is registered under
          (usually the primary M365 email domain).</li>
      </ol>
      <p className="note">
        ⚠ A <b>public/private key pair + password</b> shown in settings is <b>not</b> this token — that&rsquo;s the
        credential Spanning uses to connect to Microsoft 365. The REST access token is a separate, single-string item.
        Only <b>Regenerate</b> if you have to: it invalidates the current token.
      </p>

      <h2>2. Store it in Delinea</h2>
      <p className="note">Either template works — the runner reads the token / domain / region by field name.</p>

      <h3>Recommended: <code>Automation - API</code> (use when the domain or region varies per client)</h3>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>ClientSecret</th><td>the Spanning <b>access token</b></td></tr>
          <tr><th>AccountID</th><td>the Spanning <b>domain</b> (Basic-auth username). <b>Leave blank</b> to fall back to the client&rsquo;s primary M365 domain — only fill it when Spanning&rsquo;s domain differs.</td></tr>
          <tr><th>apiURL</th><td>the region host, e.g. <code>https://api-us.spanningbackup.com</code> (swap <code>us</code> for the region). You can paste just the host — the runner appends <code>/api/v1</code>. Omit to default to US.</td></tr>
          <tr><th>Secret name / ClientID</th><td>label / unused — ignored by the runner.</td></tr>
        </tbody>
      </table>

      <h3>Simpler: <code>Generic API</code> (only for a US tenant whose Spanning domain = primary domain)</h3>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>API Key</th><td>the Spanning <b>access token</b></td></tr>
          <tr><th>Secret Name</th><td>label — ignored. (No domain/region fields: domain defaults to the primary M365 domain, region defaults to US.)</td></tr>
        </tbody>
      </table>
      <p className="note">
        Field-name matching, in case a template differs: token ← <code>AccessToken / ApiToken / API Key / ClientSecret / Password</code>;
        {" "}domain ← <code>Domain / AccountID / Account / Tenant / ClientID</code> (else the secret&rsquo;s Username, else the
        client&rsquo;s primary domain); base URL ← <code>apiURL / BaseUrl / Url</code> (else a <code>Region</code> field, else US).
      </p>
      <p className="note">Grant the app&rsquo;s Delinea service account <b>Read</b> on the secret, or the Test shows &ldquo;access denied&rdquo;.</p>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>On the client / case <b>Credentials</b> panel, point the <code>spanning</code> reference at the secret&rsquo;s Delinea ID.</li>
        <li>Click <b>Test</b> — it should resolve green. (Test only proves the app can read the secret, not that Spanning accepts it — the real check is the dry-run.)</li>
      </ul>

      <h2>4. Verify</h2>
      <ul>
        <li><b>Update the runner</b> so it has the Spanning module (Agents → Update, or the update script). Spanning is cloud, so the <b>central runner</b> runs this step.</li>
        <li>Run the <code>spanning</code> step <b>dry-run first</b>. A green dry-run confirms the domain, region and token are all correct.</li>
        <li>You can also confirm by hand:</li>
      </ul>
      <Code>{`curl --user <domain>:<accessToken> \\
  https://api-<region>.spanningbackup.com/api/v1/users
# 200 + a JSON list of users = the credential is correct; 401 = wrong domain/token`}</Code>

      <h2>Notes</h2>
      <ul>
        <li><b>Onboarding</b> assigns a Standard license (idempotent). If Spanning hasn&rsquo;t discovered the new M365
          user yet (it syncs on its own schedule), the step says so and exits cleanly — just re-run it later.</li>
        <li><b>No seats?</b> The step warns to open a <b>Procurement Case</b> and continues (a warning on the run report),
          rather than failing the case.</li>
        <li><b>Offboarding never deletes the backup.</b> It keeps the data and swaps the user to the Archive license
          (set the offboard config to remove the license entirely only if that&rsquo;s the client&rsquo;s policy). It runs
          last, after the mailbox is converted to Shared and the M365 license is removed.</li>
      </ul>
    </main>
  );
}
