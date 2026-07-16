import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "ad-dc-optional",
  date: "2026-07-15",
  time: "10:15",
  title: "Active Directory no longer needs the ad-dc credential to run - a domain-controller agent signs in as itself",
  items: [
    "Marking the ad-dc credential 'not needed' used to break Active Directory - it forced AD to a manual step, or (with a half-cleared credential) failed the case at 'brokering credentials' before the agent ever ran. Brock Built's onboard (UM0029763) was stuck on exactly this",
    "ad-dc is now OPTIONAL. On a domain controller - where the agent almost always runs - the runner authenticates as its own built-in SYSTEM identity (which IS the directory's full-control account) and needs no stored credential at all. So an unset, not-needed, or missing ad-dc is a non-event now, not a failure",
    "When a client HAS wired ad-dc (an agent on a member server, not a DC, that genuinely needs a domain login) it's still attached and used - so those clients are unaffected. The only behaviour change: a member-server agent that skips ad-dc now fails at run time with a clear 'this isn't a domain controller - wire ad-dc' message instead of being blocked earlier as a manual step",
    "The client page stops showing a false 'ad-dc credential not set' / 'AD not ready' for domain-controller clients - ad-dc reads as an optional credential, like the Spanning portal login",
    "We reused the existing optional-credential mechanism rather than adding a new 'required' switch to every credential - one small list entry instead of a schema change and a new toggle",
    "To pick this up on an existing case, re-plan it (the AD steps then drop ad-dc and become runnable); agents need runner 1.60.0",
  ],
};
