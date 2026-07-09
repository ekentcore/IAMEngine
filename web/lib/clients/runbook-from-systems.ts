// Build a client's runbook FROM its modeled systems — for internal clients with no ServiceNow KB
// (e.g. Coretelligent, whose process lives in a script). One section per system that participates in
// the action (lane != never), in the stored order, with steps derived from the system's per-lane
// config. The operator can then reorder / add steps in the runbook editor. Mirrors what kb-render
// produces for the "KB article" tab, but as editable RunbookSection rows instead of pasteable text.
import type { ClientDetail } from "./types";
import type { ParsedSection } from "./runbook-parse";
import { systemTitle, configLines } from "./kb-render";

export function sectionsFromSystems(c: ClientDetail, action: "onboard" | "offboard"): ParsedSection[] {
  const participating = c.systems.filter((s) => (action === "onboard" ? s.onboardWhen : s.offboardWhen) !== "never");
  return participating.map((s, i) => {
    const cfg = configLines((s as { config?: unknown }).config, action);
    const name = systemTitle(s.systemKey);
    const lead = s.mode === "manual"
      ? `${name}: manual checklist step — perform the ${action} steps by hand.`
      : `${name}: automated — the runner performs the ${action} steps.`;
    return {
      seq: i,
      systemKey: s.systemKey,
      title: name,
      status: "automated", // it's a modeled system; the run report derives automated-vs-manual from the mode
      steps: [lead, ...cfg.map((l) => `  ${l}`)], // config lines as indented sub-steps
    };
  });
}
