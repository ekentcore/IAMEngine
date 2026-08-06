// Composing the chat message for a change-log entry. Pure (no I/O) so the exact wording is
// unit-testable and every caller renders the SAME message — mirrors lib/feature-requests/announce.ts,
// which does this for a feature request.
//
// Two callers, and the reason this is shared rather than inlined: the operator's "Send to chat" button
// (POST /api/admin/changelog) and scripts/announce-merged.ts, which prs.sh runs after a merge. They
// post to the same customer channels, so a message that differed by route would be a message nobody
// could recognise. The composition lived only in the route until the script needed it.
//
// messageText() (lib/notifications/sender) renders `title` first, then `detail`, so the entry title
// leads and the operator's comment, the ship time, and the bullets follow.
import { formatChangelogWhen, type ChangelogEntry } from "./format";

export function changelogAnnouncement(entry: ChangelogEntry, comment?: string | null): { title: string; detail: string } {
  const c = (comment ?? "").trim();
  return {
    title: `iam-engine update — ${entry.title}`,
    detail: [
      ...(c ? [c, ""] : []), // the sender's own note, above the entry itself
      `Shipped: ${formatChangelogWhen(entry)}`,
      ...entry.items.map((it) => `• ${it}`),
    ].join("\n"),
  };
}
