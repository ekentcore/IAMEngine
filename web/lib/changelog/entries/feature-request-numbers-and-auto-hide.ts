import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "feature-request-numbers-and-auto-hide",
  date: "2026-07-14",
  time: "09:15",
  title: "Feature requests get a ticket number, and implemented ones retire themselves after 7 days",
  items: [
    "Every feature request now has a number - #0000001, #0000002, and up - so you can quote one in a ticket or a chat instead of describing it. Existing requests were numbered oldest-first, so the numbers match the order they were actually filed",
    "Seven days after a request is marked Implemented it drops off the board on its own and lands in a collapsed Completed table at the bottom of the page. Nothing is deleted - it is still there, still numbered, just out of the way, so the board only shows what is still live",
    "Global and super admins get two controls: 'Hide now' retires an implemented or rejected request without waiting out the week, and 'Show 7 more days' pulls one back onto the board for another full week. That one can be clicked again each time the week runs out, so a request can be kept visible as long as it needs to be",
    "Reopening an implemented request (setting it back to Planned or Being scripted) cancels the timer and puts it straight back on the board",
    "A request being triaged now shows how long it has left - 'Hides in 5 days' - so nothing disappears as a surprise",
    "The hide is a deadline the page reads, not a background job that flips a flag. There is no cron in this app, and the heartbeat it fakes one with only ticks while a runner is beating - so a quiet fleet would have stalled the timer and left implemented requests on the board indefinitely. A deadline cannot stall",
  ],
};
