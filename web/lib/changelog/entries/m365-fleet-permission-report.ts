import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-fleet-permission-report",
  date: "2026-07-17",
  time: "08:45",
  title: "The Microsoft 365 permission picture for every client — including the 63 that have no credential at all",
  items: [
    "New: `npx tsx scripts/report-m365-perms.ts` reports the Graph permission state of every client that has Microsoft 365, and `--send` posts it to the chat rooms. Sent to the team room today",
    "It covers a set the existing audit could not. audit-m365-graph-perms.ts walks the wired m365-admin credentials, which is the right target for 'who is missing a permission' and the wrong one for 'how is the fleet doing': a client with no credential never appears. That is 63 of the 139 clients with Microsoft 365 — so the report that read as a fleet summary was quietly omitting the worst-off half",
    "Today's picture: 139 clients have Microsoft 365. 31 credentials work, 45 are wired but cannot authenticate (39 of them are a Global Admin user account rather than an app registration, which the client-credentials flow can never accept), and 63 have no credential wired at all",
    "All 31 working credentials are missing User-PasswordProfile.ReadWrite.All — not one has it, because until yesterday nothing ever asked for it. 6 hold a role that can escalate their own authority",
    "The client-facing setup guide at /docs was still on v1.0 and listed none of the three permissions added yesterday. The seed file had them; /docs serves the database, and prisma/seed-docs.ts only creates a version when a document has none — so editing the file changed nothing a reader sees. Published as v1.1, and `scripts/publish-seed-doc.ts` now does that sync, refusing to overwrite a document an operator or an AI update has touched",
    "Zoom rejects a chat message over 4096 characters and nothing in the send path guarded it, so a fleet-sized report would simply never have arrived. It is now split into numbered parts, sent in order, and a section heading can no longer be stranded at the end of a message away from the rows it names",
  ],
};
