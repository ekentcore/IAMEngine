// Pure badge/label logic for a connection-preflight result — no JSX, so it's unit-testable
// under the node test runner (the .test.ts glob). The React components that draw these live
// in conn-test-badges.tsx and re-export everything here. Four stages: Fields (app-side: the
// secret reads + carries the fields its connector needs), Can access (the runner resolved the
// secret from Delinea), API works (connect + one live read), Rights (per-operation check).
import { summarizeRights, type RightsRow } from "@/lib/jobs/conn-test-logic";

// The result shape both surfaces consume (a subset of the /conn-test GET row).
export type ConnTest = {
  systemKey: string;
  status: "pending" | "running" | "ok" | "fail";
  detail: string | null;
  accessOk: boolean | null;
  accessDetail: string | null;
  fieldsOk: boolean | null;
  fieldsDetail: string | null;
  rights: RightsRow[] | null;
  credExpiresAt: string | null;
  onPrem: boolean;
  finishedAt: string | null;
};

export type BadgeText = { text: string; color: string };

// Stage 0 — app-side: the secret resolves and carries the fields its connector needs.
export function fieldsBadge(t: ConnTest): BadgeText {
  if (t.fieldsOk === true) return { text: "✓ fields ok", color: "#15803d" };
  if (t.fieldsOk === false) return { text: "✗ fields", color: "#b91c1c" };
  return { text: "—", color: "var(--muted)" }; // preflight not run (Delinea unconfigured / older row)
}
// Stage 1 — can the runner RESOLVE the secret from Delinea.
export function accessBadge(t: ConnTest): BadgeText {
  if (t.accessOk === true) return { text: "✓ resolved", color: "#15803d" };
  if (t.accessOk === false) return { text: "✗ no access", color: "#b91c1c" };
  if (t.status === "running") return { text: "testing…", color: "#92400e" };
  if (t.status === "pending") return { text: "queued", color: "var(--muted)" };
  return { text: "—", color: "var(--muted)" }; // older runner didn't report the stage
}
// Stage 2 — connect + one live read against the vendor API.
export function apiBadge(t: ConnTest): BadgeText {
  if (t.accessOk === false) return { text: "— skipped", color: "var(--muted)" };
  if (t.status === "ok") return { text: "✓ read ok", color: "#15803d" };
  if (t.status === "fail") return { text: "✗ failed", color: "#b91c1c" };
  if (t.status === "running") return { text: "testing…", color: "#92400e" };
  return { text: "queued", color: "var(--muted)" };
}
// Stage 3 — per-operation rights, where the probe can verify them. A missing OPTIONAL
// permission is appended as a muted note (e.g. "+1 optional"), never as its own failing
// badge. `surplus` is the reverse finding — permissions the credential holds that we never
// use; it rides beside the badge's own color (a green credential with too much authority is
// still green: it works — the surplus is the client's call). An escalation-risk surplus
// (e.g. could self-assign Global Admin) is called out with "(N risky)".
export function rightsBadge(t: ConnTest): BadgeText {
  const s = summarizeRights(t.rights);
  if (s.state === "unknown") return { text: "—", color: "var(--muted)" };
  const opt = s.optionalMissing > 0 ? ` +${s.optionalMissing} optional` : "";
  const extra =
    s.surplus > 0 ? ` · Extra Access: ${s.surplus}${s.escalation > 0 ? ` (${s.escalation} risky)` : ""}` : "";
  if (s.state === "verified") return { text: `✓ ${s.total}/${s.total} ops${opt}${extra}`, color: "#15803d" };
  if (s.state === "missing") return { text: `✗ missing ${s.missing}${opt}${extra}`, color: "#b91c1c" };
  return { text: `? ${s.unverified} unverified${opt}${extra}`, color: "#92400e" };
}

// The failing stage's detail (fields → access → live read), falling back to a status line.
export function stageDetail(t: ConnTest): string {
  const d = t.fieldsOk === false ? t.fieldsDetail : t.accessOk === false ? t.accessDetail : t.detail;
  return d ?? (t.status === "pending" ? "waiting for a runner to claim it…" : t.status === "running" ? "testing…" : "");
}

export function hasRights(t: ConnTest): boolean {
  return Boolean(t.rights && t.rights.length > 0);
}

export type { RightsRow };
