import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "setup-run-cancel-button",
  date: "2026-07-21",
  time: "10:00",
  title: "Automatic setups can now be cancelled mid-run",
  items: [
    "The M365 and Google Workspace auto-setup modals gain a \"Cancel setup\" button while a run is live - before, the Close button was disabled and a wedged run held the modal (and the run slot) hostage until its multi-hour deadline",
    "Cancel stops the whole pipeline, not just the display: the run and its per-client rows flip to a terminal \"cancelled\" status, the in-flight browser job (device-code sign-in / OAuth sign-in / DWD grant) is stopped on the runner, and the setup core exits at its next step boundary instead of provisioning or writing to Delinea",
    "Everything held in memory for the run is cleared on both sides - the server releases the run's abort controller, and the modal drops its poll timer, step tracker, and run state before closing, so reopening starts from a clean form",
    "A run that finishes in the instant before the cancel lands keeps its real result - the cancel reports \"the run just finished\" rather than stamping \"cancelled\" over a success",
    "The fleet-wide M365 sweep gets the same \"Cancel run\" control on the fleet audit page; cancelling between clients stops the sweep before the next client starts",
  ],
};
