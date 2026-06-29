// In-app setup guide: how the runner invites a new user to a client's 1Password account on onboard
// (and suspends on offboard). Method-aware — SCIM is the cleanest; api uses the `op` CLI. Keep in sync
// with Coretelligent.1Password + the `1password` dispatch in runner/Start-IamRunner.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "1Password setup" };

export default function OnePasswordSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>1Password setup (invite on onboard, suspend on offboard)</h1>
      <p className="note">
        The <code>1password</code> step <b>invites</b> the new hire into the client&rsquo;s 1Password account on
        onboarding and <b>suspends</b> them on offboarding. Because 1Password has <b>no app-only API for user
        management</b>, this step is <b>method-aware</b> — pick the one that fits the client.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Pick a method</b> — set <code>{`{ "method": "…" }`}</code> in the client&rsquo;s 1password system config:
        <ul style={{ margin: "0.4rem 0 0" }}>
          <li><b>scim</b> — provisioning is driven by your IdP (Entra). <b>Recommended.</b> The step does nothing
            itself; the Entra group does the work. (See §1.)</li>
          <li><b>api</b> — the runner runs the <b>1Password CLI</b> (<code>op user provision</code> /
            <code> op user suspend</code>) signed in as a brokered <b>admin</b> account. (See §2.)</li>
          <li><b>manual</b> — records a checklist item to invite by hand in the admin console.</li>
          <li><b>browser</b> — reserved for future Playwright automation; today it behaves like <b>manual</b>.</li>
          <li><b>auto</b> (default) — try <b>api</b>; if the CLI/admin sign-in isn&rsquo;t available it falls back to a
            <b> manual</b> checklist so the case never blocks.</li>
        </ul>
      </div>

      <h2>1. SCIM (recommended) — provision via Entra</h2>
      <p className="note">
        If the client uses 1Password&rsquo;s <b>SCIM bridge</b> with Entra, you don&rsquo;t invite from here — adding the
        user to the Entra group that 1Password provisions from does it automatically.
      </p>
      <ul>
        <li>Confirm SCIM is set up: 1Password admin → <b>Integrations</b> → <b>Provisioning / SCIM bridge</b> shows a
          connected identity provider.</li>
        <li>In the client&rsquo;s <b>Roles &amp; rules</b> (or m365/entra groups), add the new hire to the Entra group
          mapped to 1Password (e.g. <code>1Password Users</code>).</li>
        <li>Set the 1password system config to <code>{`{ "method": "scim", "scimGroup": "1Password Users" }`}</code>.
          The step records the note and (if an admin cred is also stored) verifies the user landed.</li>
      </ul>

      <h2>2. API — the 1Password CLI (<code>op</code>)</h2>
      <p className="note">
        For clients without SCIM. <b>Service accounts can&rsquo;t manage users</b>, so this needs a real
        <b> owner/admin account</b>, and the runner needs the <b>1Password CLI installed</b>.
      </p>
      <ol>
        <li><b>Install <code>op</code> on the runner</b> that handles this client (the central/cloud runner for a
          cloud system). See <code>https://developer.1password.com/docs/cli</code>.</li>
        <li>Use a dedicated <b>admin/owner</b> account that can provision users. It must be <b>exempt from MFA</b>
          (or the headless sign-in can&rsquo;t answer the prompt).</li>
      </ol>
      <p className="note">Store these fields on the client&rsquo;s <code>1password</code> Delinea secret (<b>template: Automation - API</b>; field names are matched leniently, so any template that carries them works):</p>
      <table>
        <tbody>
          <tr><th style={{ width: 170 }}>SignInAddress</th><td>the account sign-in URL, e.g. <code>coretelligent.1password.com</code></td></tr>
          <tr><th>Email</th><td>the admin account&rsquo;s email</td></tr>
          <tr><th>SecretKey</th><td>the admin account&rsquo;s <b>Secret Key</b> (Settings → your account)</td></tr>
          <tr><th>Password</th><td>the admin account&rsquo;s password</td></tr>
        </tbody>
      </table>
      <p className="note">What it runs (idempotent — skips a user already present / already suspended):</p>
      <Code>{`# onboard
op user provision --name "Jane Doe" --email jane.doe@acme.com
# offboard
op user suspend jane.doe@acme.com`}</Code>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>On the client&rsquo;s <b>Systems</b>, add <code>1password</code> (onboard / offboard lanes), point its
          <code> 1password</code> secret reference at the Delinea ID, and set the <code>method</code> in its config.</li>
        <li><b>Test connections</b> — for <code>api</code> it signs in and reads the user list; for scim/manual it
          reports there&rsquo;s no API credential to test.</li>
        <li><b>Update the runner</b>, then run the step <b>dry-run first</b>.</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        <li><b>Invites are async.</b> <code>op user provision</code> emails the user; they&rsquo;re &ldquo;invited&rdquo; until they
          accept. The step re-checks on a later sweep and the validation passes once they appear.</li>
        <li><b>auto fallback</b> is logged: if it couldn&rsquo;t invite automatically you&rsquo;ll see a
          <code> MANUAL: invite …</code> action with the reason — do it by hand and re-run to verify.</li>
        <li>A true <b>browser</b> (Playwright) invite is a planned follow-up; today <code>browser</code> = manual.</li>
      </ul>
    </main>
  );
}
