// In-app runbook for a runner that won't come online. Written from the real failures we've hit:
// the fail-open -> fail-closed token flip, the SYSTEM-task machine-env reboot trap, and the browser
// sidecar blocking the first heartbeat. Linked from the Agents page (and the per-agent Troubleshoot
// dialog). Keep in sync with lib/runner/troubleshoot.ts + api/runner/install.ps1.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Runner troubleshooting" };

const Sym = ({ children }: { children: React.ReactNode }) => (
  <p style={{ margin: "0.25rem 0 0.6rem", fontStyle: "italic", color: "var(--muted)" }}>{children}</p>
);

export default function RunnerTroubleshootingPage() {
  return (
    <main style={{ maxWidth: 860 }}>
      <p className="note"><Link href="/agents">← Agents</Link></p>
      <h1>Runner troubleshooting</h1>
      <p className="note">
        An agent that shows <b>offline</b>, <b>pre-build</b>, or is stuck <b>“updating…”</b> almost always has one of
        four causes below. Start with the <b>Troubleshoot</b> command on the agent&rsquo;s row — it checks each of these
        and now <b>offers to fix</b> what it safely can.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.9rem 0" }}>
        <b>The one rule that catches most people</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The runner is a <b>SYSTEM Scheduled Task</b>. It only picks up <b>machine</b> environment variables after a{" "}
          <b>REBOOT</b> — the Task Scheduler service caches the environment at its own start. Setting a variable and
          restarting the task is <b>not</b> enough. If you changed <code>RUNNER_API_TOKEN</code> or{" "}
          <code>IAM_RUNNER_NO_BROWSER_INSTALL</code>, reboot the host.
        </p>
      </div>

      <h2>1. Agent gets 401 — “runner API rejected the token”</h2>
      <Sym>Symptom: enrolled, but never checks in. Troubleshoot prints “runner API rejected the token (401)”.</Sym>
      <p>
        The app only enforces runner auth when <code>RUNNER_API_TOKEN</code> is set on the <b>app</b>. Add it (or run{" "}
        <code>npm run env:sync</code>, which writes it into <code>web/.env</code>) and the app flips from
        fail-<i>open</i> to fail-<i>closed</i> — every runner host whose token doesn&rsquo;t match is now rejected.
        In <b>production</b> it fails closed regardless: a missing token returns <b>503</b> and <i>no</i> agent connects.
      </p>
      <p>
        <b>Fix:</b> re-run the agent&rsquo;s <b>install command</b> from the Agents page (the installer is token-gated and
        sets the token machine-wide), then <b>reboot</b>. The troubleshoot script deliberately carries <b>no secrets</b>,
        so it cannot set the token for you — that is why it points you back to the installer.
      </p>

      <h2>2. Agent goes silent right after updating</h2>
      <Sym>Symptom: it checks in once, receives the update, then disappears. The UI shows “updating…” forever.</Sym>
      <p>
        This is the <b>browser sidecar</b>. Runners before <b>1.41.0</b> ran <code>npm install</code> plus a ~170&nbsp;MB
        Chromium download <b>inline at startup, before the first heartbeat</b>. On a domain controller with no egress to
        npmjs.org / the Playwright CDN it blocks for up to <b>15 minutes</b> and then still has no browser — so the agent
        looks stuck on an install/auth problem it doesn&rsquo;t have.
      </p>
      <p>
        <b>A DC never needs a browser.</b> Browser automation (the Spanning force-sync) is a <b>central-runner</b> job.
        Disable it on client agents:
      </p>
      <Code>{`[Environment]::SetEnvironmentVariable('IAM_RUNNER_NO_BROWSER_INSTALL','1','Machine')`}</Code>
      <p>…then <b>reboot</b>. (Run PowerShell <b>as Administrator</b> — a machine env var needs elevation.)</p>
      <p className="note">
        Fixed properly in <b>runner 1.41.0</b>: the install now runs in the <b>background</b>, so the runner heartbeats
        immediately and simply advertises <code>browser</code> later, once the install finishes. New installs set this
        variable automatically for client-network agents.
      </p>

      <h2>3. Agent can&rsquo;t reach the app</h2>
      <Sym>Symptom: Troubleshoot prints “cannot reach &lt;app&gt;”.</Sym>
      <p>
        Nothing else matters until this passes. Two common causes:
      </p>
      <ul>
        <li>
          <b>The dev server is bound to localhost.</b> <code>npm run dev</code> listens on 127.0.0.1 only — agents on
          other machines can&rsquo;t see it. Use <code>npm run dev:lan</code> (binds <code>0.0.0.0</code>) so the LAN
          address in the agent&rsquo;s <code>-AppUrl</code> resolves.
        </li>
        <li>
          <b>Firewall / VPN / wrong URL.</b> The agent&rsquo;s <code>-AppUrl</code> is baked in at install time. Check it
          in the Scheduled Task&rsquo;s arguments; re-run the installer to change it.
        </li>
      </ul>

      <h2>4. Stale install link</h2>
      <Sym>Symptom: the installer errors immediately, or you get an odd PowerShell parse error.</Sym>
      <p>
        Enroll tokens <b>expire</b>. A stale link serves a one-line error script instead of the installer. Always copy a{" "}
        <b>fresh</b> install command from the Agents page rather than reusing an old one, and run it in{" "}
        <b>PowerShell</b> (not CMD), <b>as Administrator</b>.
      </p>

      <h2>Fast triage</h2>
      <table style={{ marginTop: "0.5rem" }}>
        <thead>
          <tr><th>What you see</th><th>Almost certainly</th><th>Do this</th></tr>
        </thead>
        <tbody>
          <tr><td>401 / “rejected the token”</td><td>Token missing or mismatched on the host</td><td>Re-run the install command, then <b>reboot</b></td></tr>
          <tr><td>Checks in once, then silent; “updating…”</td><td>Browser sidecar blocking startup</td><td>Set <code>IAM_RUNNER_NO_BROWSER_INSTALL=1</code>, <b>reboot</b></td></tr>
          <tr><td>“cannot reach the app”</td><td><code>npm run dev</code> (localhost-only) or firewall</td><td>Use <code>dev:lan</code>; check <code>-AppUrl</code></td></tr>
          <tr><td>“pre-build runner”</td><td>Never reported a build (old/never started)</td><td>Update it; if it persists, Troubleshoot</td></tr>
          <tr><td>Env var set but nothing changed</td><td>SYSTEM task cached the old environment</td><td><b>Reboot</b> — a task restart is not enough</td></tr>
        </tbody>
      </table>

      <h2>The Troubleshoot command</h2>
      <p>
        Every agent row has one (Actions → <b>Troubleshoot</b>). Run it <b>on the runner host</b>, in PowerShell, as
        Administrator. It checks PowerShell 7, the runner files, the Scheduled Task, the running process, the token,
        reachability and auth — then prints a verdict, <b>offers to disable the browser install</b> if that&rsquo;s the
        problem, and <b>offers to reboot</b>. It can also run the runner in the foreground so you can watch it live.
      </p>
      <p className="note">
        It contains no secrets by design (it&rsquo;s served unauthenticated so a broken host can always fetch it), which
        is why token problems send you back to the installer.
      </p>
    </main>
  );
}
