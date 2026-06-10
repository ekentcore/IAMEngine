// In-app setup guide: how to wire a client's Spanning Backup (Microsoft 365) so the runner can
// assign/retain backup licenses during onboarding and offboarding. Linked from the Health page and
// the client Secrets panel. Static content — keep in sync with Coretelligent.Spanning + the
// `spanning` dispatch block in runner/Start-IamRunner.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Spanning Backup setup" };

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
          The Spanning API uses <b>HTTP Basic auth</b> over HTTPS: <b>username = the Client ID</b>,
          {" "}<b>password = the Client Secret</b> (both from the API section of the Spanning admin console), against
          {" "}<code>https://o365-api-&#123;region&#125;.spanningbackup.com</code> (region = US/EU/AP/UK/CA; the runner
          appends <code>/external</code>). The old public docs describe a legacy pair (<b>domain : access token</b>
          {" "}against <code>api-&#123;region&#125;…/api/v1</code>) — a freshly-issued credential was rejected there, so
          treat legacy as unsupported; if you hit a tenant that only works that way, flag it.
        </p>
      </div>

      <h2>1. Get the Client ID + Client Secret</h2>
      <ol>
        <li>Sign in to the <b>Spanning Backup admin console</b> for the client&rsquo;s tenant.</li>
        <li>Open <b>Settings</b> (direct link: <code>https://spanningbackup.com/auth/redirectTo?initialPath=/app/settings/backup</code>)
          and find the <b>API</b> section — it issues a <b>Client ID</b> and a <b>Client Secret</b> pair.</li>
        <li>Note the tenant&rsquo;s <b>region</b> from the console URL (e.g. <code>o365-us…</code> → US).</li>
      </ol>
      <p className="note">
        Only <b>Regenerate</b> if you have to: it invalidates the current credential immediately, everywhere it&rsquo;s used.
      </p>

      <h2>2. Store it in Delinea</h2>
      <p className="note">
        Use the <code>Automation - API</code> template — its fields map one-to-one. Unsure which template your org uses?
        Open an existing Spanning secret in Delinea and create yours with the same one.
      </p>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>ClientID</th><td>the Spanning <b>Client ID</b> (the Basic-auth username)</td></tr>
          <tr><th>ClientSecret</th><td>the Spanning <b>Client Secret</b></td></tr>
          <tr><th>apiURL</th><td>the region host, e.g. <code>https://o365-api-us.spanningbackup.com</code> (swap <code>us</code> for the region). Paste just the host — the runner appends <code>/external</code>. Omit to default to US.</td></tr>
          <tr><th>Secret name / AccountID</th><td>label / legacy only — <code>AccountID</code> is the account <b>domain</b> for old domain:access-token tenants; leave blank otherwise.</td></tr>
        </tbody>
      </table>
      <p className="note">
        Field-name matching, in case a template differs (spacing/casing variants accepted): secret ←
        {" "}<code>ClientSecret / AccessToken / ApiToken / API Key / Token / Key / Password</code>;
        {" "}username ← <code>ClientID / Domain / AccountID / Account / Tenant</code> (else the secret&rsquo;s Username,
        else the client&rsquo;s primary domain); base URL ← <code>apiURL / BaseUrl / Url</code> (else a <code>Region</code>
        {" "}field, else US). If no secret field is found the step fails with a message listing the field names it
        looked for.
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
      <Code>{`curl -u "<clientID>:<clientSecret>" -H "Accept: application/json" \\
  https://o365-api-<region>.spanningbackup.com/external/tenant
# 200 + tenant JSON = the credential is correct; 401 = wrong Client ID/Secret (or wrong region)`}</Code>

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
