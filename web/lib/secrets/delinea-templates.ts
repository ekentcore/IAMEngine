// Config for the Delinea (Secret Server) WRITE path — creating a secret in-app. Pure + env-driven;
// no network (the POST itself lives in delinea.ts createSecret). READ brokering never touches any of
// this, so an app with no write config keeps resolving secrets exactly as before.
//
// Three things must line up before the app can create a secret in Secret Server:
//   1. a WRITE account  — DELINEA_WRITE_USER/PASSWORD (or the read DELINEA_USER/PASSWORD, reused) with
//                          Create + template access, against DELINEA_BASE_URL.
//   2. a FOLDER          — where the secret lands, PER CLIENT: Client.delineaFolderId, else
//                          DELINEA_FOLDER_MAP[slug].
//   3. a TEMPLATE        — the Secret Server secretTemplateId for that kind of credential, plus the
//                          map from our field labels → Secret Server field slugs. Template ids are
//                          per-instance, so they come from env (DELINEA_TEMPLATE_MAP / DELINEA_TEMPLATE_<KEY>).
//                          The field-label list is seeded from SECRET_FIELD_REQUIREMENTS so it stays in
//                          sync with what the app collects and what the runner will read back.
import { SECRET_FIELD_REQUIREMENTS } from "./field-requirements";

export type TemplateMapping = {
  templateId: number; // Secret Server secretTemplateId (per-instance; from env)
  // our field LABEL (as shown to the operator / keyed in the create request) → Secret Server field slug.
  fieldMap: Record<string, string>;
};

export type DelineaWriteConfig = { baseUrl: string; username: string; password: string };

// A Secret Server field name → its conventional slug (lowercase, alnum only). Real slugs are defined
// per template and can be overridden via DELINEA_TEMPLATE_MAP; this is the best-effort default.
export const defaultSlug = (fieldName: string): string => fieldName.toLowerCase().replace(/[^a-z0-9]+/g, "");

// env var name carrying just the template id for one secret, e.g. m365-admin → DELINEA_TEMPLATE_M365_ADMIN.
export const templateEnvKey = (secretName: string): string =>
  "DELINEA_TEMPLATE_" + secretName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

type Env = Record<string, string | undefined>;

