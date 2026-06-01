// Registry of code previewers, keyed by system. Mirrors the shape of the
// generator's extractor registry: start with m365, plug in active-directory,
// mimecast, … later by adding entries here.
import type { Action } from "@prisma/client";
import type { Identity } from "@/lib/clients/types";
import { previewM365 } from "@/lib/automation/m365-preview";

export type Previewer = (
  action: Action,
  config: Record<string, unknown> | null,
  identity: Identity | null,
  primaryDomain: string
) => string;

export const previewers = new Map<string, Previewer>([
  ["m365", (action, config, identity, domain) => previewM365(action, config, identity, domain)],
]);

// Convenience: returns the rendered preview, or null if the system has no previewer.
export function previewFor(
  systemKey: string,
  action: Action,
  config: Record<string, unknown> | null,
  identity: Identity | null,
  primaryDomain: string
): string | null {
  const fn = previewers.get(systemKey);
  return fn ? fn(action, config, identity, primaryDomain) : null;
}
