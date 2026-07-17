// HAR import: turn a browser-captured HAR (recorded while an admin did the task by hand against the
// vendor's API/portal) into a DRAFT http connector definition. This is the no-code path — the admin
// reviews and names operations before anything is published.
//
// Safety: we STRIP every credential the capture carried (cookies, Authorization/api-key headers, and
// query/body values the admin flags as secret) and we NEVER put a captured value into the definition
// verbatim except as a proposed literal the admin then templatizes. The importer only proposes; the
// builder + the publish gate + the runner allowlist are the actual boundaries.

import { HTTP_METHODS } from "./definition";

type HarHeader = { name: string; value: string };
type HarEntry = {
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    postData?: { text?: string; mimeType?: string };
    queryString?: { name: string; value: string }[];
  };
  response?: { status?: number; content?: { mimeType?: string } };
};

export type ImportedOperation = {
  suggestedName: string;
  method: string;
  host: string;
  path: string; // path + query, relative
  headers: Record<string, string>; // non-secret headers only
  body: unknown; // parsed JSON body, or null
  responseStatus: number | null;
  // Header names we removed because they carried auth — surfaced so the admin wires them as auth
  // instead of baking a captured token into the definition.
  strippedAuthHeaders: string[];
};

export type HarImportResult = {
  hosts: string[]; // distinct hosts seen — the allowlist candidate set
  operations: ImportedOperation[];
  skipped: number; // requests dropped (static assets, non-API, non-JSON)
  note: string;
};

// Headers that carry credentials — never copied into a definition; the admin re-declares auth.
const AUTH_HEADER_RE = /^(authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token|x-csrf-token|proxy-authorization)$/i;
// Request/response content types we treat as "an API call worth proposing".
const JSON_MIME_RE = /json|\+json/i;
// Static asset extensions — never operations.
const STATIC_RE = /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|mp4|woff|eot)(\?|$)/i;
const ANALYTICS_HOST_RE = /(google-analytics|googletagmanager|doubleclick|segment|sentry|datadog|newrelic|hotjar|mixpanel|fullstory|intercom|launchdarkly)\./i;

