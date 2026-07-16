import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-target-picker",
  date: "2026-07-14",
  time: "15:15",
  title: "When we can't tell WHICH Parth Shah to offboard, we now ask you instead of guessing (or quietly doing nothing)",
  items: [
    "Until now, if the name on the ticket matched two people the step said 'ok' and did nothing, and if it matched nobody it said 'user not found - nothing to offboard'. Both went GREEN. A case could reach 'completed' with the leaver's account still live and signed in",
    "Now the step stops, the case is held, and the run report shows you the actual people it found - name, email, job title, department, and whether the account is still enabled - so you pick the right one. Nothing is touched until you do",
    "It handles the misspelling case too, which is the common one: ServiceNow says 'Parth Shah', the directory says 'Parth K. Shah', and an exact search finds nobody. Rather than give up, the module searches again on each part of the name and offers you the near-matches. There's also a box to type a UPN by hand if the person isn't in the list",
    "Your pick is saved on the CASE, not the step - every system resolves the leaver from the same place - so one choice unblocks 365, Exchange, AD, Slack, Duo and the rest at once. The whole case then re-runs from the top, so a step that already quietly no-op'd against the unknown user gets done properly",
    "Deliberate: a single near-match still asks. Auto-picking a fuzzy match is exactly how you offboard the wrong person, and that one doesn't undo. An EXACT single match still runs straight through, so nothing slows down on the normal path",
    "Who picked whom is audited (case.offboard_target.select) - choosing who gets locked out is a decision that deserves a name against it",
  ],
};
