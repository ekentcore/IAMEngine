// In-app setup guide: the on-prem agent + ad-dc credential that let the runner manage Active
// Directory (and trigger Entra Connect sync). Linked from the Modules tab and the client Secrets
// panel (secret `ad-dc`). Keep in sync with Coretelligent.ActiveDirectory + docs/runner-dc-setup.md.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Active Directory setup" };

export default function ActiveDirectorySetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/modules">← Modules</Link></p>
      <h1>Active Directory setup (on-prem agent)</h1>
      <p className="note">
        <code>active-directory</code> and <code>directory-sync</code> are <b>on-prem only</b> — the
        central cloud runner never runs them. Any <code>ad-synced</code> / <code>ad-standalone</code>
        {" "}client needs a <b>client-network agent</b> inside its network, plus an <code>ad-dc</code>
        {" "}credential. Once set up, the runner does <code>New-ADUser</code> / group changes /
        {" "}<code>Start-ADSyncSyncCycle</code> locally and posts results back over outbound HTTPS.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates — both fields are optional</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The runner splats <code>-Server</code> and <code>-Credential</code> onto the AD cmdlets <b>only if the
          {" "}<code>ad-dc</code> secret provides them</b>:
        </p>
        <ul style={{ margin: "0.4rem 0 0" }}>
          <li><b>Agent runs on the DC (or any domain-joined host) as an account with AD rights</b> — e.g. a gMSA /
            service account. You can skip the <code>Server</code> field entirely (cmdlets use the local/logon DC),
            and even skip the credential (the runner&rsquo;s own identity is used). The secret may not be needed at all.</li>
          <li><b>Set <code>Server</code></b> only to pin a <i>specific</i> DC, or when the agent isn&rsquo;t on a domain
            host and must target one remotely. <b>Set the credential</b> only to act as a different account than the
            process identity.</li>
        </ul>
        <p className="note" style={{ margin: "0.4rem 0 0" }}>
          So your template not having a <code>Server</code> field is fine — leave it off when the agent is on the DC.
        </p>
      </div>

      <h2>1. Install the agent on a domain host</h2>
      <ul>
        <li>A domain-joined Windows host with the <b>RSAT ActiveDirectory</b> module and line of sight to a DC
          (the DC itself works; a management/jump host is preferred).</li>
        <li><b>PowerShell 7</b> (<code>winget install Microsoft.PowerShell</code>) — the runner is <code>#Requires 7.0</code>.</li>
        <li>RSAT module on a member server: <Code>{`Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools`}</Code></li>
      </ul>
      <p className="note">Full host + supervisor (Scheduled Task) steps: see <code>docs/runner-dc-setup.md</code> in the repo.</p>

      <h2>2. Enroll the agent</h2>
      <p className="note">
        <Link href="/agents">Agents</Link> → <b>Add agent</b> → scope <b>client-network</b>, pick the client → it
        returns an <b>AgentId</b>. (A client-network agent only ever sees that client&rsquo;s jobs.)
      </p>
      <Code>{`mkdir C:\\iam-runner
pwsh -File C:\\iam-runner\\update-dc-runner.ps1 -AppUrl https://<app> -AgentId <AgentId>`}</Code>

      <h2>3. Store the <code>ad-dc</code> secret (Delinea) — only what you need</h2>
      <p className="note">All fields are optional; add only the ones that apply (see the box above).</p>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>Username / Password</th><td><i>optional</i> — a <b>delegated</b> domain account that can create/modify/disable users in the target OUs (least-privilege). Omit if the agent already runs as an account with AD rights.</td></tr>
          <tr><th>Server (DC name)</th><td><i>optional</i> — a specific DC to target, e.g. <code>CORE-CCE-DC01</code>. <b>Omit when the agent is on the DC</b> (the cmdlets use the local domain); set it only to pin or remotely target a DC. <b>On the <code>Active Directory Account</code> template</b> (which has no Server field) put the DC name in the <b><code>Documentation Link</code></b> field — the runner reads it from there (also accepts <code>Server</code> / <code>DomainController</code>). A real URL in that field is ignored, so it&rsquo;s only used when it&rsquo;s a hostname.</td></tr>
        </tbody>
      </table>
      <p className="note">
        If the agent runs as a domain service account with the needed rights, you may not need an <code>ad-dc</code> secret
        at all — the client&rsquo;s <code>active-directory</code> system can run on the process identity.
      </p>

      <h2>4. Wire it to the client</h2>
      <ul>
        <li>Point the client&rsquo;s <code>ad-dc</code> credential reference at the Delinea secret ID; make sure the
          {" "}<code>active-directory</code> system lists <code>ad-dc</code> in its secrets.</li>
        <li>Set the backbone to <code>ad-synced</code> (syncs to Entra) or <code>ad-standalone</code> (separate, unsynced M365).</li>
      </ul>

      <h2>5. Verify</h2>
      <ul>
        <li>The <Link href="/agents">Agents</Link> page shows the agent heartbeating. The built-in connectivity test runs
          {" "}<code>Get-ADDomain</code> and reports the domain.</li>
        <li>On a test onboard, use <b>&ldquo;▶ run this step only&rdquo;</b> on the AD step: <code>New-ADUser</code> lands and
          {" "}<code>Confirm-CtgAD</code> passes.</li>
      </ul>
      <p className="note">
        For the Entra Connect sync that pushes the new account up to M365, see the{" "}
        <Link href="/help/directory-sync">Entra Connect sync guide</Link>.
      </p>
    </main>
  );
}