function slugFromPath(method: string, path: string): string {
  const clean = path.split("?")[0].replace(/\/+$/g, "");
  const parts = clean.split("/").filter(Boolean).filter((p) => !/^[0-9a-f-]{6,}$/i.test(p)); // drop id-like segments
  const tail = parts.slice(-2).join("-").replace(/[^a-z0-9-]/gi, "-").toLowerCase().replace(/-+/g, "-").replace(/^-|-$/g, "");
  const verb = { GET: "get", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete", HEAD: "head" }[method] ?? method.toLowerCase();
  const base = tail ? `${verb}-${tail}` : verb;
  return base.slice(0, 48) || "operation";
}

function parseBody(postData?: { text?: string; mimeType?: string }): unknown {
  if (!postData?.text) return null;
  if (postData.mimeType && !JSON_MIME_RE.test(postData.mimeType)) return null;
  try {
    return JSON.parse(postData.text);
  } catch {
    return null;
  }
}

// Parse a HAR string into proposed operations. Deterministic and dependency-free.
export function importHar(harText: string): HarImportResult {
  let har: { log?: { entries?: HarEntry[] } };
  try {
    har = JSON.parse(harText);
  } catch {
    return { hosts: [], operations: [], skipped: 0, note: "not valid JSON — export the capture as HAR (not a screenshot or a cURL log)" };
  }
  const entries = har?.log?.entries;
  if (!Array.isArray(entries)) {
    return { hosts: [], operations: [], skipped: 0, note: "no request entries found — is this a HAR file? (log.entries was empty)" };
  }

  const hosts = new Set<string>();
  const operations: ImportedOperation[] = [];
  const seen = new Set<string>(); // dedupe identical method+path
  let skipped = 0;

  for (const e of entries) {
    const method = (e.request?.method ?? "").toUpperCase();
    const rawUrl = e.request?.url ?? "";
    if (!method || !rawUrl || !(HTTP_METHODS as readonly string[]).includes(method)) { skipped++; continue; }
    let u: URL;
    try { u = new URL(rawUrl); } catch { skipped++; continue; }
    if (u.protocol !== "https:") { skipped++; continue; }
    if (STATIC_RE.test(u.pathname) || ANALYTICS_HOST_RE.test(u.hostname)) { skipped++; continue; }

    const reqMime = e.request?.postData?.mimeType ?? "";
    const respMime = e.response?.content?.mimeType ?? "";
    const body = parseBody(e.request?.postData);
    // Keep it if it looks like an API call: a parsed JSON body, OR a JSON response, OR a GET whose
    // path has no file extension (a REST resource). Drops navigations/asset loads.
    const looksApi =
      body !== null ||
      JSON_MIME_RE.test(respMime) ||
      JSON_MIME_RE.test(reqMime) ||
      (method === "GET" && !/\.[a-z0-9]{2,5}$/i.test(u.pathname));
    if (!looksApi) { skipped++; continue; }

    const key = `${method} ${u.pathname}${u.search}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);

    const strippedAuthHeaders: string[] = [];
    const headers: Record<string, string> = {};
    for (const h of e.request?.headers ?? []) {
      if (!h?.name) continue;
      if (h.name.startsWith(":")) continue; // HTTP/2 pseudo-headers
      if (AUTH_HEADER_RE.test(h.name)) { strippedAuthHeaders.push(h.name); continue; }
      // Keep only content negotiation / a couple of useful hints — never copy arbitrary headers, they
      // often carry tokens under vendor-specific names. The admin adds any others deliberately.
      if (/^(accept|content-type|accept-language)$/i.test(h.name)) headers[h.name] = h.value;
    }

    hosts.add(u.hostname);
    operations.push({
      suggestedName: slugFromPath(method, u.pathname),
      method,
      host: u.hostname,
      path: `${u.pathname}${u.search}`,
      headers,
      body,
      responseStatus: typeof e.response?.status === "number" ? e.response.status : null,
      strippedAuthHeaders: [...new Set(strippedAuthHeaders)],
    });
  }

  // Disambiguate duplicate suggested names (get-users, get-users-2…).
  const nameCounts = new Map<string, number>();
  for (const op of operations) {
    const n = nameCounts.get(op.suggestedName) ?? 0;
    nameCounts.set(op.suggestedName, n + 1);
    if (n > 0) op.suggestedName = `${op.suggestedName}-${n + 1}`;
  }

  const note = operations.length === 0
    ? `no API-looking requests found among ${entries.length} entries — the capture may be all page/asset loads. Record while you perform the actual task (create/disable a user) with the network tab open.`
    : `${operations.length} candidate operation${operations.length === 1 ? "" : "s"} across ${hosts.size} host${hosts.size === 1 ? "" : "s"}; ${skipped} request${skipped === 1 ? "" : "s"} skipped (assets, analytics, non-API). Auth headers were stripped — declare auth in the connector.`;
  return { hosts: [...hosts].sort(), operations, skipped, note };
}

// Rewrite captured sample values into {{template}} placeholders. The admin gives the sample values
// they used during capture (the test user's email, name, id) mapped to a template path; every literal
// occurrence in paths/bodies becomes that placeholder. Longest samples first so "jane@x.com" is
// replaced before "jane". Applied to a single operation; returns a copy.
export function templatizeOperation(op: ImportedOperation, samples: { value: string; template: string }[]): ImportedOperation {
  const ordered = [...samples].filter((s) => s.value && s.template).sort((a, b) => b.value.length - a.value.length);
  const sub = (s: string): string => {
    let out = s;
    for (const { value, template } of ordered) {
      if (value.length < 2) continue; // never sub a 1-char value — too noisy
      out = out.split(value).join(`{{${template}}}`);
    }
    return out;
  };
  const subDeep = (v: unknown): unknown => {
    if (typeof v === "string") return sub(v);
    if (Array.isArray(v)) return v.map(subDeep);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subDeep(x)]));
    return v;
  };
  return {
    ...op,
    path: sub(op.path),
    headers: Object.fromEntries(Object.entries(op.headers).map(([k, v]) => [k, sub(v)])),
    body: subDeep(op.body),
  };
}
