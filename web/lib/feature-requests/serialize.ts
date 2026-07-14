// The one shape a feature request takes on the wire. The loader (page render) and the API routes
// (client re-render after a PATCH/hide) both go through this, so a row never changes shape when the
// admin edits it — `hidden` and `hideNote` are computed here rather than in the browser, where a
// client-side `new Date()` would drift from the server's and could hydrate a row into the wrong list.
import type { FeatureRequest } from "@prisma/client";
import { frHideNote, frIsHidden } from "./visibility";

export type FeatureRequestRow = {
  id: string;
  number: number;
  title: string;
  body: string;
  page: string;
  status: string;
  resolutionNote: string | null;
  authorEmail: string | null;
  createdAt: string; // ISO
  hideAt: string | null; // ISO — the moment it drops off the board
  hidden: boolean; // derived: hideAt <= now
  hideNote: string | null; // "Hides in 3 days" / "Hidden"
};

export function toFeatureRequestRow(r: FeatureRequest, now: Date = new Date()): FeatureRequestRow {
  return {
    id: r.id,
    number: r.number,
    title: r.title,
    body: r.body,
    page: r.page,
    status: r.status,
    resolutionNote: r.resolutionNote,
    authorEmail: r.authorEmail,
    createdAt: r.createdAt.toISOString(),
    hideAt: r.hideAt?.toISOString() ?? null,
    hidden: frIsHidden(r.hideAt, now),
    hideNote: frHideNote(r.hideAt, now),
  };
}
