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
    const did = acts.length ? acts.join("; ")
      : st.verdict === "manual" ? "completed by hand"
        : st.verdict === "skipped" ? "not applicable"
          : st.verdict === "verified" ? "done" : st.verdict;
    out.push(`  ${RES_ICON[st.verdict] ?? "•"} ${st.systemName}: ${did}`);
  }
  // Follow-ups: failures, WARN actions, and missed validation checks worth a human's attention.
  const followups: string[] = [];
  for (const st of steps) {
    if (st.verdict === "failed" && st.error) followups.push(`${st.systemName}: ${st.error}`);
    for (const a of st.actions) if (/\bWARN\b/i.test(a)) followups.push(`${st.systemName}: ${a.replace(/^\s*WARN\s*/i, "")}`);
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
