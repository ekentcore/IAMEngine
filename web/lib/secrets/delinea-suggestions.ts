import type { SecretSearchRecord } from "./delinea-search";

// Keyword aliases per target secret name — a candidate whose NAME contains any alias is a name match.
// Includes the vendor word(s) + the console-login variant so the same map serves API creds and logins.
export const SUGGESTION_ALIASES: Record<string, string[]> = {
  adobe: ["adobe", "umapi"],
  "adobe-console": ["adobe"],
  zoom: ["zoom"],
  "zoom-console": ["zoom"],
  mimecast: ["mimecast"],
  "mimecast-console": ["mimecast"],
  egnyte: ["egnyte"],
  "egnyte-console": ["egnyte"],
  knowbe4: ["knowbe4", "know be4", "kb4"],
  "knowbe4-console": ["knowbe4", "kb4"],
  slack: ["slack", "scim"],
  "slack-console": ["slack"],
  spanning: ["spanning", "backup"],
  // The Spanning console login is Microsoft-365 SSO, so it is usually the O365 global admin — surface
  // those logins too so the portal secret can be matched from an M365/global-admin candidate.
  "spanning-portal": ["spanning", "o365", "office 365", "global admin", "global administrator", "m365", "365", "azure"],
  proofpoint: ["proofpoint"],
  "m365-admin": ["m365", "azure", "entra", "graph", "global admin", "365"],
  "m365-global-admin": ["m365", "global admin", "365", "azure", "entra", "global administrator"],
  "google-admin": ["google", "workspace", "gws", "super admin", "admin"],
};

export type SuggestionTarget = { secretName: string; templateName: string | null; subfolders: string[] };
export type RankedSuggestion = {
  secretId: number; name: string; folderPath: string; folderId: number | null;
  template?: string; score: number; reasons: string[];
};

const norm = (s: string) => s.toLowerCase();
const lastSegment = (folderPath: string) => folderPath.split("\\").filter(Boolean).pop() ?? "";

export function rankDelineaSuggestions(candidates: SecretSearchRecord[], target: SuggestionTarget): RankedSuggestion[] {
  const aliases = SUGGESTION_ALIASES[target.secretName] ?? [target.secretName.replace(/-/g, " ")];
  const wantSub = target.subfolders.map(norm);
  const out: RankedSuggestion[] = [];
  for (const c of candidates) {
    let score = 0;
    const reasons: string[] = [];
    if (target.templateName && c.secretTemplateName && norm(c.secretTemplateName) === norm(target.templateName)) {
      score += 3; reasons.push(`template: ${c.secretTemplateName}`);
    }
    const nm = norm(c.name);
    const hit = aliases.find((a) => nm.includes(norm(a)));
    if (hit) { score += 2; reasons.push(`name matches '${hit}'`); }
    const leaf = norm(lastSegment(c.folderPath));
    const subIdx = wantSub.indexOf(leaf);
    if (subIdx !== -1) {
      // Earlier subfolders in the target list are the stronger signal (the module's own "Vendor"
      // subfolder outranks a generic "Identity Services"): +1 base, +0.5 per position ahead.
      score += 1 + (wantSub.length - 1 - subIdx) * 0.5;
      reasons.push(`in ${lastSegment(c.folderPath)} subfolder`);
    }
    if (score <= 0) continue;
    const fidRaw = lastSegment(c.folderPath);
    out.push({
      secretId: c.id, name: c.name, folderPath: c.folderPath,
      folderId: /^\d+$/.test(fidRaw) ? Number(fidRaw) : null,
      template: c.secretTemplateName, score, reasons,
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, 25);
}
