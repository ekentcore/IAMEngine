// Structured <-> string bridge for the no-code rule editor. The condition GRAMMAR + evaluation live
// in conditions.ts (the source of truth); this module only parses a condition string into editable
// rows and serializes rows back to a string the evaluator accepts. Pure, used client + server.
//
// Model: ConditionModel = OR-groups of AND-terms, mirroring evalCondition's "split || then &&".
//   "a == 1 && b == 2 || c == 3"  <->  [[a==1, b==2], [c==3]]

export type TermOp = "==" | "!=" | "~=" | "in";
export type Term = { var: string; op: TermOp; value: string };
export type ConditionModel = Term[][]; // outer = OR, inner = AND

// `<var> in [a, b, c]` — capture var + the inside of the brackets (without the brackets).
const IN_RE = /^(.+?)\s+in\s+\[(.*)\]\s*$/i;
// `<var> (==|!=|~=) value`
const OP_RE = /^(.+?)\s*(==|!=|~=)\s*(.+)$/;

// Parse one trimmed, non-empty term into a Term, or null if it matches no operator.
function parseTerm(raw: string): Term | null {
  const t = raw.trim();
  if (!t) return null;
  const inM = t.match(IN_RE);
  if (inM) return { var: inM[1].trim(), op: "in", value: inM[2].trim() };
  const opM = t.match(OP_RE);
  if (opM) return { var: opM[1].trim(), op: opM[2] as TermOp, value: opM[3].trim() };
  return null;
}

// Parse a full condition into the editable model.
//  - empty/whitespace -> [[]] (a single empty AND-group: an "always" rule the builder can fill)
//  - any term unparseable -> null (the UI keeps the user in raw-text mode)
export function parseCondition(expr: string | null | undefined): ConditionModel | null {
  if (!expr || !expr.trim()) return [[]];
  const groups: ConditionModel = [];
  for (const orPart of expr.split("||")) {
    const terms: Term[] = [];
    for (const andPart of orPart.split("&&")) {
      if (!andPart.trim()) continue;
      const term = parseTerm(andPart);
      if (!term) return null;
      terms.push(term);
    }
    groups.push(terms);
  }
  return groups;
}

function termToString(t: Term): string {
  if (t.op === "in") return `${t.var.trim()} in [${t.value.trim()}]`;
  return `${t.var.trim()} ${t.op} ${t.value.trim()}`;
}

// Serialize the model back to a condition string. Drops empty terms/groups so a half-filled builder
// yields a clean expression (an all-empty model -> "" == always-true).
export function serializeCondition(model: ConditionModel): string {
  const groups = model
    .map((terms) => terms.filter((t) => t.var.trim() !== "").map(termToString).join(" && "))
    .filter((s) => s !== "");
  return groups.join(" || ");
}

// Validate a condition string: every non-empty term must match a recognized operator (the evaluator
// fail-closes unparseable terms to false, which would silently never fire — so we surface it).
export function validateCondition(expr: string | null | undefined): { ok: true } | { ok: false; error: string } {
  if (!expr || !expr.trim()) return { ok: true };
  for (const orPart of expr.split("||")) {
    for (const andPart of orPart.split("&&")) {
      if (!andPart.trim()) continue;
      if (!parseTerm(andPart)) return { ok: false, error: `Unrecognized condition: "${andPart.trim()}" — expected "<field> ==/!=/~= value" or "<field> in [a, b]"` };
    }
  }
  return { ok: true };
}
