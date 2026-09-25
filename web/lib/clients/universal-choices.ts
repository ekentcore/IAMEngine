// A client's ServiceNow Universal Choices — the picklist entries on its onboarding form — mapped by
// hand to the Microsoft 365 / Google groups a hire who picks one should get. Before this, every cloud
// application needed its own persona/globals group rule (`when: cloudApplications contains "…"`);
// the mapping is one row per choice instead. Pure: planning, the sync and the editor route share it.

// The "Question" each choice is filed under in ServiceNow, and the intake payload field(s) its picks
// land in (lib/servicenow/intake-mapper.ts). A question with no field here can be mapped but never
// matches a case, so the editor says so.
export const QUESTION_FIELDS: Record<string, string[]> = {
  "Cloud Applications": ["cloudApplications"],
  "Generic Computer": ["otherHardware"],
  "Installed Software": ["installedSoftware"],
  "Shared Drives": ["fileShareAccess"],
  "Distribution Group": ["emailDistroGroups"],
  "Product License": ["productLicenses"],
  "Role": ["roles"],
  "Security Group": ["securityGroups"],
  "Shared Mailbox": ["sharedMailboxes"],
};
export const CHOICE_QUESTIONS = Object.keys(QUESTION_FIELDS);

// ServiceNow's spelling drifts ("Security Groups", "Role(s)", odd spacing); compare on a folded key.
const fold = (s: string): string => s.toLowerCase().replace(/\(s\)/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/s$/, "");
const QUESTION_BY_KEY = new Map(CHOICE_QUESTIONS.map((q) => [fold(q), q]));

// The canonical question a ServiceNow question text belongs to, or null for one we don't route.
export function canonicalQuestion(q: string): string | null {
  return QUESTION_BY_KEY.get(fold(q)) ?? null;
}

export type ChoiceMapping = {
  question: string;
  label: string;
  value: string;
  m365Groups: string[];
  googleGroups: string[];
};

export const hasGroups = (c: Pick<ChoiceMapping, "m365Groups" | "googleGroups">): boolean =>
  c.m365Groups.length > 0 || c.googleGroups.length > 0;

// The picks in one payload list field. Arrays as the intake stores them; a string (an operator edit)
// splits on ";" when it has one, else on "," (a name may contain a comma — FR #174).
function picks(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : ""))
    : typeof v === "string" ? v.split(v.includes(";") ? ";" : ",")
    : [];
  return list.map((x) => x.trim()).filter((x) => x !== "");
}

export type ChoiceMatch = {
  m365: string[];
  google: string[];
  // "field\u0000pick" (lower-cased) for every pick answered by a mapping WITH groups. The planner drops
  // those from its name-as-group handling of securityGroups / emailDistroGroups: the mapping replaces it.
  covered: Set<string>;
  matched: { question: string; label: string; pick: string }[];
};

export const coveredKey = (field: string, pick: string): string => `${field}\u0000${pick.trim().toLowerCase()}`;

// Match a case's picks against the client's choices. A pick matches a choice under the same question
// when it equals the choice's Label or Value (case-insensitive) — the intake carries display text,
// which is the Label, but a Value-only field would still resolve.
export function matchChoices(payload: Record<string, unknown>, choices: readonly ChoiceMapping[]): ChoiceMatch {
  const out: ChoiceMatch = { m365: [], google: [], covered: new Set(), matched: [] };
  const seenM = new Set<string>(); const seenG = new Set<string>();
  const add = (list: string[], seen: Set<string>, groups: string[]) => {
    for (const g of groups) { const t = g.trim(); const k = t.toLowerCase(); if (t && !seen.has(k)) { seen.add(k); list.push(t); } }
  };
  const byQuestion = new Map<string, ChoiceMapping[]>();
  for (const c of choices) {
    const q = canonicalQuestion(c.question);
    if (!q || !hasGroups(c)) continue;
    byQuestion.set(q, [...(byQuestion.get(q) ?? []), c]);
  }
  for (const [q, list] of byQuestion) {
    for (const field of QUESTION_FIELDS[q]) {
      for (const pick of picks(payload[field])) {
        const p = pick.toLowerCase();
        const hit = list.find((c) => c.label.trim().toLowerCase() === p || c.value.trim().toLowerCase() === p);
        if (!hit) continue;
        add(out.m365, seenM, hit.m365Groups);
        add(out.google, seenG, hit.googleGroups);
        out.covered.add(coveredKey(field, pick));
        out.matched.push({ question: q, label: hit.label, pick });
      }
    }
  }
  return out;
}

// Editor input -> a clean group list: trimmed, de-duplicated (case-insensitive), bounded. Accepts an
// array or one string split on newlines / ";" (group names can contain commas).
const MAX_GROUPS = 50;
const MAX_NAME = 256;
export function normalizeGroupList(v: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n;]/) : v == null ? [] : null;
  if (!raw) return { ok: false, error: "groups must be a list of names" };
  const out: string[] = []; const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") return { ok: false, error: "every group must be a name" };
    const t = x.trim();
    if (!t) continue;
    if (t.length > MAX_NAME) return { ok: false, error: `group name is too long (max ${MAX_NAME} characters)` };
    const k = t.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  if (out.length > MAX_GROUPS) return { ok: false, error: `too many groups on one choice (max ${MAX_GROUPS})` };
  return { ok: true, value: out };
}
