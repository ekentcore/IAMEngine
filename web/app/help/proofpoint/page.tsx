// In-app setup guide: how to wire a client's Proofpoint Essentials so the runner can VERIFY a user has
// synced in from Azure AD / Entra (Proofpoint provisions by sync, not by API create). Linked from the
// Health page and the client Secrets panel. Static content — keep in sync with Coretelligent.Proofpoint
// + the `proofpoint` dispatch block in runner/Start-IamRunner.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Proofpoint Essentials setup" };

export default function ProofpointSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Proofpoint Essentials setup</h1>
      <p className="note">
        Proofpoint Essentials provisions users by <b>syncing them from Azure AD / Entra ID</b> (or on-prem AD) on its
        own schedule — it does <b>not</b> create users via API, and there is <b>no API equivalent of the console&rsquo;s
        &ldquo;Save &amp; Run Sync Now&rdquo; button</b>. So the <code>proofpoint</code> step is <b>read-only</b>: it
        verifies whether the user has synced in and reports the status (sync on? frequency? last sync? user exempt?
        present yet?). Do this setup once per client that has a <code>proofpoint</code> system in its plan.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The Proofpoint Essentials API uses an <b>admin account</b> (admin-only API), sent as
          {" "}<code>X-User</code> (admin email) and <code>X-Password</code> (admin password) headers over HTTPS against
          the tenant&rsquo;s pod — <code>https://&#123;region&#125;.proofpointessentials.com/api/v1</code> (region =
          {" "}<code>us1</code>…<code>us5</code>, <code>eu1</code>, <code>au1</code>; check the console URL). All calls
          are scoped to the org domain: <code>/orgs/&#123;domain&#125;/…</code>. The password is never logged.
        </p>
      </div>

      <h2>1. Get an admin account</h2>
      <ol>
        <li>You need a <b>Proofpoint Essentials admin</b> login for the client&rsquo;s organization (only admin-level
          accounts can use the API). A dedicated automation admin is preferable to a person&rsquo;s login.</li>
        <li>Note the <b>pod/region</b> from the console URL (e.g. <code>us3.proofpointessentials.com</code> →
          {" "}<code>us3</code>) and the <b>org domain</b> (the customer&rsquo;s primary domain, e.g. <code>apollon.com</code>).</li>
        <li>Confirm <b>Azure / Entra sync is configured</b> in the console under <b>Import &amp; Sync</b> — that&rsquo;s
          what actually brings users in; this step only checks it.</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p className="note">Put the admin credential in the client&rsquo;s <code>proofpoint</code> secret.</p>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>Username</th><td>the <b>admin email</b> (sent as <code>X-User</code>)</td></tr>
          <tr><th>Password</th><td>the <b>admin password</b> (sent as <code>X-Password</code>)</td></tr>
          <tr><th>Domain</th><td>the <b>org domain</b> for the <code>/orgs/&#123;domain&#125;</code> path — optional; falls back to the client&rsquo;s primary domain</td></tr>
          <tr><th>Region</th><td>the pod: <code>us1</code>…<code>us5</code>, <code>eu1</code>, <code>au1</code> (or put a full <code>BaseUrl</code> instead). Optional; defaults to <code>us1</code>.</td></tr>
        </tbody>
      </table>
      <p className="note">
        Field-name matching (spacing/casing variants accepted): admin email ←
        {" "}<code>X-User / Username / AdminUser / Email</code>; admin password ←
        {" "}<code>X-Password / Password / AdminPassword</code>; org domain ←
        {" "}<code>Domain / OrgDomain / Org / Tenant</code> (else the client&rsquo;s primary domain); pod ←
        {" "}<code>Region</code> or a full <code>BaseUrl / ApiUrl</code>. If the email or password field is missing the
        step fails with a message listing the field names it looked for.
      </p>
      <p className="note">Grant the app&rsquo;s Delinea service account <b>Read</b> on the secret, or the Test shows &ldquo;access denied&rdquo;.</p>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>Add a <code>proofpoint</code> system to the client (it shares the email-security slot with Mimecast — a client has one or the other) and list <code>proofpoint</code> in its secrets.</li>
        <li>On the <b>Credentials</b> panel, point the <code>proofpoint</code> reference at the secret&rsquo;s Delinea ID.</li>
        <li>Click <b>Test</b> — it reads the org&rsquo;s Azure sync settings and reports whether sync is on, its frequency, and the last successful sync. (Test proves the admin auth + domain; the real check is a dry-run.)</li>
      </ul>

      <h2>4. Verify</h2>
      <ul>
        <li><b>Update the runner</b> so it has the Proofpoint module (Agents → Update). Proofpoint is cloud, so the <b>central runner</b> runs this step.</li>
        <li>Run the <code>proofpoint</code> step <b>dry-run</b> on a test user — a green result confirms the credential, pod and domain.</li>
        <li>You can also confirm by hand:</li>
      </ul>
      <Code>{`curl -H "X-User: <admin-email>" -H "X-Password: <admin-password>" -H "Accept: application/json" \\
  https://<region>.proofpointessentials.com/api/v1/orgs/<domain>/settings/azure
# 200 + JSON (sync_frequency, last_successful_sync, …) = the credential + domain are correct
# 401/403 = wrong admin creds or not an admin; 404 = wrong region/pod or domain`}</Code>

      <h2>How onboarding behaves</h2>
      <ul>
        <li><b>User already present</b> (synced) → step is green.</li>
        <li><b>Not synced yet</b> → the step reports it and <b>auto-retries</b> (hourly, capped) until Proofpoint&rsquo;s
          scheduled sync imports the user — nothing else to do.</li>
        <li><b>User is sync-exempt</b> → the step <b>fails</b>: remove the Azure sync exemption in the console, or they
          will never import.</li>
        <li><b>Azure sync not enabled</b> for the org → the step <b>warns</b> (they can&rsquo;t import automatically) —
          enable it under Import &amp; Sync.</li>
        <li><b>Offboarding</b> is sync-driven too: once the user is deprovisioned in the directory, the next sync removes
          them (when <i>remove deleted users</i> is on). The step reports this; it never deletes directly.</li>
      </ul>

      <h2>Need it synced right now?</h2>
      <p className="note">
        The API can&rsquo;t trigger an on-demand sync. If you can&rsquo;t wait for the schedule, run it in the
        console: <b>Import &amp; Sync → AD Sync → Save → Save &amp; Sync</b> (Sync Active Directory). The user imports on
        that run; re-run the <code>proofpoint</code> step afterward to confirm.
      </p>
    </main>
  );
}
