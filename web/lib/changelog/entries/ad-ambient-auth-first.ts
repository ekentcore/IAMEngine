import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-ambient-auth-first",
  date: "2026-07-14",
  time: "21:15",
  title: "AD onboarding was failing on the domain controller because we insisted on handing it a password it did not need",
  items: [
    "Brock Built's AD step (UM0029763) failed with 'Authentication failed on the remote side' and then 'the user has not been authenticated'. Neither is Active Directory rejecting the operation - both are the login itself being refused, before AD ever looked at what we were asking for",
    "The agent runs as SYSTEM on the domain controller, which IS the directory's own SYSTEM account - full control, over an encrypted Kerberos connection, needing no password at all. We were overriding that with the stored ad-dc credential, and Delinea's Active Directory template keeps the domain in a separate field, so the username we passed was a bare account name with no domain on it. A bare name cannot use Kerberos, so the connection drops to the old NTLM method, and a hardened DC refuses that outright. We were handing AD a worse identity than the one the process already had",
    "The runner now uses its own identity on a domain controller and keeps the stored credential only as a fallback for when the DC refuses it. Off a domain controller it still leads with the stored credential",
    "Two guard rails matter more than the fix itself. First: we only prefer our own identity where we KNOW it is privileged - running as SYSTEM, on a writable domain controller. A read test cannot establish that, because every account that can log in can read the directory; on a member server SYSTEM is just the machine account, which reads fine and cannot create a single user. Preferring it on a read test would have gone green and then failed access-denied halfway through a case",
    "Second: off a domain controller, a refused credential now FAILS LOUDLY instead of quietly falling back to the machine account. Falling back would turn 'your stored ad-dc password is stale' into a half-finished offboard that dies partway through - the worst possible way to find out",
    "When the stored credential IS used, a bare username now gets its domain attached from the secret's Domain field. We attach exactly one form and try it once: probing several variants of the same password would have counted as several failed logons every time, and ad-dc is a SHARED account on many clients (also used for on-prem Exchange), so a stale vault password would have walked it straight into a domain lockout",
    "If nothing authenticates, the error names both identities that were tried and what each was told, and distinguishes 'the DC is unreachable' from 'the credential is wrong' - instead of a bare 'authentication failed' that never said who we were even logging in as",
    "The AD connection test was auditing the wrong account: it always checked whether the ad-dc account could create users, even where the runner now signs in as SYSTEM and never touches that credential. It now checks the rights of whichever identity we actually authenticate as",
    "A green AD connection test was part of why this hid: it only ever proved we could READ the domain. Brock Built has no onboarding OU configured, so the test's 'can this account create users' check was skipped entirely and the test still went green",
  ],
};
