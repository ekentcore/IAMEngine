// In-app setup guide for a client's LogicMonitor integration. Keep in sync with
// Coretelligent.LogicMonitor + the `logicmonitor` dispatch block (Use-CtgLogicMonitorSecret).
import Link from "next/link";

export const metadata = { title: "LogicMonitor setup" };

export default function LogicMonitorSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>LogicMonitor setup</h1>
      <p className="note">
        The <code>logicmonitor</code> step is <b>offboard-only</b>: it <b>suspends</b> the departed user (an
        &ldquo;admin&rdquo; in LM) by default, or <b>deletes</b> them when <code>config.delete</code> is set. Provisioning
        is out of band, so onboarding is a no-op. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          <b>LMv1</b> token auth (HMAC-SHA256 request signing) — an <b>access id</b> + <b>access key</b> against
          {" "}<code>https://&#123;account&#125;.logicmonitor.com/santaba/rest</code>.
        </p>
      </div>

      <h2>1. Create an LMv1 API token (LogicMonitor portal)</h2>
      <ol>
        <li><b>Settings → User Access → Users &amp; Roles</b> — pick (or add) a service user with a role that can
          <b> manage users</b>.</li>
        <li>On that user, <b>Manage → API Tokens → Add</b> and copy the <b>Access ID</b> and <b>Access Key</b>.</li>
        <li>Note the portal subdomain (the <code>account</code> in <code>&#123;account&#125;.logicmonitor.com</code>).</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>Account</th><td>the portal subdomain (e.g. <code>coretelligent</code>)</td></tr>
          <tr><th>AccessId</th><td>the LMv1 <b>access id</b></td></tr>
          <tr><th>AccessKey</th><td>the LMv1 <b>access key</b></td></tr>
        </tbody>
      </table>

      <h2>3. Behavior config</h2>
      <p className="note">
        On the client&rsquo;s <code>logicmonitor</code> offboard config: <b><code>delete</code></b> (default off — suspend
        is reversible; set <code>delete: true</code> only if hard removal is required).
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>logicmonitor</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: an already-suspended user is a no-op; a user not in LogicMonitor is a clean skip.</li>
      </ul>
    </main>
  );
}
