// When an operator last edited each case field (PR #111 review 4). payload.fieldSource says WHO set a
// field ("operator", "ai", ...); this says WHEN, in a sibling map with the same keys, so fieldSource
// keeps its shape (the review badge reads it) and no schema change is needed.
//
// The sharepoint mirror needs it: after an m365 step that did not report the account it created (its
// failure accepted, or done by hand), only a Username the operator set AFTER that step last ran can
// name the account. One set earlier may predate the step finding that username taken.
export function stampFieldEditedAt(payload: Record<string, unknown>, keys: string[], now: Date): void {
  if (keys.length === 0) return;
  const at = { ...((payload.fieldEditedAt ?? {}) as Record<string, string>) };
  for (const k of keys) at[k] = now.toISOString();
  payload.fieldEditedAt = at;
}
