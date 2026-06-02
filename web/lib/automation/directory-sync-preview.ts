// Renders the Azure AD Connect delta-sync trigger Coretelligent.DirectorySync intends to run
// (mirrors runner/modules/Coretelligent.DirectorySync). Pure string templating; no side effects.
import type { PreviewUser } from "./preview-helpers";

type DirectorySyncConfig = { host?: string };

export function previewDirectorySync(_action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, _user?: PreviewUser): string {
  const cfg = (config ?? {}) as DirectorySyncConfig;
  const lines = ["# --- intended automation (Coretelligent.DirectorySync — idempotent) ---"];
  if (cfg.host) lines.push(`# AAD Connect host: ${cfg.host}`);
  lines.push(
    "# start a delta sync, unless one is already in progress",
    `$scheduler = Get-ADSyncScheduler`,
    `if (-not $scheduler.SyncCycleInProgress) { Start-ADSyncSyncCycle -PolicyType Delta }`
  );
  return lines.join("\n");
}
