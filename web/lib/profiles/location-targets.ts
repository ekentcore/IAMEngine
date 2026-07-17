// Split a location's flat targets into real groups vs printers, and apply an
// edited split back onto a location entry. Used by the UI/view-model (display
// split of un-migrated locations) and the set-location-targets API handler.

export function classifyLocationTargets(
  existingGroups: string[],
  discoveredNames: Iterable<string>,
): { groups: string[]; printers: string[] } {
  const discovered = new Set<string>();
  for (const n of discoveredNames) if (typeof n === "string" && n.trim()) discovered.add(n);
  if (discovered.size === 0) return { groups: [...existingGroups], printers: [] };
  const groups: string[] = [];
  const printers: string[] = [];
  for (const g of existingGroups) (discovered.has(g) ? groups : printers).push(g);
  return { groups, printers };
}

export function applyLocationTargets(
  entry: Record<string, unknown>,
  targets: { groups: string[]; printers: string[]; ou: string },
): Record<string, unknown> {
  const out = { ...entry };
  if (targets.groups.length) out.groups = targets.groups; else delete out.groups;
  if (targets.printers.length) out.printers = targets.printers; else delete out.printers;
  if (targets.ou) out.ou = targets.ou; else delete out.ou;
  return out;
}
