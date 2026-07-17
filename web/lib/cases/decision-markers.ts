// DECISION_NEEDED markers — the contract between a runner module and the run report's pickers.
//
// The format is a string convention, not a type: a module emits
//   DECISION_NEEDED:<kind> | <human message> | k=v | k=v
// and the report parses it back into buttons. Nothing binds the two sides — a typo'd marker doesn't
// fail, it just renders as an ordinary log line with no picker and waits for someone to notice. The
// parsers were also being written inline at each use site, so each new decision re-derived the format
// from a neighbouring regex.
//
// So: one parser, one place, with the runner's EXACT emitted strings pinned in decision-markers.test.ts.
// That test is the only thing standing between "the runner changed its wording" and "the button
// silently stopped appearing".

export type MailboxOversizeDecision = { message: string; sizeGB: string; thresholdGB: string };

const MAILBOX_OVERSIZE = /^DECISION_NEEDED:mailbox_oversize \| ([^|]+?) \| sizeGB=([^|]+?) \| thresholdGB=(.+)$/;

// The M365 offboard emits this on a step that SUCCEEDED — sign-in blocked, groups removed — where only
// the licence is unresolved, so it rides in the action lines rather than the error.
export function parseMailboxOversize(actions: string[]): MailboxOversizeDecision | null {
  for (const a of actions) {
    const m = MAILBOX_OVERSIZE.exec(a.trim());
    if (m) return { message: m[1].trim(), sizeGB: m[2].trim(), thresholdGB: m[3].trim() };
  }
  return null;
}

// The mailbox is UNDER the cap and nothing converted it — most often a client whose profile configures
// no conversion at all, where "convert it and re-run" is advice nobody can act on. Unlike the oversize
// decision, converting is a real answer here, so this carries the size the report needs to know whether
// to offer it: `sizeGB` is "unknown" when Exchange could not read it, and Exchange refuses to convert a
// mailbox it cannot prove is under the cap.
export type MailboxNotConvertedDecision = { message: string; sizeGB: string; thresholdGB: string };

const MAILBOX_NOT_CONVERTED = /^DECISION_NEEDED:mailbox_not_converted \| ([^|]+?) \| sizeGB=([^|]+?) \| thresholdGB=(.+)$/;

export function parseMailboxNotConverted(actions: string[]): MailboxNotConvertedDecision | null {
  for (const a of actions) {
    const m = MAILBOX_NOT_CONVERTED.exec(a.trim());
    if (m) return { message: m[1].trim(), sizeGB: m[2].trim(), thresholdGB: m[3].trim() };
  }
  return null;
}

// Can this mailbox actually be converted? Exchange refuses without a size it can prove is under the cap
// (Coretelligent.Exchange.psm1), so offering Convert on an unknown or over-cap size would be a button
// guaranteed to fail. Kept beside the parser so the rule lives with the fields it reads, not in the JSX.
export function canConvert(d: MailboxNotConvertedDecision): boolean {
  const size = Number(d.sizeGB);
  const threshold = Number(d.thresholdGB);
  if (!Number.isFinite(size) || !Number.isFinite(threshold)) return false; // "unknown" -> NaN -> no
  // A real 0.00 GB is a KNOWN size (the runner's not-injected sentinel is $null -> "unknown" -> NaN
  // above, never 0) — an empty mailbox is exactly the cheapest one to convert, so offer it.
  return size >= 0 && size <= threshold;
}

// Markers are for the pickers, not for people: every one is emitted alongside a human-readable line.
export const isDecisionMarker = (line: string): boolean => line.startsWith("DECISION_NEEDED:");

// A licence came off a mailbox that was never converted to shared — Exchange will PURGE it when the
// 30-day grace expires. The step lands verified-green by design (the outcome was DECIDED: a client
// opt-out or an operator's picker answer, and "decided ≠ unresolved"), but an irreversible purge
// clock starting must not be knowable only by opening the case — recordResult fires a chat
// notification off these lines. All three runner variants (operator oversize decision, operator
// not-converted decision, client allowWithoutConvert) start "license removed" and say DELETE.
export const isMailboxPurgeAction = (line: string): boolean => /^license removed\b.*\bDELETE\b/s.test(line);

const actionLines = (result: unknown): string[] => {
  const actions = (result as { Actions?: unknown; actions?: unknown } | null | undefined);
  const raw = actions?.Actions ?? actions?.actions;
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
};

/**
 * The mail-destroying action lines in a job result's Actions array — ONLY when a licence actually
 * came off in this run. The "license removed …" announcement is emitted when the runner ENTERS the
 * decided branch, before Set-MgUserLicense: a group-inherited rejection, an idempotent re-run with
 * the seat already gone, or an auto-retry attempt all re-emit it with nothing removed. The
 * "freed N directly-assigned license(s)" line is the actual-removal signal, so requiring both keeps
 * the purge alert to the one run that started the 30-day clock.
 */
export function mailboxPurgeLines(result: unknown): string[] {
  const lines = actionLines(result);
  if (!lines.some((a) => /^freed \d+ directly-assigned license/.test(a))) return [];
  return lines.filter(isMailboxPurgeAction);
}
