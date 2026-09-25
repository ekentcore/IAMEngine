// Per-case offboard ACTION choices (FR #128): for one case, choose what actually happens to the account
// on the systems clients ask to vary — delete vs suspend in Google, delete vs convert the mailbox in
// Exchange, remove vs archive the Spanning licence. Stored in the payload as `offboardActions` through
// the case fields route (operator-sourced, so a ServiceNow re-pull keeps it) and applied to the planned
// offboard jobs here, AFTER the client's own config — the case's choice wins.
//
// Every "delete"/"remove" choice makes its step DESTRUCTIVE: approval-gated with an evidence snapshot,
// the same guarantees a client-level destructive system gets. The "keep" choices only undo a client
// default that would otherwise delete, and add no gate. A choice that restates what the client already
// does changes nothing at all, and a mailbox delete never turns licence removal ON — it only lets a
// step that already removes the licence do so without a convert.
import type { PlannedJob } from "../orchestrator";

export type OffboardActions = {
  "google-workspace"?: "suspend" | "delete";
  exchange?: "convert" | "delete";
  spanning?: "archive" | "remove";
};

export const OFFBOARD_ACTION_CHOICES = {
  "google-workspace": { keep: "suspend", destroy: "delete" },
  exchange: { keep: "convert", destroy: "delete" },
  spanning: { keep: "archive", destroy: "remove" },
} as const;

type SystemWithChoice = keyof typeof OFFBOARD_ACTION_CHOICES;

// Only known systems and known values survive — anything else in the payload is ignored.
export function readOffboardActions(payload: Record<string, unknown>): OffboardActions {
  const raw = payload.offboardActions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, choice] of Object.entries(OFFBOARD_ACTION_CHOICES)) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === choice.keep || v === choice.destroy) out[key] = v as string;
  }
  return out as OffboardActions;
}

const cfgOf = (j: PlannedJob) => ({ ...((j.config as Record<string, unknown> | null) ?? {}) });
const destructive = (j: PlannedJob, config: Record<string, unknown>): PlannedJob =>
  ({ ...j, config, intent: "destructive", requiresApproval: j.mode === "api" ? true : j.requiresApproval, captureEvidence: true });

// Does this config convert the mailbox to shared? The SAME reading as the Exchange executor
// (Coretelligent.Exchange: Get-CtgProp convertToShared, else mailbox.convertToShared, then
// Test-CtgConvertToShared). Nothing configured converts nothing; { value: false } and "no"/"off" say
// don't; an object with no `value` is a settings bag ({ skipIfMailboxOverGB }) whose presence opts in.
const FALSY_WORD = /^(false|no|off|0)$/i;
export function wantsConvertToShared(cfg: Record<string, unknown>): boolean {
  let cts = cfg.convertToShared;
  if (cts == null) {
    const mb = cfg.mailbox;
    cts = mb && typeof mb === "object" ? (mb as Record<string, unknown>).convertToShared : undefined;
  }
  if (cts == null) return false;
  if (typeof cts === "boolean") return cts;
  if (typeof cts === "string") return !(cts.trim() === "" || FALSY_WORD.test(cts));
  if (typeof cts === "object") {
    const v = (cts as Record<string, unknown>).value;
    if (v != null) return typeof v === "string" ? !FALSY_WORD.test(v) : Boolean(v);
    return true;
  }
  return Boolean(cts);
}

// The choice a job's config carries — what the step will really do. The case page shows it as the
// starting value, and withOffboardActions uses it to tell a real change from a restated default.
export function currentOffboardChoice(systemKey: string, cfg: Record<string, unknown>): string {
  if (systemKey === "google-workspace") return cfg.deleteUser === true ? "delete" : "suspend";
  if (systemKey === "exchange") return wantsConvertToShared(cfg) ? "convert" : "delete";
  return cfg.removeLicense || cfg.unassign ? "remove" : "archive";
}

// What the control saves: the case's earlier choices plus ONLY the rows the operator changed. An
// untouched row stays absent ("client default") — sending every row saved a mailbox "delete" the
// operator never chose, just because the client doesn't convert.
export function changedOffboardActions(
  saved: OffboardActions,
  rows: { systemKey: string; current: string }[],
  choice: Record<string, string>,
): OffboardActions {
  const out: Record<string, string> = { ...(saved as Record<string, string>) };
  for (const r of rows) if (choice[r.systemKey] !== undefined && choice[r.systemKey] !== r.current) out[r.systemKey] = choice[r.systemKey];
  return readOffboardActions({ offboardActions: out });
}

