import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "mfa-default-method-removed-last",
  date: "2026-07-16",
  time: "14:00",
  title: "Offboards now remove the leaver's default second factor too — it was being left registered on the account",
  items: [
    "An offboard strips the leaver's registered second factors, because they go live again the moment the account is re-enabled. But the one method the account uses BY DEFAULT was being left behind: \"could not remove the 'phone' auth method (STILL REGISTERED)\". Every other factor came off, so the account read as mostly cleaned while the default — usually the person's phone — stayed registered",
    "Microsoft won't delete the method an account defaults to while other methods exist; it has to be the last one standing. We were deleting them in the order Microsoft lists them, which puts the phone first — so the one method that had to go last was always tried first, and always lost",
    "The default is now removed last. We don't guess which one it is: whichever Microsoft refuses is set aside and retried once the others are gone, at which point it has nothing left to be the default over and comes off cleanly",
    "If Microsoft still refuses it, the warning now says so plainly and tells you to clear it in Entra by hand, rather than repeating an error that reads like a permissions problem. That can happen — an alternate mobile set as the default can reach a state no admin API can undo",
    "Not caused by the order of blocking sign-in vs removing factors, which was the natural suspicion. Blocking sign-in has no bearing on it — it was purely the order the factors themselves were deleted in",
  ],
};
