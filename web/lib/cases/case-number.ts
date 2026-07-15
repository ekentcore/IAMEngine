// The IAM case number an operator sees on a MANUAL case (one not sourced from a ServiceNow ticket,
// which already carries its own UM… number). Mirrors the feature-request numbering: a bare integer
// from a DB sequence, zero-padded to 7 digits at the point it becomes a number. Widens past 7 digits
// once it overflows rather than truncating into a collision. 1 -> "IAM0000001".
export function iamCaseNumber(n: number): string {
  return `IAM${String(n).padStart(7, "0")}`;
}

// A case number is "auto-assignable" (manual case, no ServiceNow number) when the caller supplied
// nothing usable. Whitespace-only counts as blank — an empty box in the New-case dialog must not
// win a slot away from a real number.
export function needsIamNumber(supplied: string | null | undefined): boolean {
  return !supplied || supplied.trim() === "";
}
