import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "graph-signins-module-missing",
  date: "2026-07-14",
  time: "15:45",
  title: "Offboards were leaving the leaver's MFA registered, and warning about it on every single run",
  items: [
    "Every 365/Entra offboard warned \"could not read MFA methods ... the term 'Get-MgUserAuthenticationMethod' is not recognized\", which reads like a typo but is not: the Microsoft.Graph.Identity.SignIns module - the one that provides the MFA cmdlets - simply was not installed on the agent. The sign-in block, the session revoke and the group removal all worked; the leaver's second factors stayed registered",
    "Why it never fixed itself: the startup repair only ALIGNS the Graph submodules that are already installed, it never ADDS one that is missing. Agents enrolled before that module joined the installer's list therefore never got it, and never would have",
    "And the safety net could not catch it either. The runner has a self-heal that installs a missing module when a cmdlet is not found - but the 365 module caught its own error and turned it into a warning, so the self-heal never saw it. The one mechanism designed to fix this was the one thing guaranteed not to run",
    "The runner now installs any required Graph submodule that is missing at startup, pinned to the version of the others (mixing versions is what causes the 'assembly already loaded' crash). Let the agent self-update and restart, then re-run the 365 step and the second factors are removed for real",
    "The warning itself now names the actual cause and the fix, instead of quoting a raw PowerShell error at you",
  ],
};
