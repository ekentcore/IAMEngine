// Maintenance / graceful-drain state (feature #7). One AppSetting key holds the whole state as a
// single JSON object so the claim() hot path is one read and toggles are race-safe via
// claimAppSetting. Absent/corrupt ⇒ "no maintenance" (fail-open — a pause switch must never turn
// itself ON by accident, and must never stop the fleet because a setting failed to parse).
import type { MaintenanceScope } from "./runner-logic";

// S3: our keys live under the `maintenance.*` namespace.
export const MAINTENANCE_KEY = "maintenance.state";

export type MaintenanceState = {
  // Global drain: pause ALL dispatch fleet-wide. The Azure-cutover switch; also drives heartbeat.drain.
  global: boolean;
  // Per-system pause: dispatch of these systemKeys is paused across every client.
  systems: string[];
  // Per-client pause: dispatch of all systems for these client ids is paused.
  clients: string[];
  // Free-text reason shown in the UI + audit.
  reason?: string;
  // Provenance for the banner + audit.
  since?: string; // ISO — when the current state was entered
  by?: string;    // display actor who last changed it
  // Transition marker: set once (race-safe) when a global drain reaches zero in-flight, so the
  // "fully drained" audit is emitted exactly once, not on every status poll. Cleared on any change.
  drainedAt?: string;
};

export const EMPTY_MAINTENANCE: MaintenanceState = { global: false, systems: [], clients: [] };

// Coerce a raw (possibly partial / legacy / corrupt) setting value into a full state. Fail-open:
// anything non-object or missing reads as no maintenance.
export function normalizeMaintenance(raw: Partial<MaintenanceState> | null | undefined): MaintenanceState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_MAINTENANCE };
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : [];
  return {
    global: raw.global === true,
    systems: strs(raw.systems),
    clients: strs(raw.clients),
    ...(typeof raw.reason === "string" && raw.reason.trim() ? { reason: raw.reason.trim() } : {}),
    ...(typeof raw.since === "string" ? { since: raw.since } : {}),
    ...(typeof raw.by === "string" ? { by: raw.by } : {}),
    ...(typeof raw.drainedAt === "string" ? { drainedAt: raw.drainedAt } : {}),
  };
}

// The I/O-free subset the pure claim() gate (maintenanceBlocks) consumes.
export function maintenanceScope(s: MaintenanceState): MaintenanceScope {
  return { global: s.global, systems: s.systems, clients: s.clients };
}

// Is ANY maintenance active (global or a scoped pause)? Drives the UI banner + the audit action label.
export function maintenanceActive(s: MaintenanceState): boolean {
  return s.global || s.systems.length > 0 || s.clients.length > 0;
}
