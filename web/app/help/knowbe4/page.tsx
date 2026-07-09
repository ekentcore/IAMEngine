// In-app setup guide for a client's KnowBe4 integration. Keep in sync with Coretelligent.KnowBe4
// + the `knowbe4` dispatch block (Use-CtgKnowBe4Secret) in runner/Start-IamRunner.ps1.
import Link from "next/link";

export const metadata = { title: "KnowBe4 setup" };

export default function KnowBe4SetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>KnowBe4 setup</h1>
      <p className="note">
        The <code>knowbe4</code> step <b>creates a user</b> on onboarding and <b>deactivates</b> them on offboarding.
        Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Important: KnowBe4 has no create-user REST API</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          KnowBe4&rsquo;s public API (<code>us.api.knowbe4.com/v1</code>) is <b>read-only reporting</b>. All user
          creation goes through <b>SCIM 2.0</b>. This module calls the SCIM endpoint directly with a SCIM token.
          {" "}<b>If this client already provisions KnowBe4 from Entra/Okta SCIM sync, you don&rsquo;t need this step</b> —
          the account appears automatically; wire <code>knowbe4</code> only where there is no IdP sync.
        </p>
      </div>

      <h2>1. Get a SCIM token (admin portal)</h2>
      <p className="note">Admin portal: <code>https://training.knowbe4.com</code> (US) — for EU/other regions use that region&rsquo;s console.</p>
      <ol>
        <li>First configure <b>SAML SSO</b> for the account (SCIM requires SSO).</li>
        <li><b>Account Settings → User Management → SCIM</b> → generate a <b>SCIM Bearer token</b>. (This is separate from
          the read-only Reporting API key.)</li>
        <li>Note your SCIM base URL — US is <code>https://training.knowbe4.com/scim/v2</code>.</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <p className="note"><b>Delinea template: Automation - API</b> — fill the fields below (field names are matched leniently, so any template that carries them works).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>ScimToken</th><td>the SCIM <b>Bearer token</b></td></tr>
          <tr><th>BaseUrl</th><td>optional — SCIM base for the region; default <code>https://training.knowbe4.com/scim/v2</code></td></tr>
        </tbody>
      </table>

      <h2>3. Default licensing</h2>
      <p className="note">
        KnowBe4 seats and training-group assignment are managed <b>inside the KnowBe4 console</b> (or by smart groups) —
        the SCIM create just provisions the user as <code>active</code>. No license field is set from here.
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>knowbe4</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: skips create if the userName (email) exists and matches the person; offboard sets <code>active=false</code> via SCIM PATCH.</li>
      </ul>
    </main>
  );
}
