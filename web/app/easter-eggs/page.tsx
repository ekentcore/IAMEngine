import { redirect } from "next/navigation";
import { authEnabled, getActingContext } from "@/lib/auth/current-user";
import { canViewEggCatalog, LIVE_EGGS, IDEA_EGGS } from "@/lib/eggs/catalog";
import { EggCatalogGrid } from "./_components/egg-catalog-grid";

// The field guide to every easter egg — the one page that spoils them on purpose, so it is
// gated to the REAL super-admin (impersonation cannot grant it, same rule as the date simulator).
export const metadata = { title: "Easter eggs" };
export const dynamic = "force-dynamic";

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
        how to get out. Click any egg for a live demo (staged sample data; nothing real is touched).
        All eggs are cosmetic: no business logic, audit, or credential path is ever touched, and the
        date-driven ones can be previewed with the 📅 simulator in the header.
      </p>
      <p className="note" style={{ maxWidth: 640 }}>
        🔊 Some eggs now make sound — all of it synthesized in the browser (no audio files), quiet, and
        only ever started by something you did (a typed word or a click). To mute every egg on this
        machine, run <code>localStorage.setItem(&quot;egg-sounds&quot;, &quot;off&quot;)</code> in the console.
      </p>

      <h2 style={{ marginTop: "1.6rem" }}>Live in the app ({LIVE_EGGS.length})</h2>
      <EggCatalogGrid eggs={LIVE_EGGS} />

      {IDEA_EGGS.length > 0 && (
        <>
          <h2 style={{ marginTop: "2.2rem" }}>Ideas — not built yet ({IDEA_EGGS.length})</h2>
          <p className="note" style={{ maxWidth: 640 }}>
            The approved backlog. Triggers and homes are proposals; each follows the house rules — typed
            word outside inputs, zero dependencies, pure CSS, Esc to exit, portal-to-body for overlays.
          </p>
          <EggCatalogGrid eggs={IDEA_EGGS} />
        </>
      )}
    </main>
  );
}
