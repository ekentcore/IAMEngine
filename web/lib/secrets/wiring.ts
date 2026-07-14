// Pure helpers for the per-client secret wiring panel. The app stores only Delinea *references*
// (a secret id), never values — see lib/secrets/delinea.ts for the preflight that resolves them.
import { NOT_NEEDED } from "@/lib/cases/case-secrets";
import { OPTIONAL_SECRETS } from "./optional-secrets";

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
  // An OPTIONAL secret: it backs one extra capability (e.g. spanning-portal -> force-sync's console
  // sign-in) and nothing requires it. Shown so an operator can wire it at all — without a row here it
  // would be invisible, since no system lists it — but never counted as missing. See secrets/auxiliary.
  optional?: boolean;
};

type SystemRef = { systemKey: string; secretNames: string[] };
type ExistingSecret = { name: string; externalId?: string | null; label?: string | null; provider?: string | null };

// Build one row per secret the client needs: the union of every secretName referenced across its
// systems, plus any already-mapped secret (even if no system references it anymore, so an orphaned
// mapping stays visible/editable). Merges in the saved id/label and flags whether it's wired.
export function deriveSecretRows(systems: SystemRef[], existing: ExistingSecret[]): SecretRow[] {
  const referencedBy = new Map<string, Set<string>>();
  const optionalFor = new Map<string, Set<string>>();
  for (const s of systems) {
    for (const name of s.secretNames ?? []) {
      if (!referencedBy.has(name)) referencedBy.set(name, new Set());
      referencedBy.get(name)!.add(s.systemKey);
    }
    // Optional secrets are deliberately absent from ClientSystem.secretNames (listing them there would
    // make the system's jobs unclaimable until they're wired). So the ONLY way an operator can wire one
    // is if we offer it here — otherwise the capability is unreachable by design.
    for (const name of OPTIONAL_SECRETS[s.systemKey] ?? []) {
      if (referencedBy.has(name)) continue; // explicitly wired to a system already — not an extra
      if (!optionalFor.has(name)) optionalFor.set(name, new Set());
      optionalFor.get(name)!.add(s.systemKey);
    }
  }
  const byName = new Map(existing.map((e) => [e.name, e]));
  const names = new Set<string>([...referencedBy.keys(), ...optionalFor.keys(), ...byName.keys()]);

  return [...names]
    .map((name): SecretRow => {
      const e = byName.get(name);
      const externalId = e?.externalId ?? "";
      const optional = optionalFor.has(name) && !referencedBy.has(name);
      return {
        name,
        externalId,
        label: e?.label ?? null,
        provider: e?.provider ?? "delinea",
        referencedBy: [...(referencedBy.get(name) ?? optionalFor.get(name) ?? [])].sort(),
        isSet: secretIsSet(externalId),
        ...(optional ? { optional: true } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
