// What the ad-consistency-check step is told about the Entra object, and — when there isn't one — WHY.
//
// The check compares the on-prem source anchor to the Entra object's immutableId. It has no cloud
// credential, so the app reads the anchor from the m365 step's result and injects it. When that read
// yielded nothing the check used to be handed a blank object, which it could not tell apart from "there
// is genuinely no cloud object yet" — so it reported the reassuring "a fresh sync will anchor it (ok)"
// line for a comparison it had never performed (FR #0000093). On UM0029901 the m365 step had FAILED, an
// operator accepted the failure so the case could proceed, the accepted failure satisfied this step's
// dependency, and the check passed a case it never looked at.
//
// The app knows the difference; the runner cannot. So `read` carries it, and `reason` carries the
// explanation the operator needs to act on.
export type CloudObject = {
  immutableId: string | null;
  syncEnabled: boolean | null;
  userId: string | null;
  read: boolean;
  reason?: string;
};

// The m365/entra job feeding the check: its status and its unwrapped result envelope.
export type M365Source = { status: string; envelope: unknown } | null;

export function cloudObjectFor(m365: M365Source): CloudObject {
  const blank = { immutableId: null, syncEnabled: null, userId: null };
  if (!m365) return { ...blank, read: false, reason: "the Microsoft 365 step did not run on this case" };
  if (m365.status !== "succeeded") {
    return { ...blank, read: false, reason: `the Microsoft 365 step ${m365.status} — its Entra object was never reported` };
  }
  const res = (m365.envelope ?? {}) as Record<string, unknown>;
  const pick = (a: string, b: string) => res[a] ?? res[b];
  const immutableIdRaw = pick("OnPremImmutableId", "onPremImmutableId");
  const syncEnabledRaw = pick("OnPremSyncEnabled", "onPremSyncEnabled");
  const userIdRaw = pick("UserId", "userId");
  // A result carrying NONE of the three keys never looked at Entra at all — a manually-completed step,
  // for instance, whose result is { priorStatus, manualCompletion }. Distinguish that from a step that
  // looked and found no user (the keys are present but null), which is a real, reportable finding.
  const hasAnyKey = ["OnPremImmutableId", "onPremImmutableId", "OnPremSyncEnabled", "onPremSyncEnabled", "UserId", "userId"]
    .some((k) => k in res);
  if (!hasAnyKey) {
    return { ...blank, read: false, reason: "the Microsoft 365 step reported no Entra object (it was completed by hand, or returned nothing)" };
  }
  return {
    immutableId: typeof immutableIdRaw === "string" ? immutableIdRaw : null,
    syncEnabled: typeof syncEnabledRaw === "boolean" ? syncEnabledRaw : null,
    userId: typeof userIdRaw === "string" ? userIdRaw : null,
    read: true,
  };
}
