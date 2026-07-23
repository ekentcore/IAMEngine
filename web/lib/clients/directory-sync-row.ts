// The canonical `directory-sync` system shape and an idempotent way to add it to a client's
// system set. Kept pure (no fetch/DOM) so the shape logic is unit-tested without a browser.
// `directory-sync` makes an AD client "ad-synced": AD accounts are pushed to Entra before the
// cloud steps run. Ordered after `active-directory` normally, or after `exchange` (waiting for
// the mailbox) for hybrid-Exchange clients (the coretelligent.json pattern). `ad-dc` is an
// OPTIONAL secret — a DC agent authenticates as ambient SYSTEM — so the row needs no wiring to run.
import type { EditableSystem } from "./types";

export type DirectorySyncOpts = { orderAfter: "active-directory" | "exchange" };

export function directorySyncRow(opts: DirectorySyncOpts): EditableSystem {
  const config =
    opts.orderAfter === "exchange"
      ? { onboard: { command: "Start-ADSyncSyncCycle -PolicyType Delta", waitForMailbox: true } }
      : null;
  return {
    systemKey: "directory-sync",
    mode: "api",
    onboardWhen: "always",
    offboardWhen: "always",
    dependsOn: [opts.orderAfter],
    requiresApproval: false,
    captureEvidence: false,
    secretNames: ["ad-dc"],
    config,
  };
}

export function withDirectorySync(systems: EditableSystem[], opts: DirectorySyncOpts): EditableSystem[] {
  if (systems.some((s) => s.systemKey === "directory-sync")) return systems;
  return [...systems, directorySyncRow(opts)];
}
