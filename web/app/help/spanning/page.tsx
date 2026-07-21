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
          The Spanning API uses <b>HTTP Basic auth</b> over HTTPS: <b>username = the email you sign in to Spanning
          with</b>, <b>password = your API Key</b> (Settings → API Token), against
          {" "}<code>https://&#123;service&#125;-api-&#123;region&#125;.spanningbackup.com</code> (service =
          {" "}<code>o365</code>, or <code>google</code> for a Spanning for Google Workspace tenant; region =
          US/EU/AP/UK/CA — the United States is <code>us</code>; the runner appends <code>/external</code>). Use the
          {" "}<b>&#123;service&#125;-api</b> host — the bare <code>api-&#123;region&#125;</code> host is a different
          product surface and returns 404.
        </p>
      </div>

      <h2>1. Get the API Key</h2>
      <ol>
        <li>Sign in to the <b>Spanning Backup admin console</b> for the client&rsquo;s tenant — note the
          {" "}<b>email you sign in with</b> (that&rsquo;s the Basic-auth username).</li>
        <li>Open <b>Settings</b> and scroll to <b>API Token</b> at the <b>bottom of the page</b> — copy the
          {" "}<b>API Key</b> (generate one if there isn&rsquo;t one yet).</li>
        <li>Note the tenant&rsquo;s <b>region</b> from the console URL (e.g. <code>o365-us…</code> → <code>us</code>).</li>
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
          <tr><th style={{ width: 160 }}>clientID</th><td>the <b>email you log in to Spanning with</b> (the Basic-auth username)</td></tr>
          <tr><th>ClientSecret</th><td>the <b>API Key</b> — Spanning admin → <b>Settings</b> → <b>API Token</b> (at the bottom of the page)</td></tr>
          <tr><th>accountid</th><td>the account <b>domain without its suffix</b> — e.g. <code>coretelligent.com</code> → <code>coretelligent</code></td></tr>
          <tr><th>apiURL</th><td><code>https://&lt;service&gt;-api-&lt;region&gt;.spanningbackup.com</code> — service <code>o365</code> (or <code>google</code> for a Google Workspace tenant), and for the United States the region is <code>us</code> (so <code>https://o365-api-us.spanningbackup.com</code>). Paste just the host; the runner appends <code>/external</code>.</td></tr>
        </tbody>
      </table>
      <p className="note">
        Field-name matching, in case a template differs (spacing/casing variants accepted): username ←
        {" "}<code>clientID / Domain / AccountID / Account / Tenant</code> (else the secret&rsquo;s Username, else the
        client&rsquo;s primary domain); API Key ← <code>ClientSecret / AccessToken / ApiToken / API Key / Token / Key /
        Password</code>; base URL ← <code>apiURL / BaseUrl / Url</code> (else a <code>Region</code> field, else US).
        If no key field is found the step fails with a message listing the field names it looked for.
      </p>
      <p className="note">Grant the app&rsquo;s Delinea service account <b>Read</b> on the secret, or the Test shows &ldquo;access denied&rdquo;.</p>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>On the client / case <b>Credentials</b> panel, point the <code>spanning</code> reference at the secret&rsquo;s Delinea ID.</li>
        <li>Click <b>Test</b> — it should resolve green. (Test only proves the app can read the secret, not that Spanning accepts it — the real check is the dry-run.)</li>
      </ul>

      <h2>4. Optional: the console sign-in, for &ldquo;force sync&rdquo;</h2>
      <p>
        Spanning discovers new M365 users on <b>its own schedule</b>, so a just-created user often isn&rsquo;t there yet
        when onboarding tries to license them. <b>Force sync</b> makes it look now — but Spanning&rsquo;s API has no sync
        endpoint, so it is done by driving the admin console in a real browser.
      </p>
      <p>
        The console is <b>Microsoft 365 SSO</b>, so it needs an <b>M365 admin sign-in</b> — an email and that
        account&rsquo;s password. The API credential above <b>cannot</b> sign in to it (a clientId is not an M365
        identity), so it lives in a <b>second, separate</b> Delinea secret wired as <code>spanning-portal</code>:
      </p>
      <ul>
        <li><code>Username</code> — an M365 admin&rsquo;s <b>email address</b> (one with access to the Spanning console).</li>
        <li><code>Password</code> — that account&rsquo;s password.</li>
        <li>Enable <b>One-Time Password</b> on the secret. The runner mints the MFA code from Delinea <i>at the prompt</i>,
          so the authenticator seed never leaves the vault. It must be a <b>TOTP / authenticator-app</b> method:
          push notifications and phone calls cannot be automated, and the sign-in will simply time out.</li>
      </ul>
      <p className="note">
        Do <b>not</b> put this login in the <code>spanning</code> API secret&rsquo;s Username/Password fields. The runner
        would send it to Spanning as clientId:clientSecret and every licensing call would start failing with 401.
      </p>
      <p>
        This is entirely <b>optional</b>: licensing (onboard and offboard) is pure API and works without it. A client with
        no <code>spanning-portal</code> secret simply can&rsquo;t force a sync — the step says so and leaves it to a human.
      </p>
      <p>
        To check it, use <b>Test</b> on the client&rsquo;s <b>Spanning</b> system. When a portal secret is wired, that test
        signs in to the console for real — through Microsoft SSO and MFA — and triggers nothing. It reports as a
        <b> console sign-in</b> row, which is how you catch a wrong password, an un-mintable MFA method, Conditional
        Access blocking the runner, or an admin with no console access <i>before</i> an onboarding needs it. (Only this
        targeted single-system Test does a real sign-in — the nightly sweep never does.)
      </p>

      <h2>5. Verify</h2>
      <ul>
        <li><b>Update the runner</b> so it has the Spanning module (Agents → Update, or the update script). Spanning is cloud, so the <b>central runner</b> runs this step.</li>
        <li>Run the <code>spanning</code> step <b>dry-run first</b>. A green dry-run confirms the domain, region and token are all correct.</li>
        <li>You can also confirm by hand:</li>
      </ul>
      <Code>{`curl -u "<login-email>:<api-key>" -H "Accept: application/json" \\
  https://o365-api-<region>.spanningbackup.com/external/tenant
# 200 + tenant JSON = the credential is correct; 401 = wrong email/API Key (or wrong region)`}</Code>

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
