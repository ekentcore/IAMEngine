// Helpers for the AD folder tree picker. A "folder" is any node a user account can be created
// under: an organizational unit (OU=…), a container (CN=Users, CN=Computers, …), or the domain
// root itself (DC=…,DC=…). Discovery reports their DistinguishedNames; these helpers turn that flat
// DN list into a labelled, nestable tree. Pure — no React — so they're unit-tested directly.

export type FolderKind = "ou" | "container" | "domain";

// The leftmost RDN decides the kind: OU= is an organizational unit, CN= a container, DC= the root.
export function folderKind(dn: string): FolderKind {
  if (/^OU=/i.test(dn)) return "ou";
  if (/^CN=/i.test(dn)) return "container";
  if (/^DC=/i.test(dn)) return "domain";
  return "container";
}

// Human label for a node. OU/CN nodes show their own leaf name; a domain root (all-DC DN) renders as
// the dotted domain (DC=ad,DC=x,DC=com -> ad.puretechscientific.com style). Unparseable -> raw DN.
export function folderLabel(dn: string): string {
  const m = dn.match(/^(?:OU|CN)=([^,]+)/i);
  if (m) return m[1];
  const dcs = dn.match(/DC=([^,]+)/gi);
  if (dcs && dcs.length > 0 && /^DC=/i.test(dn)) {
    return dcs.map((p) => p.replace(/^DC=/i, "")).join(".");
  }
  return dn;
}

// Parent DN = the DN with its leftmost RDN removed. A single-RDN DN has no parent ("").
export function parentDn(dn: string): string {
  const i = dn.indexOf(",");
  return i >= 0 ? dn.slice(i + 1) : "";
}

// Merge an onboarding OU/folder DN into a per-system config's `onboard.ou`, immutably. The systems
// editor lifts this into a structured control (like offboardIntent -> config.intent.offboard) so it
// wins over the raw JSON textarea; the runner reads config.onboard.ou as the create target. An empty
// value clears the key (keeping any other onboard settings) so an operator can unset a wrong OU.
export function withOnboardOu(
  config: Record<string, unknown>,
  ou: string,
): Record<string, unknown> {
  const onboard = { ...((config.onboard as Record<string, unknown> | undefined) ?? {}) };
  if (ou) onboard.ou = ou;
  else delete onboard.ou;
  return { ...config, onboard };
}

// Nest a flat DN list into a tree keyed by parent DN. A node whose parent isn't in the set (the
// domain root, or a folder whose parent wasn't returned) becomes a top-level root. Children and
// roots are sorted by label so the tree reads alphabetically.
export function buildTree(dns: string[]): { children: Map<string, string[]>; roots: string[] } {
  const present = new Set(dns);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const dn of dns) {
    const p = parentDn(dn);
    if (present.has(p)) {
      const arr = children.get(p) ?? children.set(p, []).get(p)!;
      arr.push(dn);
    } else {
      roots.push(dn);
    }
  }
  const byLabel = (a: string, b: string) => folderLabel(a).localeCompare(folderLabel(b));
  for (const arr of children.values()) arr.sort(byLabel);
  roots.sort(byLabel);
  return { children, roots };
}
