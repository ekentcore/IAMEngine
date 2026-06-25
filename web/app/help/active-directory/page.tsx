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
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The AD module connects with <code>Get-ADUser/New-ADUser -Server &lt;DC&gt; -Credential &lt;ad-dc&gt;</code>.
          The <code>ad-dc</code> secret carries that domain account (Username/Password) <b>plus a
          {" "}<code>Server</code> field</b> = the DC hostname/FQDN to target.
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

      <h2>3. Store the <code>ad-dc</code> secret (Delinea)</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>Username / Password</th><td>a <b>delegated</b> domain account that can create/modify/disable users in the target OUs (least-privilege; avoid Domain Admin where possible)</td></tr>
          <tr><th>Server</th><td>the DC to target, e.g. <code>CORE-CCE-DC01</code> (hostname or FQDN). <b>Required</b> — without it the AD connection has no DC.</td></tr>
        </tbody>
      </table>

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
