// Orchestrates a full ServiceNow sync end-to-end: fetch -> normalize -> reconcile.
// One place wires the gateway, mappers, repository and service together so both the
// /api/clients/sync route and the stale-check use the exact same path.
import type { PrismaClient } from "@prisma/client";
import { fetchSnAccounts, snConfigFromEnv } from "../servicenow/gateway";
import { normalizeAccount } from "../servicenow/mappers";
import type { ActorInput } from "../auth/actor";
import { makeClientRepository } from "./repository";
import { syncClientsFromSn } from "./sync-service";
import type { SyncResult } from "./types";

export async function runSnSync(db: PrismaClient, actor: ActorInput): Promise<SyncResult> {
  const raw = await fetchSnAccounts(snConfigFromEnv());
  // Isolate per-record normalization failures so one malformed record can't abort the batch.
  const normalized = raw.flatMap((r) => {
    try {
      return [normalizeAccount(r)];
    } catch {
      return [];
    }
  });
  return syncClientsFromSn(normalized, makeClientRepository(db), actor);
}
