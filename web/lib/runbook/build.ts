// Turns a client's seeded ClientSystem rows into an ordered, numbered runbook
// per action — the "everything to do" list. Order comes from the data: the
// dependsOn topo-sort shared with the orchestrator (web/lib/orchestrator.ts),
// with the profile array order (ClientSystem.seq) as the stable tiebreak.
import type { Action, ClientSystem } from "@prisma/client";
import { depsOf, topoOrder } from "@/lib/orchestrator";
import type { ClientSystemWithCatalog, RunbookItem } from "@/lib/clients/types";

function laneWhen(s: ClientSystem, action: Action) {
  return action === "onboard" ? s.onboardWhen : s.offboardWhen;
}

export function buildRunbook(systems: ClientSystemWithCatalog[], action: Action): RunbookItem[] {
  const active = systems
    .filter((s) => laneWhen(s, action) !== "never")
    .sort((a, b) => a.seq - b.seq); // profile order = topo-sort tiebreak

  const byKey = new Map(active.map((s) => [s.systemKey, s]));
  const present = new Set(byKey.keys());

  return topoOrder(active, action).map((ordered, i) => {
    const s = byKey.get(ordered.systemKey)!; // recover the catalog-joined row
    const config = (s.config as Record<string, unknown> | null)?.[action] ?? null;
    return {
      seq: i,
      stepNumber: i + 1,
      systemKey: s.systemKey,
      systemName: s.system.name,
      mode: s.mode,
      automated: s.mode !== "manual",
      when: laneWhen(s, action) === "on_request" ? "on_request" : "always",
      dependsOn: depsOf(s, action, present),
      steps: summarize(config),
      codePreview: null,
    };
  });
}

// Render the lane config into human-readable lines. Friendly phrasing for the
// keys we see most; everything else is listed compactly so reviewers can act on
// it. (The authoritative human runbook is the linked KB article.)
function summarize(config: unknown): string[] {
  if (!config || typeof config !== "object") return [];
  const c = config as Record<string, unknown>;
  const lines: string[] = [];
  const seen = new Set<string>();
  const take = (key: string) => {
    seen.add(key);
    return c[key];
  };

  if (Array.isArray(c.licenses)) lines.push(`Assign ${c.licenses.length} license(s): ${(take("licenses") as unknown[]).join(", ")}`);
  if (Array.isArray(c.groups)) lines.push(`Add to group(s): ${(take("groups") as unknown[]).join(", ")}`);
  if (typeof c.note === "string") lines.push(take("note") as string);
  if (typeof c.ou === "string") lines.push(`OU: ${take("ou")}`);
  if (Array.isArray(c.steps)) for (const st of take("steps") as unknown[]) lines.push(String(st));

  for (const [key, value] of Object.entries(c)) {
    if (seen.has(key)) continue;
    lines.push(`${key}: ${describe(value)}`);
  }
  return lines;
}

function describe(value: unknown): string {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.map(describe).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${describe(v)}`)
      .join(", ");
  }
  return String(value);
}
