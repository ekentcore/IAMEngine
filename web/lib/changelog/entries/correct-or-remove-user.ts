import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "correct-or-remove-user",
  date: "2026-09-23",
  time: "11:00",
  title: "Onboards: correct or remove the user the engine created (runner 1.138.0)",
  items: [
    "An onboarding case's Actions menu now has Correct user: fix a misspelled first/last/display name, or change the username and email, on every system the onboard set up (Active Directory, Microsoft 365, Exchange, Google). The old email is kept as an alias so mail to it still arrives. The case updates to match only once every system has taken the change; if one fails, the case keeps the old details and the correction can simply be run again",
    "Both act on the exact account the onboard created on each system - including a fallback username it used because the first choice belonged to someone else - identified by the system's own id where the onboard recorded one. An account that can't be proven to be this case's is left alone: Remove shows a warning naming it, Correct fails without changing it",
    "A new email also moves the mailbox's primary address in Exchange Online, including for clients whose mailbox comes from the Microsoft 365 licence (no separate Exchange step). If Exchange Online can't be reached for such a mailbox, the step warns that the address still needs changing by hand. On AD-standalone clients with their own AD domain, AD keeps that domain for the username, and its email address takes the new cloud email",
    "Remove user permanently deletes the account from every system the onboard set up - for a hire that fell through. The dialog lists the account on each system and you type it to confirm; it adds one step per system, each needs approval (the step names the account it will delete), and the user's groups are saved first. Re-running a remove needs a fresh approval",
    "Remove user is only offered for 30 days after the onboard; after that, offboard the user instead. Remove user refuses an account that existed before the case (a rehire or an adopted account) and says to offboard it instead. Correct user is no longer offered once a remove has actually deleted the account. Google keeps a deleted user restorable for 20 days (it can't be purged sooner); AD and Microsoft 365 deletes are permanent",
    "Users synced from AD are changed or removed in AD, and directory sync carries it to Microsoft 365. These steps only go to runners on 1.138.0 or later, and a correct or remove that needs AD is refused up front if the client's runner is older",
  ],
};
