// The default-license list (ClientSystem.config.onboard.licenses) entry shape. A STRING is the
// classic direct assignment (runner calls Set-MgUserLicense); a legacy { name, skuId } object is
// direct too (the runner honors skuId) and must round-trip unharmed. A GROUP-BASED object licenses
// via group membership instead — the picked group carries the license (Entra group-based licensing,
// or an AD group that syncs up). The group is stored by NAME: the runner resolves it live at
// execution, so a rename/deletion fails actionably instead of going stale like a pasted GUID.
export type DirectLicenseObject = { name: string; skuId?: string };
export type GroupBasedLicense = { name: string; assignVia: "group"; group: string; groupSource: "entra" | "ad" };
export type LicenseEntry = string | DirectLicenseObject | GroupBasedLicense;

export function isGroupBased(e: LicenseEntry): e is GroupBasedLicense {
  return typeof e !== "string" && (e as GroupBasedLicense).assignVia === "group";
}

export function licenseEntryName(e: LicenseEntry): string {
  return typeof e === "string" ? e : (e.name || (e as DirectLicenseObject).skuId || "");
}

// Parse + validate an untrusted `licenses` payload (the save route's body, or a stored config the
// editor loads). Trims, drops empty strings, and keeps ONE entry per license name (first wins,
// case-insensitive) — a license is assigned exactly one way, which is also the editor's model.
// Rejects malformed entries with a message the editor can show verbatim.
export function parseLicenseEntries(v: unknown): { ok: true; licenses: LicenseEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(v)) return { ok: false, error: "licenses must be an array" };
  const out: LicenseEntry[] = [];
  const seen = new Set<string>();
  const keep = (name: string, entry: LicenseEntry) => {
    const k = name.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(entry); }
  };
  for (const x of v) {
    if (typeof x === "string") {
      const t = x.trim();
      if (t) keep(t, t);
      continue;
    }
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name.trim() : "";
      if (o.assignVia === undefined) {
        // Legacy direct object ({ name, skuId? }) — preserve it, don't collapse to a bare name.
        const skuId = typeof o.skuId === "string" ? o.skuId.trim() : "";
        if (!name && !skuId) return { ok: false, error: "a license object needs a name or skuId" };
        keep(name || skuId, skuId ? { name: name || skuId, skuId } : { name });
        continue;
      }
      if (o.assignVia !== "group") return { ok: false, error: "an object license entry's assignVia must be 'group'" };
      const group = typeof o.group === "string" ? o.group.trim() : "";
      const groupSource = o.groupSource == null || o.groupSource === "entra" ? "entra" : o.groupSource === "ad" ? "ad" : null;
      if (!name) return { ok: false, error: "a group-based license entry needs a license name" };
      if (!group) return { ok: false, error: `group-based license '${name}' needs a group` };
      if (!groupSource) return { ok: false, error: `group-based license '${name}': groupSource must be 'entra' or 'ad'` };
      keep(name, { name, assignVia: "group", group, groupSource });
      continue;
    }
    return { ok: false, error: "license entries must be strings or license objects" };
  }
  return { ok: true, licenses: out };
}
