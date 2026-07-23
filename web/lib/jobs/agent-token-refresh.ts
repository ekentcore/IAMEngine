// Pure decisions the heartbeat makes for per-agent token lifecycle, split out so they're unit-testable
// without a live DB. The service applies the returned `update` object to the Agent row.
import { generateAgentToken } from "@/lib/runner/agent-token";

export function planTokenRefresh(agent: { tokenRefreshRequested: boolean }):
  | { token: string; update: { tokenHash: string; tokenPrefix: string; tokenProvisionedAt: Date; tokenRefreshRequested: false; tokenRefreshDeliveredAt: Date } }
  | null {
  if (!agent.tokenRefreshRequested) return null;
  const { token, prefix, hash } = generateAgentToken();
  const now = new Date();
  return {
    token,
    update: { tokenHash: hash, tokenPrefix: prefix, tokenProvisionedAt: now, tokenRefreshRequested: false, tokenRefreshDeliveredAt: now },
  };
}

export function planTokenConfirm(agent: { via: "per-agent" | "shared" | null | undefined; tokenConfirmedAt: Date | null }):
  | { tokenConfirmedAt: Date; tokenRotatedAt?: Date }
  | null {
  if (agent.via !== "per-agent") return null;
  const now = new Date();
  if (agent.tokenConfirmedAt) return { tokenRotatedAt: now, tokenConfirmedAt: now };
  return { tokenConfirmedAt: now };
}
