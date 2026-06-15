// In-app setup guide: how to wire a client's Google Workspace so the central runner can create /
// suspend users via the Admin SDK Directory API. Linked from the Health page and the client Secrets
// panel. Static content — keep in sync with Coretelligent.GoogleWorkspace + the `google-workspace`
// dispatch block (Use-CtgGoogleSecret) in runner/Start-IamRunner.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Google Workspace setup" };

export default function GoogleSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Google Workspace setup</h1>
      <p className="note">
        The <code>google-workspace</code> step <b>creates a user</b> (username pattern, OU placement, group
        membership) on onboarding and, on offboarding, <b>suspends</b> the user (never deletes — data custody stays
        until the <code>archive</code> step). It runs on the <b>central / cloud runner</b>. Do this setup once per client
        that has a <code>google-workspace</code> system in its plan.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          A <b>domain-wide-delegated service account</b>. The runner builds a signed <b>RS256 JWT</b> from the service
          account&rsquo;s private key (<code>iss</code> = the service-account email, <code>sub</code> = a super-admin it
          impersonates, <code>scope</code> = the Directory scopes) and exchanges it at Google&rsquo;s token endpoint for a
          short-lived access token. No password, no OAuth screen, no external PowerShell module — and a rotated key takes
          effect on the next job. The two things you produce below are <b>(1)</b> a service-account JSON key and
          {" "}<b>(2)</b> a domain-wide-delegation authorization for it in the Workspace Admin Console.
        </p>
      </div>

      <h2>1. Create the service account + JSON key (Google Cloud Console)</h2>
      <ol>
        <li>In <b>console.cloud.google.com</b>, pick or create a project for this client.</li>
        <li><b>APIs &amp; Services → Library →</b> enable the <b>Admin SDK API</b>.</li>
        <li><b>APIs &amp; Services → Credentials → Create credentials → Service account.</b> Name it (e.g.
          <code> coretelligent-iam</code>); no project roles are needed (it acts via Workspace delegation, not GCP IAM).</li>
        <li>Open the new service account → <b>Keys → Add key → Create new key → JSON.</b> A <code>.json</code> file
          downloads — this is the secret material. <b>Keep it safe; you can&rsquo;t re-download it.</b></li>
        <li>On the service account&rsquo;s <b>Details</b> tab, copy its <b>Unique ID</b> (the numeric <b>Client ID</b>) —
          you need it for the next step.</li>
      </ol>

      <h2>2. Authorize domain-wide delegation (Workspace Admin Console)</h2>
      <ol>
        <li>In <b>admin.google.com</b> as a super-admin: <b>Security → Access and data control → API controls →
          Manage Domain-Wide Delegation.</b></li>
        <li><b>Add new.</b> Paste the service account&rsquo;s numeric <b>Client ID</b> from step 1.</li>
        <li>For <b>OAuth scopes</b>, paste (comma-separated):</li>
      </ol>
      <Code>{`https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.group,https://www.googleapis.com/auth/admin.directory.orgunit`}</Code>
      <p className="note">
        These cover create-user, OU placement, and group membership (the onboard lane). Add
        {" "}<code>https://www.googleapis.com/auth/admin.directory.user.security</code> /
        {" "}<code>…/apps.licensing</code> later if you wire sign-in-cookie reset or license assignment. <b>Authorize.</b>
      </p>
      <p className="note">Pick a <b>super-admin email</b> the service account will impersonate (any active super-admin) — you&rsquo;ll store it as <code>Impersonate</code>.</p>

      <h2>3. Store it in Delinea</h2>
      <p className="note">
        The private key is multi-line, so the simplest Delinea-safe option is to <b>base64-encode the whole JSON key
        file</b> and paste that into one field. From a terminal:
      </p>
      <Code>{`base64 -i coretelligent-iam-xxxx.json | pbcopy   # macOS — JSON key, base64, now on your clipboard`}</Code>
      <table>
        <tbody>
          <tr><th style={{ width: 200 }}>ServiceAccountKeyBase64</th><td>the base64 of the downloaded JSON key (preferred — one field, no newline issues). The runner decodes it and reads <code>client_email</code> + <code>private_key</code>.</td></tr>
          <tr><th>Impersonate</th><td><b>required</b> — the Workspace <b>super-admin email</b> to act as (domain-wide delegation impersonates a real admin).</td></tr>
          <tr><th>CustomerId</th><td>optional — defaults to <code>my_customer</code> (the secret&rsquo;s own tenant), which is correct for a single-tenant service account.</td></tr>
          <tr><th>Scopes</th><td>optional — override the default Directory scopes (comma/space separated). Leave blank to use the three above.</td></tr>
        </tbody>
      </table>
      <p className="note">
        Alternatives accepted (in case base64 is awkward): paste the raw JSON into <code>ServiceAccountJson</code>, or
        split it into <code>ClientEmail</code> + <code>PrivateKey</code> (the PEM, including the
        {" "}<code>-----BEGIN PRIVATE KEY-----</code> lines). <code>Impersonate</code> can also be read from the
        secret&rsquo;s <b>Username</b> field. If the runner can&rsquo;t find a key or an admin to impersonate, the step
        fails with a message naming the fields it looked for.
      </p>
      <p className="note">Grant the app&rsquo;s Delinea service account <b>Read</b> on the secret, or the Test shows &ldquo;access denied&rdquo;.</p>

      <h2>4. Wire it to the client</h2>
      <ul>
        <li>On the client / case <b>Credentials</b> panel, point the <code>google-admin</code> reference at the
          secret&rsquo;s Delinea ID.</li>
        <li>Set the client&rsquo;s <code>google-workspace</code> config: <b>username pattern</b> (e.g.
          {" "}<code>&#123;first&#125;.&#123;last&#125;</code> → <code>FirstName.LastName@domain</code>), the default
          {" "}<b>OU</b> (e.g. <code>/Active Users</code> — never Root), and any <b>groups</b>.</li>
        <li>Click <b>Test</b> — it confirms the app can read the secret. (The real check is the dry-run, which actually
          mints a token.)</li>
      </ul>

      <h2>5. Verify</h2>
      <ul>
        <li><b>Update the runner</b> so it has the Google module (Agents → Update). Google is cloud, so the
          {" "}<b>central runner</b> runs this step.</li>
        <li>Run the <code>google-workspace</code> step <b>dry-run first</b>. A green dry-run proves the JWT was signed,
          the token endpoint accepted it (delegation + scopes are right), and the impersonated admin is valid.</li>
        <li>Confirm the token mint by hand if needed — the fastest end-to-end check is a real onboard dry-run; a 401 at
          the token endpoint means the Client ID isn&rsquo;t authorized for the scopes, and a 403 on a Directory call
          means <code>Impersonate</code> isn&rsquo;t a super-admin (or a scope is missing).</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        <li><b>Onboarding</b> is idempotent: it skips create if the user exists, then ensures the OU and adds any missing
          groups. It <b>refuses to place a user in the Root OU</b> (<code>/</code>).</li>
        <li><b>Offboarding never deletes.</b> It captures group memberships as evidence, removes them, moves the user to
          the <b>Inactive OU</b>, optionally transfers Drive ownership to a delegate (only valid once moved out of Active
          Users), and <b>suspends</b> the account. Deletion is the later <code>archive</code> step.</li>
        <li><b>One key per client / tenant.</b> A service account lives in one Workspace tenant; each client needs its own
          service account + delegation + <code>google-admin</code> secret.</li>
      </ul>
    </main>
  );
}
