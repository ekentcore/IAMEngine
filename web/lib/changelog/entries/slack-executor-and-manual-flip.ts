import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "slack-executor-and-manual-flip",
  date: "2026-07-14",
  time: "10:15",
  title: "Slack is automated, and 27 steps that were silently doing nothing are now real checklist items",
  items: [
    "Slack now runs for real (13 clients): onboard invites the member, offboard DEACTIVATES them - which in Slack switches the account off and keeps their messages and files, rather than erasing the person. It matches on email (handles collide and get renamed), and it reactivates a returning employee's existing account instead of creating them a second identity",
    "27 steps across 5 systems (sharepoint 10, mdm 7, printix 5, archive 3, notion 2) were marked as automated but had NO credential and NO configured behaviour - so every case dispatched a job that came back 'skipped: no executor' and the step read as HANDLED on the run report when in truth nobody had done it. They are now manual checklist items an operator actually ticks off",
    "Only rows with no credential were flipped: if someone had wired a secret, that system was left alone rather than silently downgraded mid-setup",
    "Slack's SCIM API needs a Business+ or Enterprise Grid plan - on Pro or Free it 404s no matter how good the token is. The connection test names that explicitly instead of blaming the credential, so nobody spends an afternoon rotating a token that was fine",
    "Not done, and why: Salesforce, Jira and HubSpot have finished modules but NO client uses them - the only 'Salesforce' in any runbook is an AD group name and a job title. Wiring them would have meant inventing client configuration nobody asked for. Say the word if a client actually uses one",
  ],
};
