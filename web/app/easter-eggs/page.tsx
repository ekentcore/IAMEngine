import { redirect } from "next/navigation";
import { authEnabled, getActingContext } from "@/lib/auth/current-user";
import { canViewEggCatalog, LIVE_EGGS, IDEA_EGGS, type CatalogEgg } from "@/lib/eggs/catalog";

// The field guide to every easter egg — the one page that spoils them on purpose, so it is
// gated to the REAL super-admin (impersonation cannot grant it, same rule as the date simulator).
export const metadata = { title: "Easter eggs" };
export const dynamic = "force-dynamic";

const label: React.CSSProperties = { fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--muted)" };

function EggCard({ egg }: { egg: CatalogEgg }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.9rem 1rem", background: "var(--bg-soft)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span aria-hidden style={{ fontSize: 18 }}>{egg.emoji}</span>
        <strong>{egg.name}</strong>
        <span style={{ ...label, marginLeft: "auto" }}>{egg.where}</span>
      </div>
      <p style={{ margin: "0.5rem 0 0", fontSize: 13 }}>
        <span style={label}>Trigger&nbsp;</span> {egg.trigger}
        {egg.exit && <span style={{ color: "var(--muted)" }}> · exits with {egg.exit}</span>}
      </p>
      <p style={{ margin: "0.4rem 0 0", fontSize: 13, color: "var(--muted)" }}>{egg.description}</p>
    </div>
  );
}

export default async function EasterEggsPage() {
  if (authEnabled()) {
    const acting = await getActingContext();
    if (!canViewEggCatalog(acting.realUser?.role)) redirect("/clients");
  }
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "1.5rem" }}>
      <h1>Easter eggs 🥚</h1>
      <p className="note" style={{ maxWidth: 640 }}>
        The complete field guide, super admins only — every hidden thing in the app, what fires it, and
        how to get out. All eggs are cosmetic: no business logic, audit, or credential path is ever
        touched, and the date-driven ones can be previewed with the 📅 simulator in the header.
      </p>

      <h2 style={{ marginTop: "1.6rem" }}>Live in the app ({LIVE_EGGS.length})</h2>
      <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
        {LIVE_EGGS.map((egg) => <EggCard key={egg.slug} egg={egg} />)}
      </div>

      {IDEA_EGGS.length > 0 && (
        <>
          <h2 style={{ marginTop: "2.2rem" }}>Ideas — not built yet ({IDEA_EGGS.length})</h2>
          <p className="note" style={{ maxWidth: 640 }}>
            The approved backlog. Triggers and homes are proposals; each follows the house rules — typed
            word outside inputs, zero dependencies, pure CSS, Esc to exit, portal-to-body for overlays.
          </p>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            {IDEA_EGGS.map((egg) => <EggCard key={egg.slug} egg={egg} />)}
          </div>
        </>
      )}
    </main>
  );
}
