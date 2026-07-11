// In-app setup guide: enable the Delinea (Secret Server) WRITE path so operators can author a
// credential in the app and have it created in the client's Delinea folder. Read-only brokering
// (resolving secrets for the runner) needs NONE of this — it's strictly additive. Linked from the
// client Secrets panel / guided setup when the "Create in Delinea…" button is disabled.
import Link from "next/link";
import { Code } from "../_components/code";

export const metadata = { title: "Create secrets in Delinea (write path)" };

export default function DelineaWriteSetupPage() {
  return (
    <main style={{ maxWidth: 820 }}>
      <p className="note"><Link href="/health">← Health</Link></p>
      <h1>Create secrets in Delinea (write path)</h1>
      <p className="note">
        By default the app only <b>reads</b> Delinea — it resolves a secret you&rsquo;ve wired by id and pushes the
        value to the runner at run time. Turning on the <b>write path</b> lets an operator type a credential&rsquo;s
        field values in the Secrets panel (or guided setup) and have the app <b>create the secret</b> in the
        client&rsquo;s Delinea folder, then wire the returned id automatically. The typed values are used once for the
        create call and are <b>never stored or logged</b> by the app — only the resulting secret id (a reference) is kept.
      </p>

      <div style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 6, padding: "0.7rem 0.9rem", margin: "0.8rem 0" }}>
        <b>Three things must be configured</b>
        <p style={{ margin: "0.4rem 0 0" }}>
          The <b>Create in Delinea…</b> button stays disabled until all three are present for the client + secret:
          a <b>write account</b>, the client&rsquo;s <b>folder id</b>, and a <b>template id</b> for that kind of secret.
          The button&rsquo;s tooltip (and the API&rsquo;s refusal) names exactly what&rsquo;s missing.
        </p>
      </div>

      <h2>1. A Delinea write account</h2>
      <p className="note">
        A Secret Server account with <b>Create Secret</b> permission on the target folder(s) and access to the
        secret templates you&rsquo;ll use. You can reuse the existing read account if it has those rights, or set a
        distinct one. Same base URL as reads.
      </p>
      <Code>{`# web/.env (or the repo-root env.env that env:sync writes from)
DELINEA_BASE_URL="https://coretelligent.secretservercloud.com"

# Reuse the read account (if it can Create), or set a distinct write account:
DELINEA_WRITE_USER="svc-iam-write"
DELINEA_WRITE_PASSWORD="..."
# If DELINEA_WRITE_USER/PASSWORD are unset, the app falls back to DELINEA_USER/PASSWORD.`}</Code>

      <h2>2. The client&rsquo;s folder id</h2>
      <p className="note">
        Where this client&rsquo;s secrets are created. Two ways — the per-client field wins:
      </p>
      <ul>
        <li><b>Per client (recommended):</b> set the client&rsquo;s <code>delineaFolderId</code>. The first time you
          create a secret for a client with no folder yet, the create form asks for the folder id and saves it onto
          the client, so you only enter it once.</li>
        <li><b>Bulk (env):</b> a JSON map keyed by client slug. Used only when the client has no folder of its own.</li>
      </ul>
      <Code>{`DELINEA_FOLDER_MAP='{"acme":142,"brighton-park":205}'`}</Code>

      <h2>3. A template id per secret name</h2>
      <p className="note">
        Secret Server template ids are <b>per-instance</b>, so they come from env. Map each secret name (the logical
        key the systems reference, e.g. <code>m365-admin</code>, <code>mimecast</code>, <code>spanning</code>) to its
        template id. The app already knows which <b>fields</b> each secret needs (from the field requirements) and maps
        your field labels to the template&rsquo;s field slugs; override a slug only if your template differs.
      </p>
      <Code>{`# Option A — one env var per secret (name uppercased, non-alnum -> _):
DELINEA_TEMPLATE_M365_ADMIN="6001"
DELINEA_TEMPLATE_MIMECAST="6002"
DELINEA_TEMPLATE_SPANNING="6003"

# Option B — one JSON map (bare id, or an object to also override field slugs):
DELINEA_TEMPLATE_MAP='{
  "m365-admin": 6001,
  "mimecast": { "templateId": 6002, "fieldMap": { "client secret": "api-secret" } }
}'`}</Code>

      <h2>How a create works</h2>
      <ol>
        <li>Operator opens <b>Create in Delinea…</b> next to a secret, fills the required fields (secret-ish fields are
          masked), and submits.</li>
        <li>The app validates the required fields are present, fetches the template <b>stub</b> to learn its field
          shape, drops the values in by slug, and <b>POSTs</b> a new secret to the client&rsquo;s folder.</li>
        <li>On success the app wires the returned secret id onto the client (same store as pasting an id) and records
          an audit entry — secret <b>name and field names only, never values</b>.</li>
      </ol>
      <p className="note">
        If any of the three prerequisites is missing, the create is refused with a clear message and nothing is
        written — the read-only flows are entirely unaffected.
      </p>
    </main>
  );
}
