// Credential probe for the HAR import wizard: replay the capture's READ-ONLY calls with a real,
// brokered credential to learn — before anything is published — whether the captured (often
// private/undocumented) API accepts a stored credential at all, or is session-cookie-authed and
// needs the browser lane.
//
// Boundaries, in order of importance:
//   - GET/HEAD ONLY. The HAR was recorded while an admin performed a real task, so its POST/DELETE
//     calls DID something; replaying them against a live tenant would do it again. Unsafe methods
//     are dropped here, server-side, not merely unticked in the UI.
//   - Response BODIES are never read. A 200 from a client tenant carries client data; the probe's
//     entire product is the status code (+ content type), so that is all that comes back.
//   - Auth semantics mirror the runner's Get-CtgConnectorAuthHeaders exactly (bearer = the secret's
//     password field, basic = username:password, header = resolved valueTemplate, oauth2 = client
//     credentials grant with username/password as id/secret). A pass here means the published
//     connector WILL authenticate the same way.
//   - Probe targets are re-guarded against private networks (see assertProbeHost): the importer
//     already drops non-https, but an admin-typed host must not turn the app server into an
//     internal-network scanner.

import type { HttpDefinition } from "./definition";
import type { ImportedOperation } from "./import-har";

export type ProbeAuth = HttpDefinition["auth"];

export type ProbeOp = { name: string; method: string; host: string; path: string; headers: Record<string, string> };

export type ProbeOpResult = {
  name: string;
  method: string;
  host: string;
  path: string;
  status: number | null; // null = transport error (DNS, TLS, timeout)
  ok: boolean; // 2xx
  authRejected: boolean; // 401/403
  redirected: boolean; // 3xx — often a bounce to a login page, itself a session-auth tell
  contentType?: string;
  error?: string;
};

export type ProbeVerdict = "usable" | "auth-rejected" | "mixed" | "unreachable" | "nothing-probed";

// Delinea field names arrive exactly as Secret Server spells them ("Username", "Password"); the
// runner reads them case-insensitively (PSObject property lookup), so the probe must too.
export function fieldCI(fields: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(fields)) if (k.toLowerCase() === want) return v;
  return undefined;
}

// {{secret.<name>.<field>}} → the field's value, for the ONE declared secret. Any other template
// root is left untouched (the probe has no user/payload context and should not invent one).
export function resolveSecretTemplates(template: string, secretName: string, fields: Record<string, string>): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  // \w.- plus space: the definition validator allows spaces in template paths because Delinea field
  // names have them ("Api Key").
  const value = template.replace(/\{\{\s*secret\.([\w.\- ]+?)\s*\}\}/g, (whole, path: string) => {
    const segs = path.split(".");
    if (segs[0] !== secretName || segs.length < 2) { unresolved.push(whole); return whole; }
    const v = fieldCI(fields, segs.slice(1).join("."));
    if (v === undefined) { unresolved.push(whole); return whole; }
    return v;
  });
  return { value, unresolved };
}

