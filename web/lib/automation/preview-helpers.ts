// Shared helpers for the per-system "intended automation" previewers. Pure string templating;
// no side effects. When a resolved `user` payload is supplied (a planned onboard/offboard case),
// the previews substitute the real values inline so the playbook shows exactly what will run.

export type PreviewUser = Record<string, unknown> | null | undefined;

// PowerShell string-array literal: @() when empty, else a multi-line @( "a", "b" ).
export function psArray(xs: string[] | undefined | null): string {
  return xs && xs.length ? "@(\n" + xs.map((x) => `    "${x}"`).join(",\n") + "\n  )" : "@()";
}

// Read a payload field (camelCase, as deriveIdentity/onboardPayload emit it). Returns the string
// form, or a `<UM case>` placeholder when the value is absent so the preview is still readable.
export function uval(user: PreviewUser, key: string, placeholder = "<UM case>"): string {
  if (!user) return placeholder;
  const v = (user as Record<string, unknown>)[key];
  if (v == null || v === "") return placeholder;
  return String(v);
}

// A string[] payload field (e.g. productLicenses, securityGroups). Empty array when absent.
export function ulist(user: PreviewUser, key: string): string[] | null {
  if (!user) return null;
  const v = (user as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.map(String) : null;
}

// The user's mailbox/UPN for offboard previews: derived UPN if present, else the work email, else
// the offboard intake's display name, else a placeholder.
export function resolveUpn(user: PreviewUser, placeholder = "<UM case: user to offboard>"): string {
  return uval(user, "userPrincipalName", uval(user, "workEmail", uval(user, "userToOffboard", placeholder)));
}
