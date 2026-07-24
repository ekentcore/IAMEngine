import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "rules-editor-remove-system",
  date: "2026-07-24",
  time: "17:30",
  title: "Client rules: systems can be removed from a scope",
  items: [
    "Until now the Roles & rules editor could add a system to a scope but never take one out - every save PUT the whole rules object back, so a system added by mistake (even with no rules at all) was stuck in 'Every user' or a persona forever",
    "Each system in the selector row now shows a small x when the current scope actually holds rules (or an empty placeholder) for it - clicking removes that system's fragment from the scope; systems merely listed from the client's configured systems have nothing to remove and show no x",
    "Removing a system inside a persona behaves exactly like unchecking it in the 'systems this persona receives' checklist, so by-persona membership and rule fragments can't drift apart",
    "Nothing is pruned automatically on save: an empty {} fragment on a by-persona system still means membership - only the explicit x removes a key",
  ],
};
