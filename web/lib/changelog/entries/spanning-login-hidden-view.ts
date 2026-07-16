import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-login-hidden-view",
  date: "2026-07-16",
  time: "15:30",
  title: "Spanning force-sync: type the password into the box you can actually see (runner 1.66.4)",
  items: [
    "Force Spanning sync failed with 'login did not succeed (still on the login page)' even when the portal credentials were correct - and the give-away was in its own screenshot: the password sat typed in the box with no Microsoft error beside it, because the form was never submitted at all",
    "Microsoft's sign-in is a single page holding BOTH the username and password steps, with the one you are not on hidden away in the corner. The flow could still 'see' the hidden password box, so it decided that step was already up, skipped clicking 'Next', typed the password into the hidden box, and then spent its one click on 'Next' - landing on the password screen with the password pre-filled and nothing sent",
    "It now checks that a box is on the step actually being shown before typing into it, and waits for Microsoft to finish looking the account up instead of guessing at a fixed pause",
    "This also means the MFA prompt was never reached, so the one-time password from Delinea never got its turn - that path was fine all along and is now exercised",
    "The stand-in Microsoft portal the tests drive now mirrors the real page's two-steps-in-one-document shape. The old fake served them as separate pages, which is the exact gap this bug lived in",
  ],
};
