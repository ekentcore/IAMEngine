// Modules tab: every system the platform knows about, whether its runner executor is built, and a
// link to its operator instructions — so a missing guide (or a not-yet-built executor) is obvious
// at a glance. Data: lib/modules/catalog.ts joined with live per-system client usage, assembled
// by the shared _lib/loader.tsx (also feeds /modules/v2).
import { MODULES } from "@/lib/modules/catalog";
import { ExecutorBadge, GROUP_ORDER, loadModulesPage, slugFor } from "./_lib/loader";

export const metadata = { title: "Modules" };
export const dynamic = "force-dynamic";

export default async function ModulesPage() {
  const { namesBy, namesTitle, hasGuide, built, guides, gaps, planned } = await loadModulesPage();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Modules</h1>
          <p className="note">
        Setup guides for each system live under <a href="/help">Help</a>.{" "}
            {built.length} executors built · {guides} with a setup guide ·{" "}
            <strong>{gaps.length} built but missing instructions</strong> · {planned.length} not built yet
          </p>
        </div>
      </div>

      {gaps.length > 0 && (
        <p className="note" style={{ marginTop: ".5rem" }}>
          ⚠ Needs instructions written: {gaps.map((m) => m.key).join(", ")}
        </p>
      )}

      {GROUP_ORDER.map((group) => {
        const rows = MODULES.filter((m) => m.group === group);
        if (!rows.length) return null;
        return (
          <section key={group} style={{ marginTop: "1.25rem" }}>
            <h2>{group}</h2>
            <table>
              <thead>
                <tr>
                  <th>System</th>
                  <th>Executor</th>
                  <th>Secret</th>
                  <th>Instructions</th>
                  <th>Clients</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const guide = hasGuide(m);
                  return (
                    <tr key={m.key}>
                      <td>{m.name} <span className="note">({m.key})</span></td>
                      <td><ExecutorBadge e={m.executor} /></td>
                      <td className="muted">{m.secret ?? "—"}</td>
                      <td>
                        {guide ? (
                          <a href={`/help/${slugFor(m)}`} target="_blank" rel="noreferrer">setup guide ↗</a>
                        ) : m.executor === "built" ? (
                          <span className="badge archived">needs writing</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td
                        className="muted"
                        style={{ cursor: (namesBy.get(m.key)?.length ?? 0) ? "help" : "default" }}
                        title={namesTitle(m.key)}
                      >
                        {namesBy.get(m.key)?.length ?? 0}
                      </td>
                      <td className="note">{m.note ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </main>
  );
}
