// Registry of per-system "intended automation" code-preview templaters. Add a system by
// adding its previewer here (mirrors the generator's extractor registry). Used by the client
// page (placeholder form) and the case playbook (resolved values from the planned case).
import type { PreviewUser } from "./preview-helpers";
import { previewM365 } from "./m365-preview";
import { previewActiveDirectory } from "./active-directory-preview";
import { previewMimecast } from "./mimecast-preview";
import { previewExchange } from "./exchange-preview";
import { previewDirectorySync } from "./directory-sync-preview";
import { previewZoom } from "./zoom-preview";
import { previewAdobe } from "./adobe-preview";
import { previewPerimeter81 } from "./perimeter81-preview";

export type Action = "onboard" | "offboard";
// `user` (optional) is the planned case payload; when present the preview substitutes its
// resolved identity/config values inline instead of `<UM case>` placeholders.
export type Previewer = (
  action: Action,
  config: unknown,
  identity: unknown,
  primaryDomain: string,
  user?: PreviewUser
) => string;

const PREVIEWERS: Record<string, Previewer> = {
  m365: previewM365,
  "active-directory": previewActiveDirectory,
  mimecast: previewMimecast,
  exchange: previewExchange,
  "directory-sync": previewDirectorySync,
  zoom: previewZoom,
  adobe: previewAdobe,
  perimeter81: previewPerimeter81,
};

export function automationPreview(
  systemKey: string,
  action: Action,
  config: unknown,
  identity: unknown,
  primaryDomain: string,
  user?: PreviewUser
): string | null {
  const fn = PREVIEWERS[systemKey];
  return fn ? fn(action, config, identity, primaryDomain, user) : null;
}

// The read-back checks each system's Confirm-Ctg<System> validator runs after the action, by
// (systemKey, action). Surfaced in the playbook so a reviewer sees what "verified" will mean.
// Kept here next to the previewer registry so the two stay in sync.
const VALIDATES: Record<string, Record<Action, string[]>> = {
  m365: {
    onboard: ["user exists", "AccountEnabled = true", "each license assigned", "each group present"],
    offboard: ["AccountEnabled = false", "groups removed", "license removed/kept per threshold"],
  },
  "active-directory": {
    onboard: ["user in target OU", "groups present", "home drive mapped"],
    offboard: ["account disabled", "groups removed", "hidden from GAL", "not moved (do-not-move-ou)"],
  },
  mimecast: {
    onboard: ["internal domain registered + verified"],
    offboard: ["removed from configured Mimecast groups"],
  },
  exchange: {
    onboard: [],
    offboard: ["mailbox shared (or kept > threshold)", "ActiveSync + OWA disabled"],
  },
  "directory-sync": {
    onboard: ["delta sync completed (no cycle in progress)"],
    offboard: ["delta sync completed (no cycle in progress)"],
  },
  zoom: {
    onboard: ["Zoom user present"],
    offboard: ["Zoom user absent / deactivated"],
  },
  adobe: {
    onboard: ["user present in product profile(s)"],
    offboard: ["user absent from the organization"],
  },
  perimeter81: {
    onboard: ["license headroom available"],
    offboard: ["Perimeter 81 user absent (seat freed)"],
  },
};

export function validationChecks(systemKey: string, action: Action): string[] {
  return VALIDATES[systemKey]?.[action] ?? [];
}
