// The person a case is about, as a name — what the Cases list shows in its "User" column (FR #123).
// The ServiceNow subject ("Onboarding - Jane Doe - Acme") repeats the Action and client columns, so
// the list shows just the person and keeps the full subject in the tooltip.
//
// Name first (displayName, then first + last, then the offboard picker's text), falling back to the
// account identifiers only when no name was captured. null when the payload names nobody — the
// caller then falls back to the subject, so a row is never blank.
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function caseUserName(payload: Record<string, unknown> | null | undefined): string | null {
  const p = payload ?? {};
  const first = str(p.firstName);
  const last = str(p.lastName);
  return (
    str(p.displayName) ??
    ([first, last].filter(Boolean).join(" ") || null) ??
    str(p.userToOffboard) ??
    str(p.userPrincipalName) ??
    str(p.workEmail) ??
    str(p.email)
  );
}
