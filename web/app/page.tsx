// Dashboard entry point. The clients list lives at /clients.
import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>iam-engine</h1>
      <p>
        <Link href="/clients">Clients</Link> — view each client&apos;s systems and onboarding /
        offboarding runbook.
      </p>
    </main>
  );
}