export type ProbeFetcher = (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

// Mirror of the runner's Get-CtgConnectorAuthHeaders. Returns headers, or an error naming exactly
// what the wired secret is missing — the same message a published connector would fail with.
// `fetchImpl` exists for tests; only the oauth2 branch makes a network call.
export async function probeAuthHeaders(
  auth: ProbeAuth,
  fields: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): Promise<{ headers: Record<string, string> } | { error: string }> {
  const secretName = auth.secretName ?? "";
  switch (auth.type) {
    case "none":
      return { headers: {} };
    case "bearer": {
      const token = fieldCI(fields, "password");
      if (!token) return { error: `the secret has no password field to use as the bearer token` };
      return { headers: { Authorization: `Bearer ${token}` } };
    }
    case "basic": {
      const user = fieldCI(fields, "username");
      const pass = fieldCI(fields, "password");
      if (!user || !pass) return { error: `the secret needs username + password fields for basic auth` };
      return { headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` } };
    }
    case "header": {
      if (!auth.header || !auth.valueTemplate) return { error: "auth type 'header' needs auth.header and auth.valueTemplate" };
      const r = resolveSecretTemplates(auth.valueTemplate, secretName, fields);
      if (r.unresolved.length) return { error: `auth.valueTemplate references ${r.unresolved.join(", ")} which the secret does not carry` };
      return { headers: { [auth.header]: r.value } };
    }
    case "oauth2-client-credentials": {
      if (!auth.tokenUrl || !/^https:\/\//.test(auth.tokenUrl)) return { error: "auth.tokenUrl (https) is required for oauth2-client-credentials" };
      const clientId = fieldCI(fields, "username");
      const clientSecret = fieldCI(fields, "password");
      if (!clientId || !clientSecret) return { error: "the secret needs username (client id) + password (client secret) fields for the OAuth grant" };
      const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
      if (auth.scope) form.set("scope", auth.scope);
      try {
        const res = await fetchImpl(auth.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status >= 300) return { error: `OAuth token request failed (HTTP ${res.status}) — check the wired client id/secret` };
        const tok = (await res.json().catch(() => null)) as { access_token?: string } | null;
        if (!tok?.access_token) return { error: "OAuth token response had no access_token" };
        return { headers: { Authorization: `Bearer ${tok.access_token}` } };
      } catch (e) {
        return { error: `OAuth token request failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    default:
      return { error: `unknown auth type '${String((auth as { type?: unknown }).type)}'` };
  }
}

// Only these are replayed — see the module header. Everything else is reported as skipped by name so
// "probed clean" can never be read as "the whole capture was exercised".
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function splitSafeOps(ops: readonly ImportedOperation[]): { safe: ProbeOp[]; skippedUnsafe: string[] } {
  const safe: ProbeOp[] = [];
  const skippedUnsafe: string[] = [];
  for (const o of ops) {
    if (SAFE_METHODS.has(o.method.toUpperCase())) {
      safe.push({ name: o.suggestedName, method: o.method.toUpperCase(), host: o.host, path: o.path, headers: o.headers });
    } else {
      skippedUnsafe.push(`${o.method} ${o.suggestedName}`);
    }
  }
  return { safe, skippedUnsafe };
}

// The private-network guard. The runner's allowlist protects published connectors; the probe runs
// on the APP server before any allowlist exists, so it must refuse to be pointed inward — at the
// DB host, a metadata endpoint, or anything else best reached from where this process sits.
const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];
export function isPrivateAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd")) return true; // link-local / ULA
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return PRIVATE_V4.some((re) => re.test(v4));
}

export type Resolver = (host: string) => Promise<string[]>;

// Throws with a reason when a host must not be probed. A literal IP is refused outright (a real
// vendor API has a name); a name is DNS-resolved and every address checked, so a public name that
// CNAMEs into RFC1918 space is caught too.
export async function assertProbeHost(host: string, resolve: Resolver): Promise<void> {
  const h = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h) || h.length === 0) throw new Error(`'${host}' is not a valid hostname`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) throw new Error(`'${host}' is a literal IP — the probe only calls named https hosts`);
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    throw new Error(`'${host}' is a local/internal name — the probe only calls public vendor hosts`);
  }
  let addrs: string[];
  try {
    addrs = await resolve(h);
  } catch {
    throw new Error(`'${host}' did not resolve — is the capture from an internal-only portal?`);
  }
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new Error(`'${host}' resolves to a private address (${bad}) — the probe will not call into a private network`);
}

// Replay the safe ops, sequentially and gently. Statuses only; bodies are never read.
export async function runProbe(ops: readonly ProbeOp[], authHeaders: Record<string, string>, fetcher: ProbeFetcher): Promise<ProbeOpResult[]> {
  const out: ProbeOpResult[] = [];
  for (const op of ops) {
    const url = `https://${op.host}${op.path.startsWith("/") ? "" : "/"}${op.path}`;
    const base: Omit<ProbeOpResult, "status" | "ok" | "authRejected" | "redirected"> = { name: op.name, method: op.method, host: op.host, path: op.path };
    try {
      const res = await fetcher(url, {
        method: op.method,
        headers: { accept: "application/json", ...op.headers, ...authHeaders },
        redirect: "manual", // mirror the runner's MaximumRedirection 0 — never chase a 3xx anywhere
        signal: AbortSignal.timeout(15_000),
      });
      out.push({
        ...base,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        authRejected: res.status === 401 || res.status === 403,
        redirected: res.status >= 300 && res.status < 400,
        contentType: res.headers.get("content-type")?.split(";")[0],
      });
    } catch (e) {
      out.push({ ...base, status: null, ok: false, authRejected: false, redirected: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

// The sentence the admin came for. "auth-rejected" and "redirect-to-somewhere" both usually mean the
// portal authenticates with a browser session, which is exactly when the browser lane (or a future
// browser-login hybrid) is the right build.
export function probeVerdict(results: readonly ProbeOpResult[]): { verdict: ProbeVerdict; note: string } {
  if (results.length === 0) return { verdict: "nothing-probed", note: "no GET/HEAD operations to probe — the capture is all writes; probe cannot safely replay those" };
  const ok = results.filter((r) => r.ok).length;
  const rejected = results.filter((r) => r.authRejected || r.redirected).length;
  const dead = results.filter((r) => r.status === null).length;
  if (dead === results.length) return { verdict: "unreachable", note: "no endpoint answered — check the host and that the API is reachable from the app server" };
  if (ok > 0 && rejected === 0) return { verdict: "usable", note: `${ok}/${results.length} endpoints accepted the credential — this private API works with a stored credential; build it as an http connector` };
  if (ok === 0 && rejected > 0) {
    return { verdict: "auth-rejected", note: "every endpoint rejected or redirected the request — this API is likely session-cookie-authed (login happens in the browser); use the browser lane, or a browser-login hybrid" };
  }
  if (ok > 0) return { verdict: "mixed", note: `${ok}/${results.length} endpoints accepted the credential; the rest rejected it — some captured calls may belong to a different auth realm (tick fewer hosts, or check the rejected paths)` };
  return { verdict: "mixed", note: "no endpoint accepted the credential and none returned a clear auth rejection — check the statuses per endpoint" };
}
