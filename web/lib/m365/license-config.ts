// The default-license list (ClientSystem.config.onboard.licenses) entry shape. A STRING is the
// classic direct assignment (runner calls Set-MgUserLicense). A GROUP-BASED object licenses via
// group membership instead — the picked group carries the license (Entra group-based licensing,
// or an AD group that syncs up). The group is stored by NAME: the runner resolves it live at
// execution, so a rename/deletion fails actionably instead of going stale like a pasted GUID.
export type GroupBasedLicense = { name: string; assignVia: "group"; group: string; groupSource: "entra" | "ad" };
export type LicenseEntry = string | GroupBasedLicense;

export function isGroupBased(e: LicenseEntry): e is GroupBasedLicense {
  return typeof e !== "string" && e.assignVia === "group";
}

export function licenseEntryName(e: LicenseEntry): string {
  return typeof e === "string" ? e : e.name;
}

// Parse + validate an untrusted `licenses` payload (the save route's body). Trims, drops empty
// strings, de-dupes (case-insensitive on the license name + group), and rejects malformed
// entries with a message the editor can show verbatim.
export function parseLicenseEntries(v: unknown): { ok: true; licenses: LicenseEntry[] } | { ok: false; error: string } {
  if (!Array.isArray(v)) return { ok: false, error: "licenses must be an array" };
  const out: LicenseEntry[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x === "string") {
      const t = x.trim();
      if (!t) continue;
      const k = `direct:${t.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); out.push(t); }
      continue;
    }
    if (x && typeof x === "object" && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      if (o.assignVia !== "group") return { ok: false, error: "an object license entry must have assignVia: 'group'" };
      const name = typeof o.name === "string" ? o.name.trim() : "";
      const group = typeof o.group === "string" ? o.group.trim() : "";
      const groupSource = o.groupSource == null || o.groupSource === "entra" ? "entra" : o.groupSource === "ad" ? "ad" : null;
      if (!name) return { ok: false, error: "a group-based license entry needs a license name" };
      if (!group) return { ok: false, error: `group-based license '${name}' needs a group` };
      if (!groupSource) return { ok: false, error: `group-based license '${name}': groupSource must be 'entra' or 'ad'` };
      const k = `group:${name.toLowerCase()}|${group.toLowerCase()}|${groupSource}`;
      if (!seen.has(k)) { seen.add(k); out.push({ name, assignVia: "group", group, groupSource }); }
      continue;
    }
    return { ok: false, error: "license entries must be strings or group-based objects" };
  }
  return { ok: true, licenses: out };
}
