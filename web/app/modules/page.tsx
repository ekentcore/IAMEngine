// Modules tab: every system the platform knows about, whether its runner executor is built, and a
// link to its operator instructions — so a missing guide (or a not-yet-built executor) is obvious
// at a glance. Data: lib/modules/catalog.ts joined with live per-system client usage.
import { db } from "@/lib/db";
import { MODULES, helpHref, needsInstructions, type ModuleEntry } from "@/lib/modules/catalog";

export const metadata = { title: "Modules" };
export const dynamic = "force-dynamic";

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

  const built = MODULES.filter((m) => m.executor === "built");
  const guides = built.filter((m) => m.helpSlug).length;
  const gaps = MODULES.filter(needsInstructions); // built but no in-app guide
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
                  const href = helpHref(m);
                  return (
                    <tr key={m.key}>
                      <td>{m.name} <span className="note">({m.key})</span></td>
                      <td><ExecutorBadge e={m.executor} /></td>
                      <td className="muted">{m.secret ?? "—"}</td>
                      <td>
                        {href ? (
                          <a href={href} target="_blank" rel="noreferrer">setup guide ↗</a>
                        ) : needsInstructions(m) ? (
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
