import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "sharepoint-site-groups",
  date: "2026-09-23",
  time: "10:30",
  title: "SharePoint: site groups are cleaned up on offboard and mirrored on onboard (runner 1.137.0)",
  items: [
    "The SharePoint system now runs as a real step: on offboard it removes the leaver from every SharePoint site group they're in (a site's Owners, Members, Visitors and custom groups), on every site in the tenant",
    "On an onboard that says \"mirror <user>\", it adds the new user to the same site groups as the reference user. Groups on the client's mirror-policy \"never mirror\" list are skipped. A SharePoint step without its own list uses the Microsoft 365 one",
    "The new user is the account the Microsoft 365 step actually created. If that step had to use a fallback username because the first one belonged to someone else, the groups go to the fallback account, never the other person's. The SharePoint step always runs after the Microsoft 365 step. If the Microsoft 365 step hasn't finished, for example while it waits on a username decision, the SharePoint step stops and says it is waiting instead of guessing. If the automated Microsoft 365 step didn't report the account (its failure was accepted, it was marked complete by hand, or it was skipped), that step may have failed because the username belongs to someone else. So the step needs Username (userPrincipalName) to be set on the case after the Microsoft 365 step last ran, and it asks for that otherwise. If Microsoft 365 is a manual or SCIM step by design, the step uses the Username set on the case, or the only possible username when there is just one",
    "A reference user given by name must match exactly one person. If two people share the name, the step stops and asks for an email address instead of picking one",
    "An onboard with no mirror user finishes straight away without touching SharePoint",
    "Sites the person never used are skipped quickly. An offboard always reads the tenant's current list of sites, so a site created that morning is still cleaned up. An onboard reuses a list up to 6 hours old",
    "If SharePoint is throttling, the step waits and retries. If a site still can't be checked, the other sites are still done, then the step fails and lists the sites it couldn't finish. An offboard never reports success while the leaver might still have access somewhere. The run report shows progress as the step works through the sites",
    "A dry run writes the certificate to disk only once and deletes it afterwards. Before this, each site left its own copy behind",
    "The SharePoint work runs in a separate PowerShell process, never inside the runner, the same way the OneDrive hand-off does since runner 1.131.0. Loading SharePoint's module in the runner is what made Microsoft 365 steps hang and the runner restart. Progress still shows live on the run report, and a SharePoint process that stops responding is stopped after 7 minutes and reported, instead of the runner restarting",
    "It uses the client's existing Microsoft 365 app and certificate (the same Sites.FullControl.All access the OneDrive hand-off already needs)",
  ],
};
