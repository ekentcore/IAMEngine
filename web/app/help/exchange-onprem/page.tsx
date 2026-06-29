// In-app setup guide: the on-prem Exchange session a HYBRID client needs (Enable-RemoteMailbox on
// onboard, Set-RemoteMailbox -Type Shared on offboard). Linked from the Modules tab. Keep in sync
// with the `exchange` dispatch block (exchange-onprem secret) in runner/Start-IamRunner.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Exchange (on-prem / hybrid) setup" };

export default function ExchangeOnPremSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/modules">← Modules</Link></p>
      <h1>Exchange on-prem / hybrid setup</h1>
      <p className="note">
        Most clients are Exchange <b>Online</b> — handled app-only by the <code>m365-admin</code> secret
        (see the <Link href="/help/cloud-auth?type=cloud">cloud auth guide</Link>); no on-prem session needed.
        This guide is only for <b>hybrid</b> clients whose mailboxes are still mastered on-prem
        (AD Connect owns the mailbox attributes), where the runner must talk to an on-prem Exchange
        server too.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Why a second session</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          On a hybrid tenant, <code>Enable-RemoteMailbox</code> (onboard) and <code>Set-RemoteMailbox -Type Shared</code>
          {" "}(offboard) must run <b>on-prem</b> — an Exchange Online <code>Set-Mailbox</code> would just be overwritten
          by AD Connect. The runner opens an on-prem Exchange remoting session <b>only when the job brokers the
          {" "}<code>exchange-onprem</code> secret</b>; without it, a cloud-only Exchange step runs as normal.
        </p>
      </div>

      <h2>1. Prereqs</h2>
      <ul>
        <li>Runs on the <b>on-prem client-network agent</b> (same box as <Link href="/help/active-directory">AD</Link>) —
          it needs network access to the Exchange server&rsquo;s PowerShell endpoint.</li>
        <li>An account with on-prem Exchange <b>Recipient Management</b> rights.</li>
      </ul>

      <h2>2. Store the <code>exchange-onprem</code> secret (Delinea)</h2>
      <p className="note"><b>Delinea template: Active Directory Account</b> (a Windows/domain account that can open a remote-PowerShell session to Exchange), plus the <code>ConnectionUri</code>. Field names are matched leniently, so any template that carries these fields works.</p>
      <table>
        <tbody>
          <tr><th style={{ width: 170 }}>Username / Password</th><td>the Recipient-Management account (can be the same as <code>ad-dc</code> if it has the rights)</td></tr>
          <tr><th>ConnectionUri</th><td>the Exchange PowerShell endpoint, e.g. <code>http://core-cce1-ex01.core.tech/PowerShell/</code></td></tr>
        </tbody>
      </table>
      <p className="note">
        Field matching (reuse an existing secret&rsquo;s URL field if you like): the URI is read from{" "}
        <code>ConnectionUri / ConnectionUrl / Uri / Url / URL / PowerShellUri / Link / Document Link</code>. Or skip the
        secret field and set <code>onPremExchangeUri</code> in the client&rsquo;s <code>exchange</code> system config.
      </p>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>Add <code>exchange-onprem</code> to the client&rsquo;s <code>exchange</code> system <code>secrets</code> and point it at the Delinea ID.</li>
        <li>Keep <code>m365-admin</code> there too — the step uses Exchange Online (app-only cert) <b>and</b> the on-prem session.</li>
      </ul>

      <h2>4. Verify</h2>
      <ul>
        <li>Dry-run the <code>exchange</code> step on a hybrid onboard — it should connect to both EXO and the on-prem
          endpoint, then <code>Enable-RemoteMailbox</code>.</li>
        <li>Sanity-check the endpoint from the agent host:
          <Code>{`$s = New-PSSession -ConfigurationName Microsoft.Exchange -ConnectionUri http://<exch-host>/PowerShell/ -Authentication Kerberos
Get-PSSession   # a session opened = the URI + rights are correct`}</Code>
        </li>
      </ul>
      <p className="note">
        Error &ldquo;the on-prem Exchange session needs a PowerShell URI&rdquo; → set <code>ConnectionUri</code> on the
        {" "}<code>exchange-onprem</code> secret (or <code>onPremExchangeUri</code> on the exchange system).
      </p>
    </main>
  );
}
