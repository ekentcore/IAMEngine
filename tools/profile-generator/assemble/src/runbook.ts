// Builds the per-client runbook: every section (modeled + unmodeled) in document order,
// each tagged with its automation status. Shared by the markdown packet and the
// <id>.runbook.json that seed loads into the DB.
import type { Action, IR } from "./ir.js";

export type RunbookStatus = "automated" | "manual" | "unmodeled";

export interface RunbookItem {
  action: Action;
  seq: number;
  systemKey: string | null; // null for not-yet-modeled sections
  title: string;
  status: RunbookStatus;
  guess: string | null;
  steps: string[];
  kbArticle: string | null; // the source ServiceNow KB number for this action
}

export function buildRunbook(ir: IR): RunbookItem[] {
  const kbFor = (action: Action): string | null =>
    (action === "onboarding" ? ir.kb.onboard : ir.kb.offboard) ?? null;
  const items: RunbookItem[] = [];
  for (const d of ir.detected) {
    items.push({
      action: d.action,
      seq: d.seq ?? 0,
      systemKey: d.systemKey,
      title: d.section,
      status: d.mode === "manual" ? "manual" : "automated",
      guess: null,
      steps: d.steps ?? [],
      kbArticle: kbFor(d.action),
    });
  }
  for (const u of ir.unmodeled) {
    items.push({
      action: u.action,
      seq: u.seq ?? 0,
      systemKey: null,
      title: u.section,
      status: "unmodeled",
      guess: u.guess ?? null,
      steps: u.steps ?? [],
      kbArticle: kbFor(u.action),
    });
  }
  return items.sort((a, b) =>
    a.action === b.action ? a.seq - b.seq : a.action === "onboarding" ? -1 : 1,
  );
}

// "<systemKey> — <title>" for a modeled section, "<title> (<guess>)" for an unmodeled one.
export function runbookTitle(item: Pick<RunbookItem, "systemKey" | "title" | "guess">): string {
  return item.systemKey ? `${item.systemKey} — ${item.title}` : item.guess ? `${item.title} (${item.guess})` : item.title;
}
