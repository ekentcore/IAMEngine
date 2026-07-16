import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-revoke-mfa-and-sessions",
  date: "2026-07-13",
  time: "21:45",
  title: "Offboarding security: strip the leaver's MFA methods, sign them out of Google (runner 1.49.0)",
  items: [
    "M365 offboard now removes the leaver's registered second factors (phone, Authenticator, FIDO2, software OATH, Windows Hello) - previously they stayed on the account and went live again the moment anyone re-enabled it, and stayed usable for self-service password reset",
    "Which KINDS of factor were removed is recorded as case evidence (types only - a phone number is never stored)",
    "Google offboard now signs the user out everywhere, revoking their sessions and refresh tokens - suspending an account blocks new sign-ins but does NOT invalidate tokens already issued, so a departing user's phone could keep syncing mail",
    "Both need one extra permission (Entra: UserAuthenticationMethod.ReadWrite.All; Google: the admin.directory.user.security scope). Neither is required: a tenant that hasn't granted it keeps working, and the offboard warns in plain words that the factors or tokens are still live",
  ],
};
