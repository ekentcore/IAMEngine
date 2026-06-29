// In-app setup guide: the Perimeter 81 (Harmony SASE) API key so the runner can add/remove a user
// on onboarding/offboarding. Linked from the Modules tab + client Secrets panel (secret
// `perimeter81`). Keep in sync with Coretelligent.Perimeter81 + its dispatch block.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Perimeter 81 setup" };

export default function Perimeter81SetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/modules">← Modules</Link></p>
      <h1>Perimeter 81 setup</h1>
      <p className="note">
        The <code>perimeter81</code> step manages a user&rsquo;s VPN/SASE access. It is usually
        {" "}<b>group-driven</b> (membership is granted by the AD/365 group sync, not by adding the user directly),
        so onboard is often <code>on-request</code>; offboard removes the user and down-ticks the license. Cloud
        API, so the <b>central runner</b> runs it.
      </p>

      <div style={{ border: "1px solid #fde68a", background: "#fffbeb", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>⚠ API caveat</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          Perimeter 81 became <b>Check Point Harmony SASE</b>; there&rsquo;s no stable public reference for the current
          API. The module&rsquo;s endpoint paths are <b>best-effort</b> and must be verified against the tenant (they live
          behind one seam — <code>$script:P81ApiUrl</code> + the paths). The behaviour (add/remove + verify) is correct;
          confirm the endpoints on a dry-run before trusting a live run.
        </p>
      </div>

      <h2>1. Get an API key</h2>
      <ol>
        <li>In the Perimeter 81 / Harmony SASE admin console, open the <b>API keys</b> area (Settings → API).</li>
        <li>Issue a key for automation. It&rsquo;s used as a <b>bearer token</b>.</li>
      </ol>

      <h2>2. Store the <code>perimeter81</code> secret (Delinea)</h2>
      <p className="note"><b>Delinea template: Automation - API</b> — put the API key in the <code>ApiKey</code> field. Field names are matched leniently, so any template that carries it works.</p>
      <table>
        <tbody>
          <tr><th style={{ width: 160 }}>ApiKey</th><td>the API key (sent as the bearer token). <b>Required field</b> — the Connect step reads <code>Fields['ApiKey']</code>.</td></tr>
        </tbody>
      </table>
      <p className="note">If the tenant&rsquo;s API base differs from <code>https://api.perimeter81.com</code>, note it — it&rsquo;s adjusted in the module&rsquo;s one URL seam.</p>

      <h2>3. Wire it to the client</h2>
      <ul>
        <li>Add <code>perimeter81</code> to the client&rsquo;s systems with <code>secrets: ["perimeter81"]</code>.</li>
        <li>Onboard is typically <code>on-request</code> (group-driven); offboard <code>always</code> (remove user + free the seat).</li>
      </ul>

      <h2>4. Verify</h2>
      <ul>
        <li>Dry-run the <code>perimeter81</code> step first (it confirms the key + endpoints without mutating).</li>
        <li>Quick key check (adjust the path to the tenant&rsquo;s API):
          <Code>{`curl -s -H "Authorization: Bearer <ApiKey>" https://api.perimeter81.com/...   # 200 = key accepted`}</Code>
        </li>
      </ul>
    </main>
  );
}
