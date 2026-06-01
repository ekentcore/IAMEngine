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
}

export function buildRunbook(ir: IR): RunbookItem[] {
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
    });
  }
  return items.sort((a, b) =>
    a.action === b.action ? a.seq - b.seq : a.action === "onboarding" ? -1 : 1,
  );
}
