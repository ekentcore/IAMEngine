// Pure helpers for the per-client secret wiring panel. The app stores only Delinea *references*
// (a secret id), never values — see lib/secrets/delinea.ts for the preflight that resolves them.
import { NOT_NEEDED } from "@/lib/cases/case-secrets";

// A secret reference is "set" once it carries a real Delinea id (not blank, not the REPLACE_ME
// placeholder the profile generator emits, not the NOT_NEEDED manual-step sentinel). Get-CtgSecret
// throws on REPLACE_ME, so this mirrors the runner's fail-safe.
export function secretIsSet(externalId: string | null | undefined): boolean {
  const v = (externalId ?? "").trim();
  return v !== "" && v !== "REPLACE_ME" && v !== NOT_NEEDED;
}

export type SecretRow = {
  name: string; // logical key the systems reference (e.g. "m365-admin")
  externalId: string; // the Delinea secret id, "" if unmapped
  label: string | null;
  provider: string;
  referencedBy: string[]; // systemKeys that broker this secret
  isSet: boolean;
};

type SystemRef = { systemKey: string; secretNames: string[] };
type ExistingSecret = { name: string; externalId?: string | null; label?: string | null; provider?: string | null };

// Build one row per secret the client needs: the union of every secretName referenced across its
// systems, plus any already-mapped secret (even if no system references it anymore, so an orphaned
// mapping stays visible/editable). Merges in the saved id/label and flags whether it's wired.
export function deriveSecretRows(systems: SystemRef[], existing: ExistingSecret[]): SecretRow[] {
  const referencedBy = new Map<string, Set<string>>();
  for (const s of systems) {
    for (const name of s.secretNames ?? []) {
      if (!referencedBy.has(name)) referencedBy.set(name, new Set());
      referencedBy.get(name)!.add(s.systemKey);
    }
  }
  const byName = new Map(existing.map((e) => [e.name, e]));
  const names = new Set<string>([...referencedBy.keys(), ...byName.keys()]);

  return [...names]
    .map((name): SecretRow => {
      const e = byName.get(name);
      const externalId = e?.externalId ?? "";
      return {
        name,
        externalId,
        label: e?.label ?? null,
        provider: e?.provider ?? "delinea",
        referencedBy: [...(referencedBy.get(name) ?? [])].sort(),
        isSet: secretIsSet(externalId),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
