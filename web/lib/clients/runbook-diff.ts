// What actually changed in a runbook save. saveRunbook is destructive (it deletes every section for
// the action and recreates them), so without a diff the audit row can only say "someone re-saved the
// runbook" — useless when a step silently vanishes and a client's cases stop doing something. This
// compares the pre-save sections to the post-save ones and records the delta.
//
// Sections are matched by identity, not by position: a section's systemKey when it has one (the
// stable handle — a rename of the header shouldn't read as remove+add), else its normalized title.
// A pure reorder is reported as `reordered`, not as edits.
import type { ParsedSection } from "./runbook-parse";

export type SectionRef = {
  seq: number;
  systemKey: string | null;
  title: string;
  status: string;
  steps: string[];
};

export type StepDelta = { added: string[]; removed: string[] };

export type SectionChange = {
  key: string;
  title: string;
  systemKey: string | null;
  titleFrom?: string;
  titleTo?: string;
  statusFrom?: string;
  statusTo?: string;
  steps?: StepDelta & { countFrom: number; countTo: number };
};

export type RunbookDiff = {
  added: Array<{ key: string; title: string; systemKey: string | null; steps: number }>;
  removed: Array<{ key: string; title: string; systemKey: string | null; steps: number }>;
  changed: SectionChange[];
  reordered: Array<{ key: string; title: string; from: number; to: number }>;
  unchanged: number;
  /** True when nothing about the runbook's content moved — a no-op re-save. */
  noop: boolean;
};

// Cap what we put in the JSON detail column: a 400-step paste must not write a megabyte of audit.
const MAX_LISTED = 25;
const MAX_STEP_LEN = 300;

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const identity = (s: SectionRef): string => (s.systemKey ? `sys:${s.systemKey}` : `title:${norm(s.title)}`);
const clip = (s: string): string => (s.length > MAX_STEP_LEN ? `${s.slice(0, MAX_STEP_LEN)}…` : s);
const cap = <T,>(xs: T[]): T[] => xs.slice(0, MAX_LISTED);

// Multiset difference on normalized step text, returning the original (unnormalized) strings so the
// audit reads like the runbook. Duplicated identical steps are handled by count, not by set.
function stepDelta(before: string[], after: string[]): StepDelta {
  const counts = new Map<string, number>();
  for (const s of before) counts.set(norm(s), (counts.get(norm(s)) ?? 0) + 1);
  const added: string[] = [];
  for (const s of after) {
    const k = norm(s);
    const n = counts.get(k) ?? 0;
    if (n > 0) counts.set(k, n - 1);
    else added.push(clip(s));
  }
  // Whatever's left in `counts` was in `before` and not consumed by `after`. Emit exactly that many
  // copies — ["Reboot","Reboot"] → ["Reboot"] removed ONE, not both.
  const removed: string[] = [];
  for (const s of before) {
    const k = norm(s);
    const n = counts.get(k) ?? 0;
    if (n > 0) {
      counts.set(k, n - 1);
      removed.push(clip(s));
    }
  }
  return { added, removed };
}

// A runbook may name the same system twice ("M365 mailbox" and "M365 licences" both map to m365),
// so an identity is not unique on its own. Disambiguate repeats by their order of appearance, which
// pairs the first occurrence with the first, the second with the second. Without this the later
// section would overwrite the earlier one in the lookup and every save of an UNCHANGED runbook would
// report a phantom edit.
function keyed(sections: SectionRef[]): Array<{ key: string; s: SectionRef }> {
  const seen = new Map<string, number>();
  return sections.map((s) => {
    const base = identity(s);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: n === 0 ? base : `${base}#${n}`, s };
  });
}

export function diffRunbookSections(before: SectionRef[], after: SectionRef[]): RunbookDiff {
  const beforeKeyed = keyed(before);
  const afterKeyed = keyed(after);
  const beforeByKey = new Map(beforeKeyed.map((k) => [k.key, k.s]));
  const afterByKey = new Map(afterKeyed.map((k) => [k.key, k.s]));

  const added = afterKeyed
    .filter(({ key }) => !beforeByKey.has(key))
    .map(({ key, s }) => ({ key, title: s.title, systemKey: s.systemKey, steps: s.steps.length }));

  const removed = beforeKeyed
    .filter(({ key }) => !afterByKey.has(key))
    .map(({ key, s }) => ({ key, title: s.title, systemKey: s.systemKey, steps: s.steps.length }));

  // A save re-indexes every surviving section's seq to a dense 0..n-1, so deleting one section
  // shifts the seq of every section below it. Comparing raw seq would call all of them "reordered"
  // when the operator only deleted something above them. Order is therefore judged RELATIVE to the
  // other survivors: a section moved only if its position among the sections that exist on both
  // sides actually changed.
  const survivorPos = (list: Array<{ key: string; s: SectionRef }>, other: Map<string, SectionRef>) => {
    const pos = new Map<string, number>();
    list.filter(({ key }) => other.has(key)).forEach(({ key }, i) => pos.set(key, i));
    return pos;
  };
  const posBefore = survivorPos(beforeKeyed, afterByKey);
  const posAfter = survivorPos(afterKeyed, beforeByKey);

  const changed: SectionChange[] = [];
  const reordered: RunbookDiff["reordered"] = [];
  let unchanged = 0;

  for (const { key, s: a } of afterKeyed) {
    const b = beforeByKey.get(key);
    if (!b) continue; // counted in `added`

    const change: SectionChange = { key, title: a.title, systemKey: a.systemKey };
    let touched = false;

    if (norm(b.title) !== norm(a.title)) {
      change.titleFrom = b.title;
      change.titleTo = a.title;
      touched = true;
    }
    if (b.status !== a.status) {
      change.statusFrom = b.status;
      change.statusTo = a.status;
      touched = true;
    }
    const steps = stepDelta(b.steps, a.steps);
    if (steps.added.length || steps.removed.length) {
      change.steps = {
        added: cap(steps.added),
        removed: cap(steps.removed),
        countFrom: b.steps.length,
        countTo: a.steps.length,
      };
      touched = true;
    }

    if (touched) changed.push(change);
    else if (posBefore.get(key) !== posAfter.get(key)) reordered.push({ key, title: a.title, from: b.seq, to: a.seq });
    else unchanged++;
  }

  return {
    added: cap(added),
    removed: cap(removed),
    changed: cap(changed),
    reordered: cap(reordered),
    unchanged,
    noop: !added.length && !removed.length && !changed.length && !reordered.length,
  };
}

// One-line human summary for the audit list ("+2 sections, −1 section, 3 edited").
export function summarizeRunbookDiff(d: RunbookDiff): string {
  if (d.noop) return "no changes";
  const parts: string[] = [];
  if (d.added.length) parts.push(`+${d.added.length} section${d.added.length === 1 ? "" : "s"}`);
  if (d.removed.length) parts.push(`−${d.removed.length} section${d.removed.length === 1 ? "" : "s"}`);
  if (d.changed.length) parts.push(`${d.changed.length} edited`);
  if (d.reordered.length) parts.push(`${d.reordered.length} reordered`);
  return parts.join(", ");
}

export const toSectionRefs = (rows: Array<ParsedSection | SectionRef>): SectionRef[] =>
  rows.map((r) => ({
    seq: r.seq,
    systemKey: r.systemKey ?? null,
    title: r.title,
    status: String(r.status),
    steps: r.steps ?? [],
  }));
