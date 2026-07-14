// In-app setup guide: the Adobe UMAPI (OAuth Server-to-Server) credential so the runner can add a
// user to product profiles (onboard) and remove them from the org (offboard). Linked from the
// Modules tab + client Secrets panel (secret `adobe`). Keep in sync with Coretelligent.Adobe.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Adobe setup" };

export default function AdobeSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/modules">← Modules</Link></p>
      <h1>Adobe setup (User Management API)</h1>
      <p className="note">
        The <code>adobe</code> step manages <b>entitlements</b>, not identity: onboard <b>adds the user to the
        configured product profile(s)</b> (profile membership grants the product); offboard <b>removes the user
        from the organization</b> (revokes all access). The identity itself comes from your directory/SSO.
        Adobe is cloud, so the <b>central runner</b> runs this.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          OAuth <b>Server-to-Server</b> (UMAPI v2). The <code>adobe</code> secret holds
          {" "}<b>username = Client ID</b>, <b>password = Client Secret</b>, plus your
          {" "}<b>organization id</b> (<code>…@AdobeOrg</code>) — which goes in <code>accountid</code>,
          {" "}since the <b>Automation - API</b> template has no <code>OrgId</code> field. The runner gets a
          {" "}token from Adobe IMS and sends <code>X-Api-Key = client id</code> on every call.
        </p>
        <p style={{ margin: "0.4rem 0 0" }}>
          You do <b>not</b> store an access token (the runner mints a short-lived one per connect), the
          {" "}scopes (fixed: <code>openid,AdobeID,user_management_sdk</code>), or a technical-account
          {" "}id/email — those belong to Adobe&apos;s <b>deprecated Service Account (JWT)</b> flow. If your
          {" "}credential came with a technical account id and a private key, it was created as the wrong
          {" "}integration type: make a new <b>OAuth Server-to-Server</b> credential.
        </p>
      </div>

      <h2>1. Create the Server-to-Server credential</h2>
      <ol>
        <li>You need to be an Adobe <b>System Administrator</b>.</li>
        <li><b>Adobe Developer Console</b> → <i>Create new project</i> → <b>Add API</b> → <b>User Management API</b> →
          choose <b>OAuth Server-to-Server</b> → assign it a product profile/role.</li>
        <li>From the credential&rsquo;s overview note the <b>Client ID</b>, <b>Client Secret</b>, and your
          {" "}<b>Organization ID</b> (<code>…@AdobeOrg</code>).</li>
      </ol>

      <h2>2. Find the product-profile name(s)</h2>
      <p className="note">
        Adobe <b>Admin Console</b> → <b>Products</b> → a product → <b>Profiles</b> tab. Copy the profile name(s)
        <b> exactly</b> (e.g. <code>Acrobat Pro - All Apps</code>) — a typo silently grants nothing.
      </p>

      <h2>3. Store the <code>adobe</code> secret (Delinea)</h2>
      <p className="note"><b>Delinea template: Automation - API</b> — fill the fields below (field names are matched leniently, so any template that carries them works).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>Username</th><td>the <b>Client ID</b> (or a <code>clientID</code> field)</td></tr>
          <tr><th>Password</th><td>the <b>Client Secret</b> (or a <code>ClientSecret</code> field)</td></tr>
          <tr><th>accountid</th><td>your organization id, <code>XXXXXXXXXXXX@AdobeOrg</code>. The stock template has no <code>OrgId</code> field, so it goes here — an <code>OrgId</code> field is still honoured if your secret has one.</td></tr>
        </tbody>
      </table>

      <h2>4. Wire it to the client</h2>
      <p className="note">Add the <code>adobe</code> system with the profiles to grant (Edit systems, or in the profile JSON):</p>
      <Code>{`{ "key": "adobe", "mode": "api", "secrets": ["adobe"], "dependsOn": ["m365"],
  "onboard":  { "when": "on-request",
                "config": { "productProfiles": ["Acrobat Pro - All Apps"] } },
  "offboard": { "when": "always" } }`}</Code>

      <h2>5. Verify</h2>
      <ul>
        <li>Use <b>&ldquo;▶ run this step only&rdquo;</b> (or a dry-run) on a test onboard. The read-back
          (<code>Confirm-CtgAdobe</code>) checks the user is in each configured profile; cross-check in Admin Console.</li>
        <li>Token check by hand:
          <Code>{`# get a token, then GET the org's users (200 = creds + OrgId correct)
curl -s -X POST https://ims-na1.adobelogin.com/ims/token/v3 \\
  -d grant_type=client_credentials -d scope=openid,AdobeID,user_management_sdk \\
  -d client_id=<id> -d client_secret=<secret>`}</Code>
        </li>
      </ul>
      <p className="note">
        Common failures: <code>invalid_client</code> = wrong/swapped Client ID/Secret; &ldquo;no Adobe product profiles
        configured&rdquo; = empty <code>config.onboard.productProfiles</code>; add succeeds but no access = the profile
        <b> name</b> doesn&rsquo;t match Admin Console, or the email isn&rsquo;t a known Adobe identity yet.
        Asset transfer + license procurement are not automated — do those in the Admin Console.
      </p>
    </main>
  );
}
