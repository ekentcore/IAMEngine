// coreid → canonical-slug alias resolution. Most clients' slug already IS their lowercased CORE id
// (see sync-service.deriveSlug), but a handful were profile-seeded with a name slug (yuma, regal,
// six-one) BEFORE ServiceNow stamped their coreId — so /clients/<coreid> 404s for them. Since a CORE
// id is what operators paste out of a ticket, this lets /clients/<coreid> resolve for EVERY client
// by redirecting to the canonical name slug when the two differ.
//
// Called ONLY on the detail page's 404 path (the direct slug lookup missed first), so it costs
// nothing on a normal load. One-directional (coreid → name) by design — the name slug stays
// canonical, and aliasing both ways would invite redirect loops.
//
// Pure lookup (no auth import): the caller applies the client-scope gate, so an out-of-scope client
// can't be reached via its coreid alias.
import type { PrismaClient } from "@prisma/client";
import { normalizeCoreId } from "./core-id";

// Given a slug that did NOT resolve directly, find the client that owns that CORE id (if the segment
// is even CORE-id-shaped). Returns { id, canonicalSlug } so the caller can scope-check on id and
// redirect to canonicalSlug — or null when there's no alias to honour.
export async function findClientByCoreIdSlug(
  db: PrismaClient,
  requestedSlug: string,
): Promise<{ id: string; canonicalSlug: string } | null> {
  const coreId = normalizeCoreId(requestedSlug);
  if (!coreId) return null; // not a CORE-id-shaped segment — nothing to alias
  const client = await db.client.findUnique({
    where: { coreId }, // coreId is a case-sensitive unique column; normalizeCoreId yields the stored form
    select: { id: true, slug: true },
  });
  if (!client) return null;
  if (client.slug === requestedSlug) return null; // already canonical (shouldn't happen post-miss, but cheap)
  return { id: client.id, canonicalSlug: client.slug };
}
