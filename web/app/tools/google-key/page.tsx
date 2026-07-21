// Standalone operator utility: convert a downloaded Google service-account JSON key into the exact
// values the `google-admin` Delinea secret needs (base64 for ClientSecret, the client_email for
// accountid). Everything runs in the browser — the file is read locally and NEVER uploaded — so an
// operator on a locked-down Windows machine with no terminal can still produce the base64 the vault
// wants. This is the manual companion to the auto-setup's in-form upload (CreateInDelineaForm) and
// its "field seeder" (lib/secrets/field-seeders.ts, which this page reuses verbatim).
import Link from "next/link";
import { GoogleKeyConverter } from "./_components/google-key-converter";

export const metadata = { title: "Google key converter" };

export default function GoogleKeyToolPage() {
  return (
    <main style={{ maxWidth: 760 }}>
      <p className="note"><Link href="/help/google">← Google Workspace setup</Link></p>
      <h1>Google key converter</h1>
      <p className="note" style={{ maxWidth: 640 }}>
        Turn a downloaded Google <b>service-account JSON key</b> into the fields the{" "}
        <code>google-admin</code> Delinea secret needs. The file is read <b>in your browser</b> and is{" "}
        <b>never uploaded</b> anywhere — this page just does the base64 conversion you&rsquo;d otherwise run in a
        terminal, then hands you each value to copy into Secret Server&rsquo;s <b>Automation - API</b> template.
      </p>
      <GoogleKeyConverter />
    </main>
  );
}