// The save's real outcome. The fields route returns `replanned`: "replanned", an error string, or null
// when it did not re-plan (the case has started) — then the control re-plans explicitly (`explicit`).
export function describeSaveOutcome(replanned: string | null, explicit?: { ok: boolean; error?: string }): { ok: boolean; text: string } {
  const fix = " — use Re-plan in the Actions menu";
  if (replanned === "replanned") return { ok: true, text: "Saved — the case was re-planned." };
  if (replanned != null) return { ok: false, text: `Saved, but the re-plan failed: ${replanned}${fix}` };
  if (!explicit) return { ok: false, text: `Saved, but the case was not re-planned${fix}` };
  if (!explicit.ok) return { ok: false, text: `Saved, but the re-plan failed: ${explicit.error ?? "unknown error"}${fix}` };
  return { ok: true, text: "Saved — the case was re-planned." };
}

// Does THIS licence step take the licence off? Only then does a mailbox delete concern it. `true` or a
// settings object ({ exceptWhen }, { note }) removes; false/absent does not; { defer } or a removedBy
// naming another step hands it to that step.
function removesLicenseHere(systemKey: string, rl: unknown): boolean {
  if (rl === true) return true;
  if (!rl || typeof rl !== "object" || Array.isArray(rl)) return false;
  const o = rl as Record<string, unknown>;
  if (o.defer === true) return false;
  return !(typeof o.removedBy === "string" && o.removedBy !== "" && o.removedBy !== systemKey);
}

// Why the mailbox can't be deleted on this plan, or null when it can. Not converting only deletes the
// mailbox because a licence step then takes the licence off (Exchange purges it after the grace). With
// no m365/entra step in the plan that removes it — removeLicense false or absent, or deferred to a step
// the plan doesn't have — not converting would just leave a licensed user mailbox: neither kept as
// shared nor deleted. So the option is unavailable, and withOffboardActions ignores a saved "delete".
export function mailboxDeleteBlocker(jobs: { systemKey: string; config?: unknown }[]): string | null {
  const removes = jobs.some((j) => (j.systemKey === "m365" || j.systemKey === "entra")
    && removesLicenseHere(j.systemKey, ((j.config as Record<string, unknown> | null) ?? {}).removeLicense));
  return removes ? null : "no step in this plan removes the licence, so the mailbox would not be deleted";
}

export function withOffboardActions(jobs: PlannedJob[], payload: Record<string, unknown>): PlannedJob[] {
  const a = readOffboardActions(payload);
  if (Object.keys(a).length === 0) return jobs;
  // A choice that restates what the client's config already does changes nothing — so a restated
  // default can never add a gate, flatten a client's convert threshold, or strip a licence.
  const differs = (j: PlannedJob, want: string | undefined) => want !== undefined && want !== currentOffboardChoice(j.systemKey, cfgOf(j));
  // Only a mailbox this case actually switched from convert to delete opens the licence steps.
  // And only when a licence step will actually take the licence off — otherwise "delete" is ignored and
  // the mailbox stays at the client default (see mailboxDeleteBlocker).
  const deleteMailbox = a.exchange === "delete" && mailboxDeleteBlocker(jobs) === null
    && jobs.some((j) => j.systemKey === "exchange" && differs(j, "delete"));
  return jobs.map((j) => {
    const key = j.systemKey as SystemWithChoice | string;
    const cfg = cfgOf(j);
    if (key === "google-workspace" && differs(j, a["google-workspace"])) {
      if (a["google-workspace"] === "delete") return destructive(j, { ...cfg, deleteUser: true });
      return { ...j, config: { ...cfg, deleteUser: false } };
    }
    if (key === "exchange" && differs(j, a.exchange) && (a.exchange !== "delete" || deleteMailbox)) {
      // Not converting leaves a user mailbox; once the licence comes off, Exchange purges it after its
      // 30-day grace — that IS the delete. Keep: convert to shared.
      if (deleteMailbox) return destructive(j, { ...cfg, convertToShared: false });
      return { ...j, config: { ...cfg, convertToShared: true } };
    }
    if ((key === "m365" || key === "entra") && deleteMailbox && removesLicenseHere(key, cfg.removeLicense)) {
      // The licence step normally refuses to strip a licence off an unconverted mailbox (that's what
      // protects the mail). On a case that chose to delete the mailbox, that removal is the point — but
      // only on a step that ALREADY removes the licence. It never turns removal on: an explicit
      // removeLicense:false, or a step that leaves the licence to another, is the client's choice and
      // stands (the mailbox then stays a licensed user mailbox rather than being purged).
      const rl = cfg.removeLicense;
      const base = rl && typeof rl === "object" ? (rl as Record<string, unknown>) : {};
      return destructive(j, { ...cfg, removeLicense: { ...base, allowWithoutConvert: true } });
    }
    if (key === "spanning" && differs(j, a.spanning)) {
      if (a.spanning === "remove") {
        const { swapLicense: _s, ...rest } = cfg;
        return destructive(j, { ...rest, removeLicense: true });
      }
      const { removeLicense: _r, unassign: _u, ...rest } = cfg;
      return { ...j, config: { ...rest, swapLicense: { to: "Archive" } } };
    }
    return j;
  });
}
