// A concise, ticket-ready resolution note for the ServiceNow work note (and the resolution preview
// modal) — the human summary of EVERYTHING this case did: each step + what it actually changed,
// which steps were done by hand, and any follow-ups worth flagging. Excludes the case-resolution
// step itself (it's the step that writes this). Plain text (SN work notes aren't markdown).
//
// Lives in its own file (type-only import of RunReport) so the CLIENT resolution modal can import it
// without pulling run-report.ts's server-only graph (outcomes-repo -> client-scope -> next/headers).
import type { RunReport, StepVerdict } from "./run-report";

const RES_ICON: Record<StepVerdict, string> = {
  verified: "✓", warning: "⚠", failed: "✗", skipped: "–", manual: "✋",
  needs_approval: "⏸", pending: "…", running: "▶", verifying: "🔎", retrying: "⟳",
};

// FR #0000046: the runner writes action strings for the RUN LOG, where the "why" earns its space —
// "distribution/mail-enabled 'X' — added by the Exchange step (Graph can't); not present yet" tells an
// engineer reading a failure exactly what happened. On the ticket it is noise: the requestor gets a
// wall of it and can't see what was actually done. So the note condenses; the run log and the audit
// row keep every character.
//
// Two rules, both narrow on purpose. Dropping whole action lines is deliberately NOT one of them — a
// missing line reads as "the engine didn't do it", which is worse than a long line.
//
//   1. Cut an explanatory tail at a TOP-LEVEL " — ". Top-level matters twice over: 'DrakeStar - USA'
//      is a hyphen (cutting there would rename a real distribution list), and the password step's
//      "(… NOT required — operator choice; …)" is a parenthetical whose em dash is content, not a tail.
//   2. Cut a raw API dump: when the tail past a ": " contains a URL it is a vendor error blob, not a
//      fact. "couldn't trigger directory sync: Mimecast API: POST https://… -> request failed"
//      becomes "couldn't trigger directory sync". An ordinary colon list ("set profile: OfficeLocation,
//      JobTitle") has no URL and is untouched.
//
// Never returns empty for a non-empty input — a line that is nothing but a tail keeps its original,
// because a blank bullet on a ticket is a lie about what ran.
export function condenseAction(action: string): string {
  const trimmed = action.trim();
  if (!trimmed) return "";

  // 1. top-level " — " (em dash), tracking parenthesis depth.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "—" && trimmed[i - 1] === " " && trimmed[i + 1] === " ") { cut = i; break; }
  }
  let out = cut > 0 ? trimmed.slice(0, cut).trim() : trimmed;

  // 2. The EARLIEST ": " whose remainder still carries a URL — everything from there on is the vendor
  // blob (its label included: "…: Mimecast API: POST https://… -> request failed" is all one dump).
  const url = /https?:\/\//;
  if (url.test(out)) {
    const first = out.indexOf(": ");
    if (first > 0 && url.test(out.slice(first + 2))) out = out.slice(0, first).trim();
  }

  return out || trimmed;
}

export function buildResolutionNote(rr: RunReport): string {
  const s = rr.summary;
  const out: string[] = [];
  out.push(`iam-engine ${rr.action} — ${rr.client.name}${rr.user ? ` — ${rr.user}` : ""}`.trim());
  if (rr.caseNumber) out.push(`Case ${rr.caseNumber} · status ${rr.caseStatus}`);
  out.push(`Summary: ${s.succeeded} verified, ${s.warnings} warning, ${s.failed} failed, ${s.skipped} skipped, ${s.manual} manual.`);
  out.push("");
  const steps = rr.steps.filter((st) => st.systemKey !== "case-resolution");
  out.push("Steps completed:");
  for (const st of steps) {
    const acts = st.actions.filter((a) => !/^\s*WARN\b/i.test(a)); // real actions; warnings go to follow-ups
    // Condense, then drop exact duplicates: two lines that differed only in their explanatory tail say
    // the same thing once trimmed, and a repeated bullet reads as the step having done it twice.
    const condensed: string[] = [];
    for (const a of acts) {
      const c = condenseAction(a);
      if (c && !condensed.includes(c)) condensed.push(c);
    }
    const fallback = st.verdict === "manual" ? "completed by hand"
      : st.verdict === "skipped" ? "not applicable"
        : st.verdict === "verified" ? "done" : st.verdict;
    // One action per line: the first rides the step line, the rest are indented beneath it, so the
    // step is still scannable as a single "what happened here" block.
    out.push(`  ${RES_ICON[st.verdict] ?? "•"} ${st.systemName}: ${condensed[0] ?? fallback}`);
    for (const c of condensed.slice(1)) out.push(`      ${c}`);
  }
  // Follow-ups: failures, WARN actions, and missed validation checks worth a human's attention.
  const followups: string[] = [];
  for (const st of steps) {
    if (st.verdict === "failed" && st.error) followups.push(`${st.systemName}: ${condenseAction(st.error)}`);
    for (const a of st.actions) if (/\bWARN\b/i.test(a)) followups.push(`${st.systemName}: ${condenseAction(a.replace(/^\s*WARN\s*/i, ""))}`);
    const missed = (st.validation?.checks ?? []).filter((c) => !c.pass).map((c) => c.name);
    if (missed.length && st.verdict !== "verified") followups.push(`${st.systemName}: validation missed — ${missed.join(", ")}`);
  }
  if (followups.length) {
    out.push("");
    out.push("Follow-ups / notes:");
    for (const f of followups) out.push(`  - ${f}`);
  }
  return out.join("\n");
}
