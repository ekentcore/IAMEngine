// Modules v3 (the "Version 3" slider serves this at /modules): same data as /modules via the shared
// _lib/loader.tsx, and the same ONE dense table for all groups as v2 — each group gets a sticky-ish
// separator row (pins under the app header while its rows scroll past), and the secret name folds
// into the System cell as a note. v3 chrome folds the whole table into a CollapsibleSection.
import { MODULES } from "@/lib/modules/catalog";
import { CollapsibleSection } from "../../_components/collapsible-section";
import { ExecutorBadge, GROUP_ORDER, loadModulesPage, slugFor } from "../_lib/loader";

export const metadata = { title: "Modules" };
export const dynamic = "force-dynamic";

// Mirrors the .data-table sticky-thead treatment (top = 56px app header) so the current group's
// label stays readable while scrolling; the next group's row pushes it away.
const groupCellStyle: React.CSSProperties = {
  position: "sticky", top: 56, zIndex: 1,
  background: "color-mix(in srgb, var(--bg) 86%, transparent)",
  backdropFilter: "blur(6px)",
  fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
  padding: "0.45rem 0.8rem",
};

export default async function ModulesV3Page() {
  const { namesBy, namesTitle, hasGuide, built } = await loadModulesPage();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Modules</h1>
          <p className="note">{MODULES.length} systems · {built.length} automated</p>
        </div>
      </div>

      <CollapsibleSection title="Systems" count={MODULES.length}>
        <table>
          <thead>
            <tr>
              <th>System</th>
              <th>Executor</th>
              <th>Instructions</th>
              <th>Clients</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {GROUP_ORDER.map((group) => {
              const rows = MODULES.filter((m) => m.group === group);
              if (!rows.length) return null;
              return [
                <tr key={group}>
                  <td colSpan={5} className="muted" style={groupCellStyle}>{group}</td>
                </tr>,
                ...rows.map((m) => {
                  const guide = hasGuide(m);
                  return (
                    <tr key={m.key}>
                      <td>
                        <div>{m.name} <span className="note">({m.key})</span></div>
                        {m.secret && <div className="note">{m.secret}</div>}
                      </td>
                      <td><ExecutorBadge e={m.executor} /></td>
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
                }),
              ];
            })}
          </tbody>
        </table>
      </CollapsibleSection>
    </main>
  );
}
