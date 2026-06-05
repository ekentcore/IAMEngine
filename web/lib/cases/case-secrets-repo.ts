// Per-case secret status: which Delinea references the case's jobs need, where each resolves from
// (case override / client default / missing), the host the step runs on, and which systems use it.
// Plus the setter for a per-case override. References only — never values.
import type { PrismaClient } from "@prisma/client";
import { effectiveExternalId, serverHintFromLabel, type SecretSource } from "./case-secrets";

export type CaseSecretStatus = {
  name: string;
  label: string | null;
  source: SecretSource;
  externalId: string | null; // the effective reference (case override or client default)
  clientExternalId: string | null; // the client default, for the "reset to client" affordance
  overridden: boolean;
  server: string | null; // host hint parsed from the label, e.g. core-cce-dc01
  systems: string[]; // system keys whose jobs need this secret
};

export async function caseSecretStatus(db: PrismaClient, caseId: string): Promise<CaseSecretStatus[] | null> {
  const c = await db.caseRequest.findUnique({
    where: { id: caseId },
    select: {
      clientId: true,
      secretOverrides: true,
      jobs: { select: { systemKey: true, request: true } },
    },
  });
  if (!c) return null;

  // secret name -> the systems that reference it (from each job's request.secretNames)
  const usedBy = new Map<string, Set<string>>();
  for (const j of c.jobs) {
    const names = ((j.request as { secretNames?: unknown } | null)?.secretNames ?? []) as unknown[];
    for (const n of names) {
      if (typeof n !== "string") continue;
      (usedBy.get(n) ?? usedBy.set(n, new Set()).get(n)!).add(j.systemKey);
    }
  }
  if (usedBy.size === 0) return [];

  const clientSecrets = await db.secret.findMany({
    where: { clientId: c.clientId, name: { in: [...usedBy.keys()] } },
    select: { name: true, externalId: true, label: true },
  });
  const byName = new Map(clientSecrets.map((s) => [s.name, s]));
  const overrides = c.secretOverrides;

  return [...usedBy.entries()]
    .map(([name, systems]) => {
      const cs = byName.get(name) ?? null;
      const eff = effectiveExternalId(name, overrides, cs?.externalId ?? null);
      return {
        name,
        label: cs?.label ?? null,
        source: eff.source,
        externalId: eff.externalId,
        clientExternalId: cs?.externalId ?? null,
        overridden: eff.source === "case",
        server: serverHintFromLabel(cs?.label),
        systems: [...systems].sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Set (or clear, with externalId=null) a per-case override for one secret name. Atomic jsonb merge
// (single UPDATE) so two concurrent edits of different keys can't lose each other (no read-modify-
// write race). Returns the row count (0 = no such case).
export async function setCaseSecretOverride(
  db: PrismaClient,
  caseId: string,
  name: string,
  externalId: string | null
): Promise<number> {
  const id = externalId?.trim();
  if (id) {
    // merge { name: id } into the existing map (|| concatenates jsonb, right side wins)
    return db.$executeRaw`UPDATE "CaseRequest" SET "secretOverrides" = COALESCE("secretOverrides", '{}'::jsonb) || ${JSON.stringify({ [name]: id })}::jsonb WHERE id = ${caseId}`;
  }
  // remove the key (jsonb minus text)
  return db.$executeRaw`UPDATE "CaseRequest" SET "secretOverrides" = COALESCE("secretOverrides", '{}'::jsonb) - ${name} WHERE id = ${caseId}`;
}
