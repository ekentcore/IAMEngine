// ServiceNow work-note write-back: append a note to a User Management ticket. Gated behind
// SN_WRITE_ENABLED (the POC key is read-only today) — callers must check writeBackEnabled()
// before invoking, and the UI disables the "Write back to UM" checkbox when it's off.
//
// We hold only the UM number (e.g. UM0028740); the Table API update needs the record sys_id,
// so we resolve it first, then PATCH the `work_notes` journal field (which appends a note).
import type { SnConfig } from "./types";
import { snGet, snWrite, assertConfig, SnGatewayError } from "./http";

const TABLE = "/api/now/table/sn_customerservice_user_management";

export function writeBackEnabled(): boolean {
  return process.env.SN_WRITE_ENABLED === "true" || process.env.SN_WRITE_ENABLED === "1";
}

// Resolve a UM number -> record sys_id. Returns null if the ticket isn't found.
export async function resolveUmSysId(config: SnConfig, number: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  assertConfig(config);
  const rows = await snGet<{ sys_id?: string }[]>(
    config,
    TABLE,
    { sysparm_query: `number=${number}`, sysparm_fields: "sys_id", sysparm_limit: "1" },
    fetcher
  );
  return rows[0]?.sys_id ?? null;
}

export type WorkNoteResult = { ok: true; sysId: string } | { ok: false; error: string };

// Append `note` to the UM ticket's work notes. Throws SnGatewayError on transport failure;
// returns { ok:false } for the expected, recoverable cases (write disabled / ticket missing).
export async function postWorkNote(
  config: SnConfig,
  number: string,
  note: string,
  fetcher: typeof fetch = fetch
): Promise<WorkNoteResult> {
  if (!writeBackEnabled()) return { ok: false, error: "ServiceNow write-back is disabled (SN_WRITE_ENABLED is not set)" };
  assertConfig(config);

  const sysId = await resolveUmSysId(config, number, fetcher);
  if (!sysId) return { ok: false, error: `UM ticket ${number} not found` };

  try {
    await snWrite(config, "PATCH", `${TABLE}/${sysId}`, { work_notes: note }, fetcher);
    return { ok: true, sysId };
  } catch (err) {
    if (err instanceof SnGatewayError) return { ok: false, error: err.message };
    throw err;
  }
}
