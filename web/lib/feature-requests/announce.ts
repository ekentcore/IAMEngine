// Composing the chat message for a feature request's "Send to chat" flow. Pure (no I/O) so the exact
// wording is unit-testable and the route stays a thin wrapper — mirrors the change-log send, where the
// server owns the message and the client only picks the audience + an optional comment.
//
// messageText() (lib/notifications/sender) renders `title` first, then `detail`, so the request number
// and title lead, and the operator's comment, the request text, and the resolution note follow as
// blank-line-separated sections. Empty pieces are dropped so there are never dangling separators.
import { frNumber } from "./visibility";

export type FrAnnounceInput = {
  number: number;
  title: string;
  body?: string | null;
  resolutionNote?: string | null;
};

export function frAnnouncement(fr: FrAnnounceInput, comment?: string | null): { title: string; detail: string } {
  const c = (comment ?? "").trim();
  const body = (fr.body ?? "").trim();
  const note = (fr.resolutionNote ?? "").trim();

  // number + title lead the message (frNumber renders 24 -> "#0000024").
  const title = `Feature request ${frNumber(fr.number)}: ${fr.title}`;

  const sections: string[] = [];
  if (c) sections.push(c); // the operator's own note, above the request itself
  if (body) sections.push(body); // the requested item, verbatim as filed
  if (note) sections.push(`Resolution: ${note}`);

  return { title, detail: sections.join("\n\n") };
}
