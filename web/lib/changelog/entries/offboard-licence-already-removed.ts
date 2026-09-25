import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "offboard-licence-already-removed",
  date: "2026-09-25",
  time: "11:30",
  title: "The Entra offboard no longer fails at random on \"User does not have a corresponding license\" (runner 1.143.0, FR #177)",
  items: [
    "The offboard removes all of a user's licences in one request. When one of them had already come off a moment earlier - another step, or Microsoft's copy of the list lagging behind - Microsoft refused the whole request and the step failed. Retrying worked because by then the list was up to date",
    "Now, when that happens, the step removes the licences one at a time: the ones still assigned are freed on the same run, and the ones already gone are reported as already removed rather than as an error",
    "Any other refusal from Microsoft still fails the step as before, so a real problem is never hidden",
  ],
};
