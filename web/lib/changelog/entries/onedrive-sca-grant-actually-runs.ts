import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "onedrive-sca-grant-actually-runs",
  date: "2026-09-17",
  time: "10:00",
  title: "The OneDrive delegate is made a site-collection admin again — the grant existed but had never once run",
  items: [
    "Offboarding is supposed to give the named delegate site-collection admin on the leaver's OneDrive, which is full access to everything on the site. That grant has been in the runner since July and had never run on any host that did not already have PnP.PowerShell installed — which is all of them (FR #0000116)",
    "The self-healing PnP install ran inside the runner process, where PowerShellGet refuses while PackageManagement is in use — the same failure that kept the Exchange pin from installing, fixed on 2026-09-15. The install now runs in a clean child process, exactly as the Exchange one does",
    "The skip was completely silent. What the case showed instead was the other OneDrive line — \"granted delegate X access to …'s OneDrive\" — which is a per-item invite on the drive root, not site access, and it reads green. That is why this looked like a delegation that works and does not deliver",
    "When the hand-off cannot run, the case now says so, names the person who did NOT get site access, and says what they do have instead",
    "Deploy runner 1.127.0, then re-run the OneDrive step on any offboard whose delegate still cannot reach the files",
    "Not changed here: the grant itself is still unvalidated against a live tenant (it was built against mocked PnP cmdlets in July and has never had the chance to run). Watch the first real offboard after this deploys before treating the request as closed",
  ],
};
