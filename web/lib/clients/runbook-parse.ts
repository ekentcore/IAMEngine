// Parse a pasted/typed runbook (plain text or light markdown) into ordered sections + steps, the
// same shape the KB importer produces — so a client with no ServiceNow KB (e.g. Coretelligent, whose
// process comes from an internal script) can still have a reviewable runbook. Pure + unit-tested.
import { headerToSystemKey } from "../generator/system-map";

export type ParsedSection = {
  seq: number;
  systemKey: string | null; // mapped from the header, else null (unmodeled section)
  title: string;
  status: "automated" | "unmodeled";
  steps: string[]; // nested items keep two-space indent per level
};

const STEP_RE = /^(\s*)(?:[-*•+]|\d+[.)]|>)\s+(.*\S)\s*$/; // bullet / numbered / quoted
const MD_HEADER_RE = /^#{1,6}\s+(.*\S)\s*$/;
const BOLD_HEADER_RE = /^\*\*(.+?)\*\*\s*:?\s*$/;

function stepText(line: string): { indent: number; text: string } | null {
  const m = STEP_RE.exec(line);
  if (!m) {
    // an indented continuation line (no bullet) is also a step
    if (/^\s{2,}\S/.test(line) && line.trim()) return { indent: Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2), text: line.trim() };
    return null;
  }
  return { indent: Math.floor(m[1].length / 2), text: m[2] };
}

// A header is markdown (#), bold (**…**), a short line ending with ":", or a short non-step line
// immediately followed by a step (so "Active Directory\n- create user" treats the first as a header).
function headerTitle(line: string, next: string | undefined): string | null {
  const t = line.trim();
  if (!t) return null;
  let m = MD_HEADER_RE.exec(t) ?? BOLD_HEADER_RE.exec(t);
  if (m) return m[1].replace(/:$/, "").trim();
  if (stepText(line)) return null; // it's a step, not a header
  const words = t.split(/\s+/).length;
  if (t.endsWith(":") && words <= 10) return t.replace(/:$/, "").trim();
  if (words <= 8 && next !== undefined && stepText(next)) return t; // bare title before a bullet
  return null;
}

// Guess whether a KB article is an onboarding or offboarding runbook, so the editor can auto-pick
// the right action and warn on an override (prevents saving an offboard KB as the onboard runbook).
// Title is the strongest signal; body keyword scoring is the tiebreak. Returns null when unsure —
// better to leave the operator's choice than to flip it on a weak guess.
export function detectKbAction(title: string, text: string): "onboard" | "offboard" | null {
  const t = (title ?? "").toLowerCase();
  if (/\boff[\s-]?board|offboarding|termination|deprovision/.test(t)) return "offboard";
  if (/\bon[\s-]?board|onboarding|new (user|hire|employee|starter)\b/.test(t)) return "onboard";

  const hay = `${title ?? ""}\n${text ?? ""}`.toLowerCase();
  const score = (pats: RegExp[]) => pats.reduce((n, p) => n + (hay.match(p)?.length ?? 0), 0);
  const on = score([/onboard/g, /new user/g, /new hire/g, /create (the )?(new )?user/g, /assign .{0,20}licens/g, /\bjoiner\b/g, /add user/g, /welcome/g]);
  const off = score([/offboard/g, /terminat/g, /disable .{0,20}(account|user|sign)/g, /remove .{0,20}from/g, /\brevoke\b/g, /\bdepart/g, /\bleaver\b/g, /deprovision/g, /hide .{0,10}gal/g, /convert .{0,20}shared/g]);

  const max = Math.max(on, off);
  if (max < 2 || Math.abs(on - off) < 2) return null; // too weak / too close — don't auto-switch
  return on > off ? "onboard" : "offboard";
}

export function parseRunbookText(text: string): ParsedSection[] {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections: ParsedSection[] = [];
  let cur: ParsedSection | null = null;
  const open = (title: string) => {
    const systemKey = headerToSystemKey(title);
    cur = { seq: sections.length, systemKey, title, status: systemKey ? "automated" : "unmodeled", steps: [] };
    sections.push(cur);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const title = headerTitle(line, lines.slice(i + 1).find((l) => l.trim() !== ""));
    if (title) { open(title); continue; }
    const step = stepText(line);
    const text = step ? "  ".repeat(step.indent) + step.text : line.trim(); // prose line → a step
    if (!cur) open("Overview"); // content before the first header
    cur!.steps.push(text);
  }
  // drop an empty trailing "Overview" with no steps (e.g. leading blank lines only)
  return sections.filter((s) => s.steps.length > 0 || s.title !== "Overview");
}
