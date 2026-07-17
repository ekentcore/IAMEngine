// In-app setup guide: the Entra app registration (and, for hybrid clients, the certificate) the
// runner needs for app-only M365 (Graph) and Exchange Online automation. The credential panels
// link here with ?type=cloud or ?type=hybrid so the page shows ONLY the steps that client needs —
// no "do I need a certificate?" homework. Without the param it asks one question up front.
// Keep in sync with Connect-CtgM365 / Connect-CtgExchange in the runner.
import Link from "next/link";
import { Code } from "../_components/code";
import { ExoCertTool } from "./_components/exo-cert-tool";
// The permission list below is RENDERED from these, not written out by hand. The hand-written copy
// drifted: it never mentioned the role a password reset needs (so no client ever granted it, and every
// reset in the fleet failed), and it handed out Domain.ReadWrite.All's id under Domain.Read.All's name.
import { GRAPH_REQUIRED_CAPS, GRAPH_OPTIONAL_CAPS, suggestedRole } from "@/lib/secrets/graph-caps";

export const metadata = { title: "M365 auth setup" };

export default function CloudAuthSetupPage({ searchParams }: { searchParams?: { type?: string } }) {
  const type = searchParams?.type === "cloud" || searchParams?.type === "hybrid" ? searchParams.type : null;

  // No variant chosen (e.g. reached from the Health page): one question, then the right guide.
  if (!type) {
    return (
      <main style={{ maxWidth: 820 }}>
        <p className="note"><Link href="/clients">← Clients</Link></p>
        <h1>Cloud auth setup (M365 + Exchange Online)</h1>
        <p className="note">
          The runner authenticates to Microsoft app-only (no user/MFA) via an <b>Entra app registration</b>,
          set up once per client. What the client needs depends on one thing:
        </p>
        <p style={{ fontSize: 15, fontWeight: 500 }}>Does this client&rsquo;s plan include an <code>exchange</code> step (on-prem Exchange)?</p>
        <ul style={{ lineHeight: 2 }}>
          <li><Link href="/help/cloud-auth?type=cloud"><b>No — cloud-only client</b> → app registration + client secret (no certificate)</Link></li>
          <li><Link href="/help/cloud-auth?type=hybrid"><b>Yes — hybrid client</b> → app registration + client secret + certificate</Link></li>
        </ul>
        <p className="note">Tip: the Credentials panel on the client/case page links straight to the right one.</p>
      </main>
    );
  }

  const hybrid = type === "hybrid";
  let n = 0;
  const step = () => ++n;

  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/clients">← Clients</Link> · <Link href={`/help/cloud-auth?type=${hybrid ? "cloud" : "hybrid"}`}>switch to the {hybrid ? "cloud-only" : "hybrid"} guide</Link></p>
      <h1>M365 auth setup — {hybrid ? "hybrid client" : "cloud-only client"}</h1>
      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        {hybrid ? (
          <>Based on this client&rsquo;s steps (its plan includes an <b>exchange</b> step — on-prem Exchange), it
            {" "}<b>needs a certificate</b> in addition to the client secret, plus the Exchange Administrator role
            (Exchange Online app-only is certificate-based). Do all the steps below, once.</>
        ) : (
          <>Cloud-only client: the <b>app registration + client secret</b> covers M365/Graph. <b>If this client has
            distribution lists</b> to add (DCG, DLs, mail-enabled groups), it <b>also needs a certificate</b> — Graph
            can&rsquo;t write DLs, so the M365 step adds them over Exchange Online with app-only cert auth. The
            certificate steps below are marked <b>(distribution lists only)</b> — skip them if this client has no DLs.</>
        )}
      </div>

      <h2>{step()}. Register the app</h2>
      <ol>
        <li>Entra ID → <b>App registrations</b> → <b>New registration</b>.</li>
        <li>Name: <code>iam-engine — &lt;client&gt;</code>. Account types: <b>Single tenant</b>. No redirect URI. <b>Register</b>.</li>
        <li>Copy the <b>Application (client) ID</b> and the <b>Directory (tenant) ID</b>.</li>
      </ol>

      <h2>{step()}. API permissions (application, not delegated)</h2>
      <p className="note">
        This is the complete list, and it is generated from the same capability table the connection test and
        the fleet audit check against (<code>lib/secrets/graph-caps.ts</code>) — so it cannot drift from what the
        runner actually calls. Each line names the <b>least-privileged</b> role that satisfies it; if the app
        already holds a broader role that covers the same ground, that counts too and the test says which one.
      </p>

      <h3>Required — every client</h3>
      <ul>
        {GRAPH_REQUIRED_CAPS.map((cap) => (
          <li key={cap.need}>
            <b>Microsoft Graph</b> → Application permissions → <code>{suggestedRole(cap)}</code> — {cap.need}.
            {cap.anyOf.length > 1 && <span className="note"> Or any of: {cap.anyOf.slice(1).join(", ")}.</span>}
          </li>
        ))}
      </ul>

      <h3>Optional — grant the ones whose feature this client uses</h3>
      <p className="note">
        A missing optional permission never fails the connection test — it is reported as “(optional)”. Most
        degrade to a warning, but two do not: a password reset and a TAP-issuing onboard <b>fail outright</b>.
        The consequence is spelled out on each line.
      </p>
      <ul>
        {GRAPH_OPTIONAL_CAPS.map((cap) => (
          <li key={cap.need}>
            <b>Microsoft Graph</b> → Application permissions → <code>{suggestedRole(cap)}</code> — {cap.need}.
            {/* `why` is a whole sentence already, and not always a consequence — some read "without
                it X", others "needed only when Y". Rendering it as its own sentence fits both; a
                "Without it:" prefix produced "Without it: without it …" and inverted the scope notes. */}
            {cap.why && <> {cap.why.charAt(0).toUpperCase() + cap.why.slice(1)}.</>}
            {cap.anyOf.length > 1 && <span className="note"> Or any of: {cap.anyOf.slice(1).join(", ")}.</span>}
          </li>
        ))}
      </ul>

      <h3>Exchange Online — a different API, not Microsoft Graph</h3>
      <ul>
        <li>{!hybrid && <b>(distribution lists only) </b>}<b>APIs my organization uses</b> → <b>Office 365 Exchange Online</b> → Application permissions → <code>Exchange.ManageAsApp</code>{!hybrid && " — only if this client has distribution lists"}. Graph cannot write distribution lists or convert a mailbox to shared, so that work goes over Exchange Online.</li>
        <li>{!hybrid && <b>(distribution lists only) </b>}<code>Exchange.ManageAsApp</code> is <b>not enough on its own</b>: the app’s <b>service principal</b> must also hold the <b>Exchange Administrator</b> directory role (Entra → Roles and administrators → Exchange Administrator → Add assignments → pick the app). A permission grant without the role still returns “access denied” on every mailbox cmdlet. Exchange Online app-only is also <b>certificate</b>-based — the client secret does not authenticate it.</li>
      </ul>

      <h3>Granting them</h3>
      <ul>
        <li className="note">Adding a permission is always a MANUAL admin step — the app registration cannot grant itself new permissions (that would need <code>Application.ReadWrite.All</code> + <code>AppRoleAssignment.ReadWrite.All</code>, which we deliberately do not hold). Portal: API permissions → Add → Grant admin consent. Or a Global Admin can run: <code>Add-MgApplicationApiPermission</code> equivalents via Graph PowerShell — e.g. add the <code>Domain.Read.All</code> app role (id <code>dbb9058a-0e50-45d7-ae91-66909b5d4664</code>) to the app’s requiredResourceAccess and then <code>New-MgServicePrincipalAppRoleAssignment</code> to consent.</li>
        <li className="note">Use the <b>application</b> role id, never the delegated one. Microsoft publishes both under the same name with different ids, and consenting the delegated id to an app-only credential grants nothing — it looks granted and still returns “Insufficient privileges”. The ids we hand out are read back from Microsoft’s own Graph service principal, so they are the application ones.</li>
        <li className="note"><b>Grant only what’s above.</b> The connection test reports the reverse too: permissions the app holds that this engine never uses. Some are merely unused, but a few — <code>RoleManagement.ReadWrite.Directory</code>, <code>AppRoleAssignment.ReadWrite.All</code>, <code>Application.ReadWrite.All</code>, <code>full_access_as_app</code> — let the credential escalate its own authority, which makes every boundary on this page advisory. If a client offers a broader role to “just make it work”, take the narrow one; the test will tell you exactly which is missing.</li>
        <li>Click <b>Grant admin consent</b> (the statuses must show a green check).</li>
      </ul>

      <h2>{step()}. Client secret (for the M365 / Graph step)</h2>
      <ol>
        <li>Certificates &amp; secrets → <b>Client secrets</b> → <b>New client secret</b> (24-month expiry).</li>
        <li>Copy the secret <b>Value</b> immediately (shown once). This is the Graph credential.</li>
      </ol>

      <h2>{step()}. Certificate {hybrid ? "(for the Exchange Online step)" : "(distribution lists only)"}</h2>
      {!hybrid && (
        <p className="note" style={{ color: "#8a6d00" }}>Skip this section if this client has <b>no distribution lists</b> — the cert is only used to add DLs over Exchange Online.</p>
      )}
      <p className="note">
        Exchange Online app-only auth is <b>certificate</b>-based. The private key never goes in the app registration —
        only the public <code>.cer</code> does; the key is stored in Delinea and brokered to the runner at run time.
        Pick the method for your runner host:
      </p>
      <p style={{ fontWeight: 600, margin: "0.6rem 0 0.2rem" }}>Easiest — generate it here (a cross-platform <code>.pfx</code>, works for any runner)</p>
      <ExoCertTool />
      <p className="note" style={{ marginTop: "0.5rem" }}>…or do it by hand:</p>
      <p style={{ fontWeight: 600, margin: "0.6rem 0 0.2rem" }}>A) Central runner on macOS / Linux (or any host) — a <code>.pfx</code> (cross-platform)</p>
      <Code>{`# Create a self-signed cert + key, bundle into a password-protected .pfx, base64 it:
openssl req -x509 -newkey rsa:2048 -keyout exo.key -out exo.cer -days 730 -nodes -subj "/CN=iam-engine-exo"
openssl pkcs12 -export -out exo.pfx -inkey exo.key -in exo.cer -passout pass:CHOOSE_A_PASSWORD
base64 -i exo.pfx | tr -d '\\n'; echo     # -> Delinea CertificateBase64 field (CertificatePassword = your password)`}</Code>
      <p style={{ fontWeight: 600, margin: "0.6rem 0 0.2rem" }}>B) Central runner on Windows — the cert store + a thumbprint</p>
      <Code>{`# In an elevated PowerShell on the runner host:
$cert = New-SelfSignedCertificate -Subject "CN=iam-engine-exo" \\
  -CertStoreLocation "Cert:\\LocalMachine\\My" -KeyExportPolicy Exportable \\
  -KeySpec Signature -NotAfter (Get-Date).AddYears(2)
$cert.Thumbprint                                   # -> Delinea CertificateThumbprint field
Export-Certificate -Cert $cert -FilePath C:\\iam-engine-exo.cer   # upload this .cer to the app`}</Code>
      <ol>
        <li>In the app registration → Certificates &amp; secrets → <b>Certificates</b> → <b>Upload certificate</b> → the <code>.cer</code> (the <b>public</b> cert only — never the <code>.pfx</code>/key).</li>
        <li>Keep the <b>CertificateBase64 + password</b> (method A) or the <b>Thumbprint</b> (method B) for the Delinea step below.</li>
      </ol>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Default: use CertificateBase64 (method A).</b> It works on every runner — the central macOS/Linux
        runner included — so it&rsquo;s the right choice for the vast majority of clients. A
        {" "}<code>CertificateThumbprint</code> (method B) only resolves on a <b>Windows</b> runner (it reads
        the Windows certificate store).
        <p style={{ margin: "0.5rem 0 0" }}>
          <b>Exception — run cloud steps on the client&rsquo;s own agent.</b> If a client already has its own
          Windows client-network agent and you&rsquo;d rather keep its Windows-store cert (thumbprint) — the
          way its native onboarding script ran everything on-prem — turn on <b>&ldquo;cloud on own
          agent&rdquo;</b> on the client page. Then <i>all</i> of that client&rsquo;s jobs (m365 / exchange
          included) are claimed by its own agent instead of the central runner, so the thumbprint works and
          the cloud + hybrid work stay co-located. It falls back to the central runner if the client has no
          agent. (Coretelligent is set up this way.)
        </p>
      </div>

      <h2>{step()}. Grant the app Exchange admin rights {!hybrid && "(distribution lists only)"}</h2>
      <p className="note">Exchange.ManageAsApp alone isn&apos;t enough — the app also needs a directory role, assigned as <b>Active</b> (not PIM-eligible).</p>
      <ul>
        <li>Entra ID → <b>Roles and administrators</b> → <b>Exchange Administrator</b> → <b>Add assignments</b> → search the app name → assign.</li>
      </ul>

      <h2>{step()}. Store it in Delinea + wire it to the client</h2>
      <p className="note">
        One secret holds everything the runner needs. <b>Template:</b> use <b>Entra Azure AD Account</b> — the same
        template the existing <code>m365-admin</code> secrets use. If you don&rsquo;t see that template (or aren&rsquo;t sure),
        open another client&rsquo;s <code>m365-admin</code> secret in Delinea and create yours with whatever template it uses —
        the runner matches the field names below, not the template name. Then point the client&rsquo;s
        {" "}<code>m365-admin</code> reference at it (on the client/case Credentials panel).
      </p>
      <table>
        <tbody>
          <tr><th style={{ width: 220 }}>TenantId <span className="note">(field)</span></th><td>the <b>Directory (tenant) ID</b> you copied in step 1 — the most reliable tenant identifier (a GUID always works, even when domain names are mis-set); the runner prefers it</td></tr>
          <tr><th style={{ width: 220 }}>Domain</th><td>the client&rsquo;s <b>main (primary) M365 domain</b>, e.g. <code>core.tech</code></td></tr>
          <tr><th>Username</th><td>the <b>Application (client) ID</b></td></tr>
          <tr><th>Password</th><td>the <b>client secret value</b> — used by the M365 / Graph step</td></tr>
          <tr>
            <th>CertificateBase64 <span className="note">+ CertificatePassword</span></th>
            <td>
              method <b>A</b> (cross-platform): the base64 <code>.pfx</code> string + its password — used for Exchange Online
              {!hybrid && <> (<b>distribution lists</b>)</>}. <i>Or</i> use <b>CertificateThumbprint</b> for method <b>B</b> (Windows runner).
              {!hybrid && <> Omit all of these if this client has no distribution lists.</>}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>{step()}. Verify</h2>
      <ul>
        <li>On the client/case Credentials panel, <b>Test</b> <code>m365-admin</code> resolves green (it confirms the app can read the secret — not that the app logs in).</li>
        <li>Run the <b>m365</b>{hybrid && <> and <b>exchange</b></>} step{hybrid ? "s" : ""} (dry-run first). A green run means the app{hybrid ? " + cert + roles are" : " is"} correct.</li>
      </ul>

      <h2>Notes</h2>
      <ul>
        <li><b>The base64 string is NOT the thumbprint.</b> The long <code>base64 -i exo.pfx</code> string goes in <code>CertificateBase64</code> (with <code>CertificatePassword</code>). <code>CertificateThumbprint</code> is a different, short (~40-char) value only used for the Windows cert-store method — leave it empty when you use the <code>.pfx</code>.</li>
        {hybrid && (
          <li><b>Where each step runs:</b> <code>m365</code> on the central / cloud runner (client secret for Graph); <code>exchange</code> on the on-prem agent. The EXO cert is brokered from Delinea at run time — it doesn&rsquo;t need to be installed in a cert store when you use the <code>.pfx</code> (method A).</li>
        )}
        <li><b>Rotation:</b> the client secret{hybrid ? " and the certificate both expire" : (" expires (and the certificate, if used)")} — calendar a renewal and update the Delinea secret.</li>
        <li><b>When we host this:</b> moving the central runner off a laptop to a server changes nothing about the app registration. For tighter security at that point, switch the M365 step from the client secret to certificate auth too (one cert on the central host) — a small runner change.</li>
      </ul>
    </main>
  );
}
