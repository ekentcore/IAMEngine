// In-app setup guide for a client's Duo integration. Keep in sync with Coretelligent.Duo +
// the `duo` dispatch block (Use-CtgDuoSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "Duo setup" };

export default function DuoSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Duo setup</h1>
      <p className="note">
        The <code>duo</code> step is <b>offboard-only</b>: it <b>deactivates</b> the departed user (status=disabled) by
        default, or <b>deletes</b> them when <code>config.delete</code> is set. Enrolment is driven by directory sync, so
        onboarding is a no-op. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The <b>Duo Admin API</b> with HMAC-SHA1 request signing — an <b>integration key</b> + <b>secret key</b> against
          the Admin API <b>hostname</b>.
        </p>
      </div>

      <h2>1. Create an Admin API application (Duo admin panel)</h2>
      <ol>
        <li><b>Applications → Protect an Application → Admin API.</b></li>
        <li>Grant it <b>Grant read resources</b> and <b>Grant write resources</b> (it must read and modify users).</li>
        <li>Copy the <b>Integration key</b>, <b>Secret key</b>, and <b>API hostname</b> (<code>api-XXXXXXXX.duosecurity.com</code>).</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p className="note"><b>Delinea template: Automation - API</b> — fill the fields below (field names are matched leniently, so any template that carries them works).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 170 }}>ApiHost</th><td>the Admin API hostname (<code>api-XXXXXXXX.duosecurity.com</code>)</td></tr>
          <tr><th>IntegrationKey</th><td>the application&rsquo;s <b>integration key</b></td></tr>
          <tr><th>SecretKey</th><td>the application&rsquo;s <b>secret key</b></td></tr>
        </tbody>
      </table>

      <h2>3. Behavior config</h2>
      <p className="note">
        On the client&rsquo;s <code>duo</code> offboard config: <b><code>delete</code></b> (default off — deactivate is
        reversible and audit-friendly; set <code>delete: true</code> only if the client requires hard removal).
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>duo</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: an already-disabled user is a no-op; a user not in Duo is a clean skip (not an error).</li>
      </ul>
    </main>
  );
}
