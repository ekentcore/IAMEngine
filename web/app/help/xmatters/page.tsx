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
        The <code>xmatters</code> step manages the alerting roster. <b>Onboard</b> creates the person as a
        <b> Standard User</b> with a Work Email device. <b>Offboard</b> <b>deactivates</b> (status=INACTIVE) by default,
        or <b>deletes</b> when <code>config.delete</code> is set. Idempotent both ways. Runs on the <b>central runner</b>.
        Add it to whichever runbook you want (onboard, offboard, or both) via <b>Edit systems</b> on the client.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Identifiers (Coretelligent convention)</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          <b>targetName</b> (the login id) = the email&rsquo;s local part, and <b>webLogin</b> = the full email — so
          <code> ekent@core.tech</code> creates targetName <code>ekent</code> / webLogin <code>ekent@core.tech</code>, plus a
          Work Email device of <code>ekent@core.tech</code>.
        </p>
      </div>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          HTTP <b>Basic</b> with an xMatters <b>API key + secret</b> (key = username, secret = password), against
          {" "}<code>https://&#123;company&#125;.xmatters.com/api/xm/1</code>. A REST web-service user&rsquo;s
          username/password works too.
        </p>
      </div>

      <h2>1. Create an API key (xMatters)</h2>
      <ol>
        <li>As an account holding the <b>REST Web Service User</b> role (or an admin), open the user&rsquo;s
          <b> profile → Developer → API Keys → Create</b>. Copy the <b>Key</b> and <b>Secret</b> (the secret is shown once).</li>
        <li>That account needs permission to <b>view, create, and modify people</b> (and devices).</li>
        <li>Note the company URL <code>https://&#123;company&#125;.xmatters.com</code>.</li>
      </ol>

      <h2>2. Store it in Delinea (use the “Automation API” template)</h2>
      <p className="note">Create the secret from the <b>Automation API</b> template and fill its fields:</p>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>apiURL</th><td>the company URL (<code>https://&#123;company&#125;.xmatters.com</code>)</td></tr>
          <tr><th>clientID</th><td>the API <b>Key</b> (used as the Basic-auth username)</td></tr>
          <tr><th>ClientSecret</th><td>the API <b>Secret</b> (used as the Basic-auth password)</td></tr>
          <tr><th>accountId</th><td>not used by xMatters — leave blank (the template just includes it)</td></tr>
        </tbody>
      </table>
      <p className="note">Field names are matched leniently and trimmed, so the template&rsquo;s exact casing is fine.</p>

      <h2>3. Behavior config</h2>
      <p className="note">On the client&rsquo;s <code>xmatters</code> system config (nested under <code>onboard</code>/<code>offboard</code>):</p>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>onboard.role</th><td>role to assign — default <code>Standard User</code></td></tr>
          <tr><th>onboard.site</th><td>required xMatters site — default <code>Default Site</code> (set to your tenant&rsquo;s site if different)</td></tr>
          <tr><th>onboard.addEmailDevice</th><td>add a Work Email device (default <b>on</b>; set <code>false</code> to skip)</td></tr>
          <tr><th>offboard.delete</th><td>hard-delete instead of deactivate (default off)</td></tr>
        </tbody>
      </table>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>xmatters</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: onboard skips if the person already exists; offboard is a no-op when absent / already inactive.</li>
      </ul>
    </main>
  );
}
