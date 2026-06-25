// In-app setup guide: Entra Connect (Azure AD Connect) delta sync after an AD change. Linked from
// the Modules tab. Keep in sync with Coretelligent.DirectorySync + the directory-sync dispatch block.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Entra Connect sync setup" };

export default function DirectorySyncSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/modules">← Modules</Link></p>
      <h1>Entra Connect sync setup</h1>
      <p className="note">
        For an <code>ad-synced</code> client, after the on-prem AD account is created/disabled the
        {" "}<code>directory-sync</code> step runs <code>Start-ADSyncSyncCycle -PolicyType Delta</code> so the change
        reaches Entra/M365 promptly (instead of waiting for the 30-min scheduler). It depends on the
        {" "}<Link href="/help/active-directory">AD step</Link> and uses the same <code>ad-dc</code> credential.
      </p>

      <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Where it runs</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The <code>ADSync</code> cmdlets ship with <b>Azure AD Connect</b> and exist only on the Connect
          server — which is often <b>not</b> the DC. The agent either runs on the Connect server, or
          {" "}<b>remotes into it</b> using the <code>ad-dc</code> credential.
        </p>
      </div>

      <h2>1. Make sure an on-prem agent is running</h2>
      <p className="note">
        Same client-network agent as <Link href="/help/active-directory">Active Directory</Link>. If the agent host
        already has Azure AD Connect, nothing else is needed.
      </p>

      <h2>2. If AAD Connect is on a different server — set the host to remote into</h2>
      <p className="note">On the client&rsquo;s <code>directory-sync</code> system, set its config:</p>
      <Code>{`{ "onboard": { "config": { "host": "CORE-CCE-AzSync01" } },
  "offboard": { "config": { "host": "CORE-CCE-AzSync01" } } }`}</Code>
      <p className="note">
        The agent then opens a remote session to <code>host</code> with the <code>ad-dc</code> credential and runs the
        sync there. The <code>ad-dc</code> account must have rights to run ADSync on that box.
      </p>

      <h2>3. Secret</h2>
      <p className="note">
        Reuses <code>ad-dc</code> (no separate secret) — see the{" "}
        <Link href="/help/active-directory">Active Directory guide</Link> for storing it (Username/Password + the
        {" "}<code>Server</code> DC field).
      </p>

      <h2>4. Verify</h2>
      <ul>
        <li>Run the AD onboard, then the <code>directory-sync</code> step — the run report should show the delta cycle
          started. Within a minute or two the user appears in Entra/M365.</li>
        <li>By hand on the Connect host: <Code>{`Start-ADSyncSyncCycle -PolicyType Delta
Get-ADSyncScheduler   # confirms the ADSync module is available`}</Code></li>
      </ul>
      <p className="note">If you see &ldquo;Get-ADSyncScheduler is not recognized&rdquo;, Azure AD Connect isn&rsquo;t on that
        host — point <code>config.host</code> at the box that has it.</p>
    </main>
  );
}