function parseJson<T>(raw: string | undefined): T | null {
  if (!raw || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// DELINEA_TEMPLATE_MAP — JSON keyed by secretName. Each entry is either a bare template id
// (number/string) or { templateId, fieldMap? } to also override the label→slug mapping.
type TemplateMapEntry = number | string | { templateId?: number | string; fieldMap?: Record<string, string> };
// Memoized on the raw env value — delineaWriteSummary calls templateFor() once per client secret, so
// re-parsing the same JSON each time is wasted work on every client-detail/setup render.
let _tmplCache: { raw: string | undefined; parsed: Record<string, TemplateMapEntry> } | null = null;
function parseTemplateMap(env: Env): Record<string, TemplateMapEntry> {
  const raw = env.DELINEA_TEMPLATE_MAP;
  if (_tmplCache && _tmplCache.raw === raw) return _tmplCache.parsed;
  const parsed = parseJson<Record<string, TemplateMapEntry>>(raw) ?? {};
  _tmplCache = { raw, parsed };
  return parsed;
}

const asId = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

// The default field label → slug map for a secret, seeded from its field requirements (first synonym
// of each requirement, slugified). Empty for a secret with no known requirements.
export function defaultFieldMap(secretName: string): Record<string, string> {
  const reqs = SECRET_FIELD_REQUIREMENTS[secretName];
  if (!reqs) return {};
  return Object.fromEntries(reqs.map((r) => [r.label, defaultSlug(r.anyOf[0])]));
}

// Resolve the template mapping for a secret, or null when no template id is configured (→ can't
// create). fieldMap merges the seeded defaults with any per-secret override from DELINEA_TEMPLATE_MAP.
export function templateFor(secretName: string, env: Env = process.env): TemplateMapping | null {
  const entry = parseTemplateMap(env)[secretName];
  const perKeyId = asId(env[templateEnvKey(secretName)]);
  const mapId = typeof entry === "object" && entry !== null ? asId(entry.templateId) : asId(entry);
  const templateId = mapId ?? perKeyId;
  if (templateId == null) return null;
  const override = typeof entry === "object" && entry !== null ? entry.fieldMap ?? {} : {};
  return { templateId, fieldMap: { ...defaultFieldMap(secretName), ...override } };
}

// DELINEA_FOLDER_MAP — JSON { slug: folderId }.
function folderMap(env: Env): Record<string, string | number> {
  return parseJson<Record<string, string | number>>(env.DELINEA_FOLDER_MAP) ?? {};
}

// The Secret Server folder id for a client: its own Client.delineaFolderId wins, else DELINEA_FOLDER_MAP[slug].
export function folderIdFor(slug: string, clientFolderId?: string | null, env: Env = process.env): string | null {
  const own = (clientFolderId ?? "").trim();
  if (own) return own;
  const v = folderMap(env)[slug];
  return v != null && String(v).trim() ? String(v) : null;
}

// The write account: a distinct DELINEA_WRITE_USER/PASSWORD if set, else the read DELINEA_USER/PASSWORD
// (reused). Same base URL as reads.
export function delineaWriteConfigFromEnv(env: Env = process.env): DelineaWriteConfig {
  return {
    baseUrl: (env.DELINEA_BASE_URL ?? "").replace(/\/+$/, ""),
    username: env.DELINEA_WRITE_USER || env.DELINEA_USER || "",
    password: env.DELINEA_WRITE_PASSWORD || env.DELINEA_PASSWORD || "",
  };
}

export function writeAccountConfigured(cfg: DelineaWriteConfig): boolean {
  return Boolean(cfg.baseUrl && cfg.username && cfg.password);
}

export type WriteCapability = {
  ok: boolean; // all three present → the app can create this secret for this client
  hasAccount: boolean;
  hasFolder: boolean;
  hasTemplate: boolean;
  missing: string[]; // human-readable list of what's absent (for a precise refusal / tooltip)
};

// The single gate the API and UI both consult: can the app create THIS secret for THIS client right now?
export function delineaWriteConfigured(opts: {
  slug: string;
  secretName: string;
  clientFolderId?: string | null;
  env?: Env;
}): WriteCapability {
  const env = opts.env ?? process.env;
  const hasAccount = writeAccountConfigured(delineaWriteConfigFromEnv(env));
  const hasFolder = folderIdFor(opts.slug, opts.clientFolderId, env) != null;
  const hasTemplate = templateFor(opts.secretName, env) != null;
  const missing: string[] = [];
  if (!hasAccount) missing.push("a Delinea write account (DELINEA_WRITE_USER/PASSWORD, or the read DELINEA_USER/PASSWORD)");
  if (!hasFolder) missing.push("this client's Delinea folder id (set it on the client, or via DELINEA_FOLDER_MAP)");
  if (!hasTemplate) missing.push(`a template id for "${opts.secretName}" (DELINEA_TEMPLATE_MAP, or ${templateEnvKey(opts.secretName)})`);
  return { ok: hasAccount && hasFolder && hasTemplate, hasAccount, hasFolder, hasTemplate, missing };
}

// Server-side summary for the UI: the instance write account, the client's resolved folder, and which
// of the client's secret names have a template mapped. Shaped to pass straight down as a prop.
export type DelineaWriteSummary = { hasAccount: boolean; folderId: string | null; templates: Record<string, boolean> };
export function delineaWriteSummary(opts: { slug: string; clientFolderId?: string | null; secretNames: string[]; env?: Env }): DelineaWriteSummary {
  const env = opts.env ?? process.env;
  return {
    hasAccount: writeAccountConfigured(delineaWriteConfigFromEnv(env)),
    folderId: folderIdFor(opts.slug, opts.clientFolderId, env),
    templates: Object.fromEntries(opts.secretNames.map((n) => [n, templateFor(n, env) != null])),
  };
}
