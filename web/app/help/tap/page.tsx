// In-app setup guide for the OPTIONAL Temporary Access Pass (TAP) onboarding step. Only relevant when
// a client's plan includes the `tap` system. Linked from the Health page + the M365 cloud-auth guide.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Temporary Access Pass (TAP) setup" };

export default function TapSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link> · <Link href="/help/cloud-auth">M365 / Exchange cloud auth</Link></p>
      <h1>Temporary Access Pass (TAP) setup <span className="note">— optional</span></h1>
      <p className="note">
        Only needed for clients whose onboarding includes the <code>tap</code> step. TAP issues the new
        hire a <b>time-boxed passcode</b> (default: the <b>start date at 8:00 AM for 4 hours</b>) they use
        for their first Entra sign-in / passwordless registration. It runs through the <b>same M365 Graph
        app</b> as m365/entra (the <code>m365-admin</code> secret) — no separate credential.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Two prerequisites</b> — both are required, and a missing either shows as
        {" "}<code>accessDenied / Request Authorization failed</code> or &ldquo;not enabled&rdquo; on the step.
      </div>

      <h2>1. Grant the Graph permission</h2>
      <ol>
        <li>Entra admin center → <b>App registrations</b> → the app your <code>m365-admin</code> secret uses.</li>
        <li><b>API permissions</b> → <b>Add a permission</b> → Microsoft Graph → <b>Application permissions</b> → add
          {" "}<b><code>UserAuthenticationMethod.ReadWrite.All</code></b>.</li>
        <li>Click <b>Grant admin consent</b> for the tenant (the permission is inert until consented).</li>
      </ol>

      <h2>2. Enable TAP in the Authentication methods policy</h2>
      <ol>
        <li>Entra admin center → <b>Protection → Authentication methods → Temporary Access Pass</b>.</li>
        <li>Set it <b>Enabled</b> and <b>Target</b> the users/groups who&rsquo;ll be onboarded (All users, or a group).</li>
        <li>Defaults are fine; the step sets its own lifetime (240 min) per pass.</li>
      </ol>

      <h2>3. Turn the step on for the client</h2>
      <ul>
        <li>On the client page → <b>Edit systems</b> → add <b>Temporary Access Pass</b> (<code>tap</code>). It uses the
          {" "}<code>m365-admin</code> secret and runs last in the onboard lane.</li>
        <li>Optional config: <code>startHour</code> (default <code>8</code>) and <code>lifetimeMinutes</code>
          {" "}(default <code>240</code>) — e.g. set <code>startHour: 9, lifetimeMinutes: 480</code> for a 9am–5pm window.</li>
      </ul>

      <h2>Where the passcode shows</h2>
      <p className="note">
        When the step runs, the issued pass is shown on the <b>case&rsquo;s Run report</b>, on the <code>tap</code>
        {" "}step&rsquo;s log — a highlighted line like <code>TAP for user@domain: AB12-CD34 — activates …, valid 240
        min</code>. Copy it from there to hand to the new hire. It&rsquo;s short-lived and single-onboarding-use, and
        it activates at the configured start time (post-dated to the start day when that&rsquo;s in the future).
      </p>

      <h2>Verify</h2>
      <ul>
        <li>After granting the permission + enabling the policy, re-run the <code>tap</code> step (or re-plan the case).</li>
        <li>You can sanity-check the permission with a Graph call from the runner host&rsquo;s app context, or just
          watch the step succeed and show the pass.</li>
      </ul>
      <p className="note">
        No pass appears / <code>accessDenied</code>? It&rsquo;s almost always step 1 (permission not added or not
        consented). &ldquo;Not enabled for user&rdquo;? It&rsquo;s step 2 (policy off or not targeting the user).
      </p>
    </main>
  );
}
