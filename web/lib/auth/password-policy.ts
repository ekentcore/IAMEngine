// Pure password-policy helpers with NO Node built-ins, so they're safe to import into client
// components (the crypto-backed generators live in ./password and re-export these). Used by the
// reset-password UI + route (FR #17) to validate an operator-supplied password before it's set.

// Human-readable statement of what a manually-entered reset/initial password must satisfy — shown in
// the UI next to the input and enforced by validateManualPassword. This is a BASELINE (Microsoft
// Entra's cloud policy: 8–256 chars, 3 of the 4 character categories) that catches the obvious
// rejects up front; the target system stays authoritative — a client's on-prem AD domain policy can
// be stricter (longer minimum, history, dictionary), so a value we accept can still be refused by the
// runner. A correcthorsebatterystaple-style passphrase passes easily once it carries a capital / digit
// / symbol (FR #17 — BayPine).
export const MANUAL_PASSWORD_HINT =
  "At least 8 characters (3 of: uppercase, lowercase, number, symbol). Your directory's policy may require more.";

// Validate an operator-supplied password (FR #17) against the Entra baseline. Returns null when it
// clears the baseline, else a short reason. NOT a guarantee the target accepts it (AD/Google policies
// vary) — it just rejects the clearly-doomed up front. Rejects leading/trailing whitespace (a
// copy-paste hazard that silently breaks sign-in) but allows internal spaces so passphrases work.
export function validateManualPassword(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length === 0) return "Enter a password.";
  if (pw !== pw.trim()) return "Remove leading/trailing spaces.";
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 256) return "Password must be 256 characters or fewer.";
  const categories = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (categories < 3) return "Use at least 3 of: uppercase, lowercase, number, symbol.";
  return null;
}
