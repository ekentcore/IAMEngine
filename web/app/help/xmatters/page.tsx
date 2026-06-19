// In-app setup guide for a client's xMatters integration. Keep in sync with Coretelligent.XMatters
// + the `xmatters` dispatch block (Use-CtgXMattersSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "xMatters setup" };

export default function XMattersSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>xMatters setup</h1>
      <p className="note">
        The <code>xmatters</code> step is <b>offboard-only</b>: it <b>deactivates</b> the departed person
        (status=INACTIVE) by default, or <b>deletes</b> them when <code>config.delete</code> is set. People are
        provisioned by directory sync, so onboarding is a no-op. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          HTTP <b>Basic</b> auth as a <b>REST web-service user</b>, against
          {" "}<code>https://&#123;company&#125;.xmatters.com/api/xm/1</code>.
        </p>
      </div>

      <h2>1. Create a REST web-service user (xMatters admin)</h2>
      <ol>
        <li><b>Users → Add User</b> — create a dedicated service account with the <b>REST Web Service User</b> role.</li>
        <li>Give it permission to <b>view and modify people</b>.</li>
        <li>Note the company URL (<code>https://&#123;company&#125;.xmatters.com</code>) and the account&rsquo;s username/password.</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>BaseUrl</th><td>the company URL (<code>https://&#123;company&#125;.xmatters.com</code>)</td></tr>
          <tr><th>Username</th><td>the REST web-service user</td></tr>
          <tr><th>Password</th><td>that user&rsquo;s password</td></tr>
        </tbody>
      </table>

      <h2>3. Behavior config</h2>
      <p className="note">
        On the client&rsquo;s <code>xmatters</code> offboard config: <b><code>delete</code></b> (default off — deactivate
        keeps the person record; set <code>delete: true</code> only if hard removal is required).
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>xmatters</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: an already-inactive person is a no-op; a person not in xMatters is a clean skip.</li>
      </ul>
    </main>
  );
}
