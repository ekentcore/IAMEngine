// An unlinked credits page — the Konami toast is the breadcrumb that reveals it. Static text on
// purpose (no queries): it's a plaque, not a dashboard.
export const metadata = { title: "Credits" };

const line: React.CSSProperties = { margin: "0.2rem 0" };
const label: React.CSSProperties = { ...line, opacity: 0.6, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.12em", marginTop: "1.6rem" };

export default function CreditsPage() {
  return (
    <main style={{ maxWidth: 560, margin: "0 auto", padding: "4rem 1.5rem", textAlign: "center" }}>
      <p style={{ ...line, fontSize: 12, letterSpacing: "0.3em", opacity: 0.6 }}>IAM ENGINE PRESENTS</p>
      <h1 style={{ margin: "0.6rem 0 0" }}>The IAM lifecycle automation platform</h1>

      <p style={label}>Created by</p>
      <p style={{ ...line, fontSize: 20, fontWeight: 700 }}>Evan Kent</p>

      <p style={label}>Starring</p>
      <p style={line}>A web app (the brain) · a PowerShell runner fleet (the hands)</p>
      <p style={line}>and ~200 client orgs (the audience)</p>

      <p style={label}>By the numbers</p>
      <p style={line}>240+ pull requests · runner 1.0 → 1.96 · 254 client profiles distilled to data</p>

      <p style={label}>Built with</p>
      <p style={line}>Next.js · Prisma · PostgreSQL · PowerShell 7 · stubbornness</p>

      <p style={label}>In loving memory of</p>
      <p style={line}>every runbook that was a Word document</p>

      <p style={{ ...line, marginTop: "2.4rem", opacity: 0.7 }}>
        &ldquo;Every executor is idempotent.&rdquo;
      </p>
      <p style={{ ...line, marginTop: "1.6rem" }} aria-hidden>🥚</p>
    </main>
  );
}
