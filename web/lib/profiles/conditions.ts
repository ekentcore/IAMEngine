// The condition grammar + token interpolation for v2.1 profiles, resolved at PLAN time against the
// case context (intake + selected persona + location + options). The runner never sees rules —
// only the planner's resolved decisions. See profiles/_schema.json $defs/condition + the root
// $comment for the token list. Pure, no I/O.

export type PlanContext = Record<string, unknown>;

// Dotted-path lookup: getPath(ctx, "country.short").
export function getPath(ctx: PlanContext, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ctx);
}

const stripQuotes = (s: string): string => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

const norm = (v: unknown): string => String(v ?? "").trim();

// Evaluate one term: "<var> <op> <value>". Ops: ==, !=, ~= (regex), `in [a, b, c]`.
function evalTerm(term: string, ctx: PlanContext): boolean {
  const t = term.trim();
  if (!t) return true;

  // `<var> in [a, b, c]`
  const inMatch = t.match(/^(.+?)\s+in\s+\[(.*)\]\s*$/i);
  if (inMatch) {
    const actual = norm(getPath(ctx, inMatch[1].trim())).toLowerCase();
    const list = inMatch[2].split(",").map((x) => stripQuotes(x).toLowerCase());
    return list.includes(actual);
  }

  const opMatch = t.match(/^(.+?)\s*(==|!=|~=)\s*(.+)$/);
  if (!opMatch) return false; // unparseable term → false (fail closed)
  const [, varPath, op, rawValue] = opMatch;
  const actualRaw = getPath(ctx, varPath.trim());
  const value = stripQuotes(rawValue);

  if (op === "~=") {
    try {
      // Bound the tested input: a long input string is what turns a catastrophic-backtracking
      // regex into an actual hang. Real fields (titles, names) are short, so 512 is ample.
      return new RegExp(value, "i").test(norm(actualRaw).slice(0, 512));
    } catch {
      return false;
    }
  }

  // boolean-aware, case-insensitive equality (mirrors PowerShell -eq)
  let equal: boolean;
  if (value === "true" || value === "false") {
    equal = Boolean(actualRaw) === (value === "true");
  } else {
    equal = norm(actualRaw).toLowerCase() === value.toLowerCase();
  }
  return op === "==" ? equal : !equal;
}

// Evaluate a full condition: <term> [(&& | ||) <term>]*, with && binding tighter than ||
// (so `a || b && c` is `a || (b && c)`). Empty/absent → always true.
export function evalCondition(expr: string | null | undefined, ctx: PlanContext): boolean {
  if (!expr || !expr.trim()) return true;
  // OR of ANDs: split by ||, each side is an AND-group.
  return expr.split("||").some((group) => group.split("&&").every((term) => evalTerm(term, ctx)));
}

// Computed tokens not stored on the context directly.
function computedToken(token: string, ctx: PlanContext): string | undefined {
  switch (token) {
    case "firstInitial": return norm(getPath(ctx, "first")).slice(0, 1) || undefined;
    case "lastInitial": return norm(getPath(ctx, "last")).slice(0, 1) || undefined;
    default: return undefined;
  }
}

// Replace {token} (incl. dotted, e.g. {location.name}) and the legacy <username> alias. An unknown
// token is left literal so a typo is visible rather than silently blanked.
export function interpolate(template: string, ctx: PlanContext): string {
  return template
    .replace(/<username>/g, () => norm(getPath(ctx, "username")))
    .replace(/\{([a-zA-Z][a-zA-Z0-9_.]*)\}/g, (whole, token: string) => {
      const computed = computedToken(token, ctx);
      if (computed !== undefined) return computed;
      const v = getPath(ctx, token);
      return v === undefined || v === null ? whole : String(v);
    });
}
