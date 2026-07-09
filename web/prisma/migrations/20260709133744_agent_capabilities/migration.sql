-- Agent.capabilities: which ALWAYS_ON_PREM system keys the agent's host can actually run (its
-- host-specific Coretelligent module loaded), reported each heartbeat as a JSON string[]. Nullable +
-- additive: existing (legacy) agents stay NULL and are treated as capable, so pre-capability routing
-- is unchanged until a runner on 1.31.0+ reports.
ALTER TABLE "Agent" ADD COLUMN "capabilities" JSONB;
