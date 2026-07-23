// Placement + shape for a directory-sync section in a client's persisted runbook (RunbookSection).
//
// The "Add directory-sync" button adds a directory-sync ClientSystem row, which is enough for case
// planning to RUN the step (planning reads systems, not the runbook). But the runbook is a separate
// persisted table that drives the runbook editor + the documented step list, so the step was missing
// there. This module decides WHERE the directory-sync section goes and builds its row, so the add
// flow (and a backfill) can insert it non-destructively — existing sections keep their content
// (steps/artifacts/guess/kbArticle); only their seq shifts to make room.
import { systemTitle, configLines } from "./kb-render";

export const DIRECTORY_SYNC_KEY = "directory-sync";

// The minimal ordered-by-seq view of one action's sections the placement decision needs.
type SectionRef = { seq: number; systemKey: string | null };

export type DirectorySyncInsertPlan = {
  alreadyPresent: boolean; // a directory-sync section already exists in this action — do nothing
  insertSeq: number; // seq to give the new section
  shiftFromSeq: number | null; // bump existing rows with seq >= this by 1 first; null = no shift (append/empty)
};

// directory-sync runs after everything it depends on (Active Directory always; also Exchange for a
// hybrid-Exchange client that waits for the mailbox), so its runbook section belongs immediately
// AFTER the last of those dependency sections — keeping the documented order matching the executed
// order. `anchorKeys` is the system's effective per-lane dependencies (e.g. ["active-directory"], or
// ["exchange","active-directory"]); we anchor on the LAST-occurring matching section. Fallbacks when
// none of the deps have a section: after servicenow, else the front. `sections` MUST be ordered by
// seq ascending for one action.
export function planDirectorySyncSectionInsert(
  sections: SectionRef[],
  anchorKeys: string[] = ["active-directory"]
): DirectorySyncInsertPlan {
  if (sections.some((s) => s.systemKey === DIRECTORY_SYNC_KEY)) {
    return { alreadyPresent: true, insertSeq: 0, shiftFromSeq: null };
  }
  const anchorIdx = findAnchorIndex(sections, anchorKeys);
  if (anchorIdx === -1) {
    // No anchor section — place at the front, shifting everything (or seq 0 for an empty action).
    if (sections.length === 0) return { alreadyPresent: false, insertSeq: 0, shiftFromSeq: null };
    return { alreadyPresent: false, insertSeq: sections[0].seq, shiftFromSeq: sections[0].seq };
  }
  const next = sections[anchorIdx + 1];
  if (!next) {
    // Anchor is the last section: append after it, no shift.
    return { alreadyPresent: false, insertSeq: sections[anchorIdx].seq + 1, shiftFromSeq: null };
  }
  // Insert between the anchor and the next section: take next's seq and bump next + everything after.
  return { alreadyPresent: false, insertSeq: next.seq, shiftFromSeq: next.seq };
}

// Index of the section directory-sync should follow: the LAST section among its dependencies
// (so it lands after the latest one it waits on), else servicenow, else -1 (front of the action).
function findAnchorIndex(sections: SectionRef[], anchorKeys: string[]): number {
  const keys = new Set(anchorKeys);
  let last = -1;
  for (let i = 0; i < sections.length; i++) {
    const k = sections[i].systemKey;
    if (k && keys.has(k)) last = i;
  }
  if (last !== -1) return last;
  return sections.findIndex((s) => s.systemKey === "servicenow");
}

export type DirectorySyncSectionRow = {
  systemKey: typeof DIRECTORY_SYNC_KEY;
  title: string;
  status: "automated";
  steps: string[];
  kbArticle: string | null;
};

// Build the directory-sync RunbookSection body, mirroring sectionsFromSystems' format (title from the
// system catalog, an automated lead line, then the system's per-lane config as indented sub-steps).
export function directorySyncSectionRow(
  action: "onboard" | "offboard",
  config: unknown,
  kbArticle: string | null
): DirectorySyncSectionRow {
  const name = systemTitle(DIRECTORY_SYNC_KEY);
  const cfg = configLines(config, action);
  const lead = `${name}: automated — the runner performs the ${action} steps.`;
  return {
    systemKey: DIRECTORY_SYNC_KEY,
    title: name,
    status: "automated",
    steps: [lead, ...cfg.map((l) => `  ${l}`)],
    kbArticle,
  };
}
