// Modules tab: every system the platform knows about, whether its runner executor is built, and a
// link to its operator instructions — so a missing guide (or a not-yet-built executor) is obvious
// at a glance. Data: lib/modules/catalog.ts joined with live per-system client usage.
import { readdirSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { MODULES, type ModuleEntry } from "@/lib/modules/catalog";

export const metadata = { title: "Modules" };
export const dynamic = "force-dynamic";

// Auto-discover which setup guides exist by scanning app/help/<slug>/ — so adding a guide page
// shows up here with no catalog edit. One cheap readdir per request (negligible). The catalog
// still owns the module LIST + executor status (the app can't introspect the runner's dispatch
// table) and the slug for the few pages whose name differs from the system key (cloud-auth, google).
function existingHelpSlugs(): Set<string> {
  try {
    return new Set(
      readdirSync(join(process.cwd(), "app", "help"), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
        .map((d) => d.name)
    );
  } catch {
    return new Set();
  }
}
const slugFor = (m: ModuleEntry) => m.helpSlug ?? m.key;

const GROUP_ORDER = [
  "Core / identity", "Email security", "Apps & access", "Security / endpoint",
  "Notifications", "Manual / hardware", "Backlog (no executor)",
] as const;

function ExecutorBadge({ e }: { e: ModuleEntry["executor"] }) {
  const map = {
    built: { label: "built", cls: "modeled" },
    manual: { label: "manual", cls: "" },
    planned: { label: "not built", cls: "unmodeled" },
  } as const;
  const m = map[e];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

export default async function ModulesPage() {
  const usage = await db.clientSystem.groupBy({ by: ["systemKey"], _count: { systemKey: true } });
  const countBy = new Map(usage.map((u) => [u.systemKey, u._count.systemKey]));

  const help = existingHelpSlugs();
  const hasGuide = (m: ModuleEntry) => help.has(slugFor(m));
  const built = MODULES.filter((m) => m.executor === "built");
  const guides = built.filter(hasGuide).length;
  const gaps = built.filter((m) => !hasGuide(m)); // built executor, no in-app guide yet
  const planned = MODULES.filter((m) => m.executor === "planned");

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Modules</h1>
          <p className="note">
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
                      <td className="muted">{countBy.get(m.key) ?? 0}</td>
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
