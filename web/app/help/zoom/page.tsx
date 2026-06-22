// In-app setup guide for a client's Zoom integration. Keep in sync with Coretelligent.Zoom +
// the `zoom` dispatch block (Use-CtgZoomSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "Zoom setup" };

export default function ZoomSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Zoom setup</h1>
      <p className="note">
        The <code>zoom</code> step manages a user&rsquo;s Zoom account over the Zoom REST API v2.
        <b> Onboard</b> creates the user as <b>Licensed</b> (a Pro license) and, if configured, assigns a Zoom Phone
        calling plan + number — and it <b>upgrades an existing Basic user to Licensed</b>, so re-running is safe.
        <b> Offboard</b> <b>deactivates</b> the user (which releases the license back to your pool and blocks login —
        reversible) or <b>deletes</b> them when <code>config.delete</code> is set, and revokes their SSO session.
        Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          A Zoom <b>Server-to-Server OAuth</b> app — an <b>Account ID</b> + <b>Client ID</b> + <b>Client Secret</b>.
          The runner exchanges them for a short-lived bearer token at the start of each job (no user is involved, and
          there is nothing to renew manually).
        </p>
      </div>

      <h2>1. Create a Server-to-Server OAuth app (Zoom App Marketplace)</h2>
      <ol>
        <li>Sign in to the <a href="https://marketplace.zoom.us" target="_blank" rel="noreferrer">Zoom App Marketplace</a> as an <b>account admin</b> (or a role with the Marketplace &amp; user-management privileges).</li>
        <li><b>Develop → Build App → Server-to-Server OAuth → Create.</b> Name it e.g. <code>Coretelligent IAM</code>.</li>
        <li>On <b>App Credentials</b>, copy the <b>Account ID</b>, <b>Client ID</b>, and <b>Client Secret</b>.</li>
        <li>Fill in the required <b>Information</b> fields (company name, contact) — Zoom won&rsquo;t let you activate without them.</li>
        <li>On <b>Scopes</b>, add (Add Scopes → search) the <b>granular</b> scopes below — this is the exact
          set the live Coretelligent app uses (14):
          <ul>
            <li><b>User</b> (always required):
              <ul>
                <li><code>user:read:user:admin</code> — read a user</li>
                <li><code>user:read:list_users:admin</code> — list users (used to resolve an offboard by display name)</li>
                <li><code>user:update:user:admin</code> — set the license tier (type)</li>
                <li><code>user:update:status:admin</code> — deactivate / activate</li>
                <li><code>user:delete:user:admin</code> — delete (hard removal, when configured)</li>
                <li><code>user:delete:token:admin</code> — revoke the SSO token / sign out</li>
              </ul>
            </li>
            <li><b>Phone</b> (<i>only if you use the Zoom Phone provisioning</i> — calling plan + number):
              <ul>
                <li><code>phone:read:list_users:admin</code></li>
                <li><code>phone:read:numbers:admin</code></li>
                <li><code>phone:write:calling_plan:admin</code></li>
                <li><code>phone:update:calling_plan:admin</code></li>
                <li><code>phone:delete:users_calling_plan:admin</code></li>
                <li><code>phone:read:call:admin</code>, <code>phone:read:call_log:admin</code>, <code>phone:read:list_call_logs:admin</code></li>
              </ul>
            </li>
          </ul>
        </li>
        <li><b>Turn OFF the &ldquo;new experience&rdquo; toggle</b> — it&rsquo;s at the <b>top-right of the app&rsquo;s build
          page</b>. The integration is validated against the <b>classic</b> experience; with the new one on, the granular
          scopes above don&rsquo;t map the same way and admin calls (deactivate, list users) can 400.</li>
        <li><b>Activate</b> the app (Activation → Activate your app).</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p className="note">Wire a <code>zoom</code> secret on the client, then map these fields:</p>
      <table>
        <tbody>
          <tr><th style={{ width: 170 }}>Username</th><td>the app&rsquo;s <b>Client ID</b></td></tr>
          <tr><th>Password</th><td>the app&rsquo;s <b>Client Secret</b></td></tr>
          <tr><th>AccountId</th><td>the app&rsquo;s <b>Account ID</b> (a custom field on the secret)</td></tr>
        </tbody>
      </table>
      <p className="note">
        Field names are matched leniently — <code>ClientId</code>/<code>Client Secret</code> custom fields work too, and
        <code>Account</code>/<code>AccountID</code> are accepted for the account id. If something&rsquo;s missing the runner
        says exactly which field it looked for and what the secret actually has.
      </p>

      <h2>3. Behavior config</h2>
      <p className="note">
        Set on the client&rsquo;s <code>zoom</code> system config (Client → <b>Edit systems</b> → the config cell, the
        profile JSON, or a wiring script). Knobs are <b>nested under the action</b> — <code>onboard</code> knobs go in
        an <code>onboard</code> object, <code>offboard</code> knobs in an <code>offboard</code> object:
      </p>
      <pre style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, padding: "0.7rem 0.9rem", fontSize: 12, overflowX: "auto" }}>{`{
  "onboard":  { "type": 2, "phone": { "callingPlanType": 200, "number": "+15551230000" } },
  "offboard": { "delete": false, "revokeSso": true }
}`}</pre>
      <table>
        <tbody>
          <tr><th style={{ width: 170 }}>onboard.type</th><td>license tier — <code>2</code> = Licensed/Pro (default), <code>1</code> = Basic (no license)</td></tr>
          <tr><th>onboard.phone</th><td>optional Zoom Phone: <code>{`{ callingPlanType, number | numberId }`}</code> — the number must already be in the account&rsquo;s pool. Omit to skip.</td></tr>
          <tr><th>offboard.delete</th><td>hard-delete instead of deactivate (default off — deactivate is reversible and audit-friendly)</td></tr>
          <tr><th>offboard.revokeSso</th><td>revoke the SSO session (default <b>on</b>; set <code>false</code> to skip)</td></tr>
        </tbody>
      </table>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>zoom</code> step <b>dry-run first</b>.</li>
        <li>Onboard validation checks the user is present <b>and</b> holds the expected license tier; offboard checks the user is deleted or deactivated.</li>
        <li>Idempotent: an existing user is licensed (not re-created); an already-deactivated/absent user is a clean skip, not an error.</li>
      </ul>
    </main>
  );
}
