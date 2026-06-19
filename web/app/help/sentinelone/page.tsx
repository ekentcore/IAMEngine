// In-app setup guide for a client's SentinelOne integration. Keep in sync with
// Coretelligent.SentinelOne + the `sentinelone` dispatch block (Use-CtgSentinelOneSecret).
import Link from "next/link";

export const metadata = { title: "SentinelOne setup" };

export default function SentinelOneSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>SentinelOne setup</h1>
      <p className="note">
        The <code>sentinelone</code> step is <b>offboard-only</b>: it <b>network-isolates</b> (quarantines) the departed
        user&rsquo;s endpoint and, only when <code>config.shutdown</code> is set, shuts it down. Agent deployment is out
        of band (MSI/RMM), so onboarding is a no-op. Runs on the <b>central runner</b>.
      </p>

      <div style={{ border: "1px solid #fecaca", background: "#fef2f2", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Destructive — gated</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          Isolate is reversible; <b>shutdown is not</b>. The step resolves the machine from the case (the Entra device
          the M365 step captured, or <code>config.machineName</code>) and <b>refuses to act if it can&rsquo;t match exactly
          one agent</b> — a wrong match would isolate/kill the wrong endpoint. Keep <code>requiresApproval</code> on for
          this client&rsquo;s offboard so an operator signs off before it runs.
        </p>
      </div>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>How it authenticates</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The <code>Authorization: ApiToken &lt;token&gt;</code> header against the management console (API v2.1). Use a
          <b> service user&rsquo;s</b> API token, not a personal one.
        </p>
      </div>

      <h2>1. Create a service-user API token (console)</h2>
      <ol>
        <li>In the SentinelOne console: <b>Settings → Users → Service Users → Create</b> (or use an existing service user).</li>
        <li>Give it a role that can <b>disconnect/connect</b> and <b>shut down</b> agents (Admin or a scoped custom role).</li>
        <li>Generate its <b>API token</b> and copy it. Note the console URL (e.g. <code>https://usea1-partners.sentinelone.net</code>).</li>
      </ol>

      <h2>2. Store it in Delinea</h2>
      <table>
        <tbody>
          <tr><th style={{ width: 150 }}>BaseUrl</th><td>the management console URL (e.g. <code>https://usea1-partners.sentinelone.net</code>)</td></tr>
          <tr><th>ApiToken</th><td>the service-user <b>API token</b></td></tr>
        </tbody>
      </table>

      <h2>3. Behavior config</h2>
      <p className="note">
        On the client&rsquo;s <code>sentinelone</code> offboard config: <b><code>shutdown</code></b> (default off — isolate
        only), and <b><code>machineName</code></b> only if the Entra device step can&rsquo;t resolve the endpoint.
      </p>

      <h2>Verify</h2>
      <ul>
        <li>Update the runner (Agents → Update), then run the <code>sentinelone</code> step <b>dry-run first</b>.</li>
        <li>Idempotent: an already-isolated endpoint is a no-op; an unresolved/ambiguous machine takes no action and says so.</li>
      </ul>
    </main>
  );
}
