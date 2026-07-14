// In-app setup guide for a client's Slack integration. Keep in sync with Coretelligent.Slack +
// the `slack` dispatch block (Use-CtgSlackSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "Slack setup" };

export default function SlackSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Slack setup</h1>
      <p className="note">
        The <code>slack</code> step manages a user&rsquo;s Slack membership over the <b>SCIM API</b>.
        <b> Onboard</b> creates the member (Slack sends the invite) — and if they already exist but are
        <b> deactivated</b>, it <b>reactivates</b> them rather than creating a second account, which is what a
        returning employee looks like. <b>Offboard</b> <b>deactivates</b> the account. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Deactivate, never delete</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          Offboarding calls SCIM <code>DELETE /Users/&#123;id&#125;</code>, which in Slack <b>switches the account off</b> —
          it does not erase the person or their content. Their messages and files stay put (usually the whole point when
          someone leaves), the seat is freed, and an admin can reactivate them.
        </p>
      </div>

      <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Slack&rsquo;s SCIM API needs a Business+ or Enterprise Grid plan.</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          On a Pro or Free workspace the entire SCIM surface answers <code>404</code>, no matter how good the token is.
          If that&rsquo;s this client, leave the <code>slack</code> system as a <b>manual</b> step — there is no API to
          automate. The connection test says so explicitly rather than blaming the credential, so you don&rsquo;t spend
          an afternoon rotating a token that was fine all along.
        </p>
      </div>

      <h2>1. Generate the token</h2>
      <ol>
        <li>Sign in to Slack as an <b>Owner or Admin</b> (the token inherits that status — if the generating account
          loses it, the token stops working).</li>
        <li>Go to the workspace&rsquo;s <b>SCIM provisioning</b> / token page and generate a token with the <b>admin</b> scope.</li>
        <li>Copy it — it&rsquo;s shown once.</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p>
        Put the token in a field named <code>Token</code> (also accepted: <code>ApiToken</code>, <code>AccessToken</code>,
        <code>ApiKey</code>, <code>SCIMToken</code>, or the secret&rsquo;s own <code>Password</code> field). If no token
        field is found the step fails with a message listing the names it looked for and the ones the secret actually has.
      </p>
      <p className="note">Grant the app&rsquo;s Delinea service account <b>Read</b> on the secret, or the Test shows &ldquo;access denied&rdquo;.</p>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>On the client&rsquo;s <b>Credentials</b> panel, point the <code>slack</code> reference at the secret&rsquo;s Delinea ID.</li>
        <li>Click <b>Test</b> on the Slack system. It does one authorized read, which proves the token carries the
          <code>admin</code> scope <i>and</i> that the plan includes SCIM.</li>
      </ul>

      <h2>4. Verify</h2>
      <ul>
        <li><b>Update the runner</b> so it has the Slack module (Agents → Update). Slack is cloud, so the <b>central runner</b> runs it.</li>
        <li>Run the <code>slack</code> step <b>dry-run first</b>.</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        <li><b>Members are matched by email</b>, never by display handle — handles collide and get changed; email doesn&rsquo;t.</li>
        <li><b>Idempotent.</b> An already-active member on onboard, and an already-deactivated one on offboard, are
          clean no-ops. Re-running after a partial failure is safe.</li>
        <li><b>A leaver who never had Slack is not a failure.</b> The step says so and the offboard carries on — that
          case is completely normal and shouldn&rsquo;t block the rest of the offboard.</li>
        <li>The connection test can prove the token can <i>read</i>, but not that it can <i>deactivate</i> — there is no
          way to check that without deactivating a real person. The same <code>admin</code>-scoped token does both, so a
          passing read is a strong signal; the test reports the write as &ldquo;cannot verify&rdquo; rather than pretending.</li>
      </ul>
    </main>
  );
}
