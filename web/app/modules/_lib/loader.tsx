// Shared data assembly for /modules and /modules/v2: guide discovery, per-system client usage,
// group ordering, and the executor-status badge. Both pages are server components, so the loader
// can hand back plain functions (namesTitle/hasGuide) alongside the data.
import { readdirSync } from "fs";
import { join } from "path";
import { db } from "@/lib/db";
import { MODULES, type ModuleEntry } from "@/lib/modules/catalog";

export const GROUP_ORDER = [
  "Core / identity", "Email security", "Apps & access", "Security / endpoint",
  "Notifications", "Manual / hardware", "Backlog (no executor)",
] as const;

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
export const slugFor = (m: ModuleEntry) => m.helpSlug ?? m.key;

export function ExecutorBadge({ e }: { e: ModuleEntry["executor"] }) {
  const map = {
    built: { label: "built", cls: "modeled" },
    manual: { label: "manual", cls: "" },
    planned: { label: "not built", cls: "unmodeled" },
  } as const;
  const m = map[e];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

export async function loadModulesPage() {
  // Per-system client list (names), so the Clients count can show WHO on hover.
  const usage = await db.clientSystem.findMany({
    select: { systemKey: true, client: { select: { name: true } } },
    orderBy: { client: { name: "asc" } },
  });
  const namesBy = new Map<string, string[]>();
  for (const u of usage) {
    const arr = namesBy.get(u.systemKey) ?? [];
    arr.push(u.client.name);
    namesBy.set(u.systemKey, arr);
  }
  // Tooltip text: full list, capped so a 140-client system doesn't make an unreadable tooltip.
  const namesTitle = (key: string): string => {
    const names = namesBy.get(key) ?? [];
    if (!names.length) return "no clients use this module";
    return names.length > 40 ? `${names.slice(0, 40).join(", ")}, …+${names.length - 40} more` : names.join(", ");
  };

  const help = existingHelpSlugs();
  const hasGuide = (m: ModuleEntry) => help.has(slugFor(m));
  const built = MODULES.filter((m) => m.executor === "built");
  const guides = built.filter(hasGuide).length;
  const gaps = built.filter((m) => !hasGuide(m)); // built executor, no in-app guide yet
  const planned = MODULES.filter((m) => m.executor === "planned");

  return { namesBy, namesTitle, hasGuide, built, guides, gaps, planned };
}
