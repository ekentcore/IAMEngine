// Existing-id verify-then-wire: given a Delinea externalId an operator has typed/pasted for a system,
// resolve its field VALUES, run the value-probe (Task 1) against them, and — on a passing (or
// non-blocking/advisory) probe — wire the reference into the client's Secret rows. A BLOCKING probe
// failure refuses to wire: there's no point recording a reference we just proved doesn't authenticate.
// Pure/DB-injected so this unit-tests without Prisma or a live Delinea; the route supplies the real
// resolveFields (delinea.ts's resolveSecretFields) and fetcher.
import type { PrismaClient } from "@prisma/client";
import { probeSecretValues, type ProbeCtx } from "./value-probe";
import { makeClientRepository } from "@/lib/clients/repository";
import type { ActorInput } from "@/lib/auth/actor";

type ResolveFields = (externalId: string) => Promise<{ ok: true; fields: Record<string, string> } | { ok: false; error: string }>;

export async function verifyAndWire(input: {
  db: PrismaClient; slug: string; clientId: string; name: string; externalId: string; label?: string;
  // The operator running the test — forwarded to upsertSecrets so a rewire that clears an attestation
  // (see repository.ts's upsertSecrets) audits back to the human, not "system" (PR #70's gap).
  actor?: ActorInput;
  env?: Record<string, string | undefined>; ctx?: ProbeCtx; fetcher?: typeof fetch; resolveFields: ResolveFields;
}): Promise<{ ok: boolean; error?: string; wired?: boolean; label?: string }> {
  const resolved = await input.resolveFields(input.externalId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const probe = await probeSecretValues(input.name, resolved.fields, input.ctx ?? {}, input.fetcher ?? fetch);
  if (probe.probeable && probe.blocking && probe.ok === false) return { ok: false, error: probe.error ?? "the credential did not authenticate" };
  await makeClientRepository(input.db).upsertSecrets(input.clientId, [{ name: input.name, externalId: input.externalId, label: input.label ?? null }], input.actor);
  return { ok: true, wired: true, label: probe.label };
}
