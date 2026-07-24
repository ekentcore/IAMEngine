// Show-once-per-new-items logic for the admin attention modal
// (docs/superpowers/specs/2026-07-24-admin-attention-modal-design.md).
//
// Pure: no DOM, no Prisma. The caller supplies the current high-water marks from the DB and the
// stored marks from localStorage; this decides whether anything is NEW. Identifiers, not counts:
// approve one request (3→2) then receive one (2→3) and a count comparison stays silent — the
// timestamp/number comparison pops.

export type AttentionData = {
  pendingRequests: number; // AccessRequest rows with status "pending"
  latestRequestAt: string | null; // ISO timestamp of the newest pending request (null when none)
  newFeatureRequests: number; // FeatureRequest rows with status "new" (untriaged only, by design)
  maxFrNumber: number; // highest "new" FR number (0 when none)
};

export type SeenMarks = { requestsAt: string | null; frMax: number };

export function attentionStorageKey(userId: string | null): string {
  // null = auth disabled (dev); every viewer is the same "local" admin there.
  return `admin_attention_seen:${userId ?? "local"}`;
}

// Corrupt/missing stored state counts as never-seen (null → show). Field-level salvage: a valid
// requestsAt next to a garbage frMax keeps the good half rather than re-popping both categories.
export function parseSeenMarks(raw: string | null): SeenMarks | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const requestsAt = (v as { requestsAt?: unknown }).requestsAt;
    const frMax = (v as { frMax?: unknown }).frMax;
    return {
      requestsAt: typeof requestsAt === "string" ? requestsAt : null,
      frMax: typeof frMax === "number" && Number.isFinite(frMax) ? frMax : 0,
    };
  } catch {
    return null;
  }
}

// Date.toISOString() output is fixed-width UTC, so plain string comparison orders correctly.
export function shouldShowAttention(data: AttentionData, stored: SeenMarks | null): boolean {
  const newRequests =
    data.pendingRequests > 0 &&
    data.latestRequestAt !== null &&
    (stored?.requestsAt == null || data.latestRequestAt > stored.requestsAt);
  const newFrs = data.newFeatureRequests > 0 && data.maxFrNumber > (stored?.frMax ?? 0);
  return newRequests || newFrs;
}

// Marks to store on dismissal. Keeps the prior mark when the current data is lower or gone (a
// category emptied out) — an already-seen item must never be able to re-trigger.
export function marksAfterDismiss(data: AttentionData, prior: SeenMarks | null): SeenMarks {
  const requestsAt =
    prior?.requestsAt != null && (data.latestRequestAt == null || prior.requestsAt > data.latestRequestAt)
      ? prior.requestsAt
      : data.latestRequestAt;
  return { requestsAt, frMax: Math.max(prior?.frMax ?? 0, data.maxFrNumber) };
}
