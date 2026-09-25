// FR #0000175: the operator's answer to a DECISION_NEEDED:username_collision, as the config keys the
// runner reads. Adopt names the ACCOUNT the operator was shown (usernameCollisionAdoptUpn), not just
// "adopt": the M365 executor only adopts a same-name account on policy alone, so an account under a
// different display name ("Doe, Jane", a maiden name) was asked about again on every re-run, forever.
// 'new' clears any earlier confirmed account, so a changed mind can't leave one behind.
export type CollisionDecision = { usernameCollisionPolicy: "adopt" | "new"; usernameCollisionAdoptUpn: string | null };

export function collisionDecision(policy: unknown, adoptUpn: unknown): CollisionDecision | { error: string } | null {
  if (policy !== "adopt" && policy !== "new") return null;
  if (policy === "new") return { usernameCollisionPolicy: "new", usernameCollisionAdoptUpn: null };
  if (adoptUpn == null || adoptUpn === "") return { usernameCollisionPolicy: "adopt", usernameCollisionAdoptUpn: null };
  if (typeof adoptUpn !== "string" || !/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(adoptUpn.trim())) {
    return { error: "the account to adopt must be an email address" };
  }
  return { usernameCollisionPolicy: "adopt", usernameCollisionAdoptUpn: adoptUpn.trim() };
}

// Which jobs the answer goes on: every M365-executor job (m365 AND entra — the same handler), plus the
// step that actually asked. AD and Google ask the same question, and writing the answer only onto the
// M365 jobs left the asking step re-running without it, and asking again.
export function decisionTargets<J extends { id: string; systemKey: string }>(m365Jobs: J[], askingJob: J | null): J[] {
  return askingJob && !m365Jobs.some((j) => j.id === askingJob.id) ? [...m365Jobs, askingJob] : m365Jobs;
}
