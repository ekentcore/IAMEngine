// Connector definition schema + validation (docs/CONNECTOR_BUILDER.md).
//
// Definitions are DATA the runner interprets, so validation is the security boundary: everything
// fails closed (unknown fields, unknown step types, missing host allowlist), and the same rules run
// again runner-side before execution. Keep this file dependency-free — the runner's PowerShell
// validator mirrors it and the two must stay easy to diff.

export const CONNECTOR_KEY_PREFIX = "custom-";
export const CONNECTOR_KINDS = ["http", "browser"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
// "browser-session" is the hybrid: a headless browser performs the portal login (username/password,
// optional TOTP), the resulting session (a named cookie set, or a token stashed in localStorage) is
// harvested, and every http operation then runs with it. It exists for portals with a real
// underlying API that is authenticated by a browser session rather than a static credential — the
// case the HAR-import credential probe surfaces as "auth-rejected / redirected to login".
export const AUTH_TYPES = ["bearer", "basic", "header", "oauth2-client-credentials", "browser-session", "none"] as const;
// How a harvested browser session is attached to http requests.
export const SESSION_APPLY_MODES = ["cookie", "bearer", "header"] as const;
export const LANES = ["test", "onboard", "offboard"] as const;
export type ConnectorLane = (typeof LANES)[number];

export const BROWSER_STEP_TYPES = [
  "goto", "fill", "click", "press", "select", "waitFor", "expect", "totp", "sleep", "screenshot",
] as const;
// Exactly ONE of these identifies a browser step's target element.
export const BROWSER_TARGET_KEYS = ["css", "role", "label", "placeholder", "text", "testId"] as const;

// Template roots a {{…}} placeholder may resolve against. `def` lets a browser step reference
// definition fields (e.g. {{def.startUrl}}); `secret` is followed by a name + field path.
const TEMPLATE_ROOTS = ["user", "payload", "config", "secret", "vars", "client", "def"];

export type HttpOperation = {
  request: { method: (typeof HTTP_METHODS)[number]; path: string; headers?: Record<string, string>; body?: unknown };
  expect?: { status?: number[]; path?: string; equals?: unknown; exists?: boolean };
  extract?: Record<string, string>;
};

export type LaneStep = {
  op?: string;
  when?: string;
  skipWhen?: string;
  warnWhen?: string;
  failWhen?: string;
  message?: string;
  optional?: boolean;
};

// How the browser-session login harvests the session after signing in: capture one or more named
// cookies, OR read a token from a localStorage key. Exactly one mechanism.
export type SessionHarvest = { cookies?: string[]; storageKey?: string };
// How the harvested session attaches to http requests: as a Cookie header (needs harvest.cookies),
// as Authorization: Bearer <token>, or under a custom header. bearer/header take the token from
// storageKey, or from a single harvested cookie.
export type SessionApply = { as: (typeof SESSION_APPLY_MODES)[number]; header?: string };

export type ConnectorAuth = {
  type: (typeof AUTH_TYPES)[number];
  secretName?: string;
  header?: string;
  valueTemplate?: string;
  tokenUrl?: string;
  scope?: string;
  // browser-session only:
  login?: BrowserStep[];
  harvest?: SessionHarvest;
  apply?: SessionApply;
};

export type HttpDefinition = {
  version: 1;
  kind: "http";
  baseUrl: string;
  hosts: string[];
  auth: ConnectorAuth;
  defaults?: { headers?: Record<string, string> };
  operations: Record<string, HttpOperation>;
  lanes: Partial<Record<ConnectorLane, LaneStep[]>>;
};

export type BrowserStep = {
  type: (typeof BROWSER_STEP_TYPES)[number];
  url?: string;
  target?: Partial<Record<(typeof BROWSER_TARGET_KEYS)[number], string>> & { name?: string };
  value?: string;
  secret?: boolean;
  timeoutMs?: number;
  ms?: number;
  label?: string;
};

export type BrowserDefinition = {
  version: 1;
  kind: "browser";
  startUrl: string;
  hosts?: string[]; // extra hosts navigation may reach; startUrl's host is always allowed
  credentials: { secretName: string };
  lanes: Partial<Record<ConnectorLane, BrowserStep[]>>;
};

export type ConnectorDefinition = HttpDefinition | BrowserDefinition;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

// A dotted-path condition: `vars.userId`, `!config.license`. Deliberately not an expression language.
const CONDITION_RE = /^!?[a-zA-Z_][\w-]*(\.[\w-]+)*$/;
// A template placeholder body: root(.segment)*, segments allow indexes ("results.0.id").
const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function checkTemplates(value: string, where: string, errors: string[], allowedSecret: (name: string) => boolean, secretForm: "http" | "browser" = "http") {
  for (const m of value.matchAll(PLACEHOLDER_RE)) {
    const path = m[1];
    const segs = path.split(".");
    const root = segs[0];
    if (!TEMPLATE_ROOTS.includes(root)) {
      errors.push(`${where}: template {{${path}}} uses unknown root "${root}" (allowed: ${TEMPLATE_ROOTS.join(", ")})`);
      continue;
    }
    if (!/^[\w!.\- ]+$/.test(path) || segs.some((s) => s.length === 0)) {
      errors.push(`${where}: template {{${path}}} is malformed`);
    }
    if (root === "secret") {
      if (secretForm === "http") {
        // http requires {{secret.<name>.<field>}} — a declared name AND a field. A two-segment
        // {{secret.<name>}} used to slip through (the name check only fired at length>=3), leaving
        // the runner nothing to resolve.
        if (segs.length < 3) {
          errors.push(`${where}: template {{${path}}} must be secret.<name>.<field> (a declared secret name and a field)`);
        } else if (!allowedSecret(segs[1])) {
          errors.push(`${where}: template {{${path}}} references secret "${segs[1]}" which the definition does not declare`);
        }
      } else {
        // browser addresses THE one portal secret: {{secret.username}} / {{secret.password}} (2 segs).
        if (segs.length < 2) errors.push(`${where}: template {{${path}}} must name a secret field`);
      }
    }
  }
}

function checkCondition(cond: unknown, where: string, errors: string[]) {
  if (cond === undefined) return;
  if (!isString(cond) || !CONDITION_RE.test(cond)) {
    errors.push(`${where}: condition must be a dotted path with optional leading "!" (got ${JSON.stringify(cond)})`);
  }
}

// Every string anywhere in a request body/header gets template-checked.
function walkStrings(v: unknown, where: string, errors: string[], allowedSecret: (n: string) => boolean, depth = 0) {
  if (depth > 8) { errors.push(`${where}: body nests deeper than 8 levels`); return; }
  if (isString(v)) return checkTemplates(v, where, errors, allowedSecret);
  if (Array.isArray(v)) return v.forEach((x, i) => walkStrings(x, `${where}[${i}]`, errors, allowedSecret, depth + 1));
  if (isRecord(v)) return Object.entries(v).forEach(([k, x]) => walkStrings(x, `${where}.${k}`, errors, allowedSecret, depth + 1));
}

export function validateConnectorKey(key: unknown): string | null {
  if (!isString(key) || !/^custom-[a-z0-9][a-z0-9-]{1,48}$/.test(key)) {
    return `key must match custom-<slug> (lowercase letters/digits/dashes, 2–49 chars after "${CONNECTOR_KEY_PREFIX}")`;
  }
  return null;
}

// Logical secret names follow the existing Secret.name shape (kebab case).
const SECRET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

function validateHttp(def: Record<string, unknown>, errors: string[]) {
  const baseUrl = def.baseUrl;
  if (!isString(baseUrl) || !/^https:\/\//.test(baseUrl)) errors.push("baseUrl must be an https:// URL");
  const hosts = def.hosts;
  if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((h) => isString(h) && /^[a-z0-9.-]+$/i.test(h))) {
    errors.push("hosts must be a non-empty array of hostnames — it is the request allowlist");
  } else if (isString(baseUrl)) {
    try {
      const base = new URL(baseUrl).hostname.toLowerCase();
      if (!hosts.map((h) => String(h).toLowerCase()).includes(base)) errors.push(`hosts must include the baseUrl host (${base})`);
    } catch { errors.push("baseUrl is not a valid URL"); }
  }

  const auth = def.auth;
  const declaredSecrets = new Set<string>();
  if (!isRecord(auth) || !AUTH_TYPES.includes(auth.type as (typeof AUTH_TYPES)[number])) {
    errors.push(`auth.type must be one of ${AUTH_TYPES.join(", ")}`);
  } else {
    if (auth.type !== "none") {
      if (!isString(auth.secretName) || !SECRET_NAME_RE.test(auth.secretName)) {
        errors.push("auth.secretName is required (kebab-case logical secret name)");
      } else declaredSecrets.add(auth.secretName);
    }
    if (auth.type === "header") {
      // The runner hard-requires BOTH; validating only auth.header let an incomplete definition
      // publish and then fail on every job.
      if (!isString(auth.header)) errors.push("auth.header is required for type=header");
      if (!isString(auth.valueTemplate)) errors.push("auth.valueTemplate is required for type=header");
    }
    if (auth.type === "browser-session") {
      validateBrowserSession(auth, hosts, errors);
    }
    if (auth.type === "oauth2-client-credentials") {
      if (!isString(auth.tokenUrl) || !/^https:\/\//.test(auth.tokenUrl)) {
        errors.push("auth.tokenUrl (https) is required for oauth2-client-credentials");
      } else if (Array.isArray(hosts)) {
        // The tokenUrl receives the brokered client secret, so its host must be in the allowlist —
        // the runner enforces this too, but reject it at save so it can never publish.
        try {
          const th = new URL(auth.tokenUrl).hostname.toLowerCase();
          if (!hosts.map((h) => String(h).toLowerCase()).includes(th)) {
            errors.push(`auth.tokenUrl host (${th}) must be listed in hosts — it receives the client secret`);
          }
        } catch { errors.push("auth.tokenUrl is not a valid URL"); }
      }
    }
  }
  const allowedSecret = (n: string) => declaredSecrets.has(n);
  // The header valueTemplate is a template too — check its roots/secrets like any other string.
  if (isRecord(auth) && auth.type === "header" && isString(auth.valueTemplate)) {
    checkTemplates(auth.valueTemplate, "auth.valueTemplate", errors, allowedSecret);
  }
  // defaults.headers values are resolved as templates by the runner — validate them at save too, so
  // the "same rules at save and on the runner" invariant holds (an undeclared secret here would
  // otherwise publish and only fail at runtime).
  const defaultHeaders = isRecord(def.defaults) ? def.defaults.headers : undefined;
  if (defaultHeaders !== undefined) {
    if (!isRecord(defaultHeaders) || !Object.values(defaultHeaders).every(isString)) {
      errors.push("defaults.headers must be string→string");
    } else {
      for (const [k, v] of Object.entries(defaultHeaders)) checkTemplates(String(v), `defaults.headers.${k}`, errors, allowedSecret);
    }
  }

  const ops = def.operations;
  const opNames = new Set<string>();
  if (!isRecord(ops) || Object.keys(ops).length === 0) {
    errors.push("operations must be a non-empty object");
  } else {
    for (const [name, raw] of Object.entries(ops)) {
      const where = `operations.${name}`;
      if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(name)) { errors.push(`${where}: operation names are kebab-case slugs`); continue; }
      opNames.add(name);
      if (!isRecord(raw) || !isRecord(raw.request)) { errors.push(`${where}: missing request`); continue; }
      const r = raw.request;
      if (!HTTP_METHODS.includes(r.method as (typeof HTTP_METHODS)[number])) errors.push(`${where}: request.method must be one of ${HTTP_METHODS.join(", ")}`);
      if (!isString(r.path)) errors.push(`${where}: request.path is required`);
      else {
        checkTemplates(r.path, `${where}.request.path`, errors, allowedSecret);
        // A path may be relative to baseUrl or absolute — but an absolute URL still has to hit an
        // allowlisted host. The runner re-checks the RESOLVED url, but reject it at SAVE too (matching
        // the tokenUrl rule) so a foreign-host operation can never publish. Skip the host check only
        // when the host portion itself carries a template — then it can't be resolved statically and
        // the runner's allowlist is the enforcement point.
        if (/^https?:/i.test(r.path)) {
          if (!/^https:/i.test(r.path)) errors.push(`${where}: absolute request.path must be https`);
          else if (Array.isArray(hosts) && !/^https:\/\/[^/]*\{\{/.test(r.path)) {
            try {
              const ph = new URL(r.path).hostname.toLowerCase();
              if (!hosts.map((h) => String(h).toLowerCase()).includes(ph)) {
                errors.push(`${where}: request.path host (${ph}) is not in the connector's hosts allowlist`);
              }
            } catch { errors.push(`${where}: request.path is not a valid absolute URL`); }
          }
        }
      }
      if (r.headers !== undefined) {
        if (!isRecord(r.headers) || !Object.values(r.headers).every(isString)) errors.push(`${where}: request.headers must be string→string`);
        else walkStrings(r.headers, `${where}.request.headers`, errors, allowedSecret);
      }
      if (r.body !== undefined) walkStrings(r.body, `${where}.request.body`, errors, allowedSecret);
      if (raw.expect !== undefined) {
        if (!isRecord(raw.expect)) errors.push(`${where}: expect must be an object`);
        else {
          const st = raw.expect.status;
          if (st !== undefined && (!Array.isArray(st) || !st.every((s) => Number.isInteger(s) && s >= 100 && s <= 599))) {
            errors.push(`${where}: expect.status must be an array of HTTP status codes`);
          }
          if (raw.expect.path !== undefined && !isString(raw.expect.path)) errors.push(`${where}: expect.path must be a dotted path string`);
        }
      }
      if (raw.extract !== undefined) {
        if (!isRecord(raw.extract) || !Object.entries(raw.extract).every(([k, v]) => /^[a-zA-Z_]\w*$/.test(k) && isString(v))) {
          errors.push(`${where}: extract must map var names to dotted response paths`);
        }
      }
    }
  }

  const lanes = def.lanes;
  if (!isRecord(lanes) || !LANES.some((l) => Array.isArray(lanes[l]) && (lanes[l] as unknown[]).length > 0)) {
    errors.push(`lanes must define at least one of ${LANES.join(", ")}`);
  } else {
    for (const lane of Object.keys(lanes)) {
      if (!LANES.includes(lane as ConnectorLane)) { errors.push(`lanes.${lane}: unknown lane`); continue; }
      const steps = lanes[lane];
      if (!Array.isArray(steps)) { errors.push(`lanes.${lane} must be an array`); continue; }
      steps.forEach((s, i) => {
        const where = `lanes.${lane}[${i}]`;
        if (!isRecord(s)) return errors.push(`${where}: must be an object`);
        const hasOp = s.op !== undefined;
        const hasAssert = s.warnWhen !== undefined || s.failWhen !== undefined;
        if (!hasOp && !hasAssert) return errors.push(`${where}: needs an "op" or a warnWhen/failWhen assertion`);
        if (hasOp && (!isString(s.op) || !opNames.has(s.op))) errors.push(`${where}: unknown operation "${String(s.op)}"`);
        for (const c of ["when", "skipWhen", "warnWhen", "failWhen"] as const) checkCondition(s[c], `${where}.${c}`, errors);
        if (s.message !== undefined) {
          if (!isString(s.message)) errors.push(`${where}: message must be a string`);
          // The runner resolves templates in a step message (warnWhen/failWhen) — validate them here too.
          else checkTemplates(s.message, `${where}.message`, errors, allowedSecret);
        }
      });
    }
  }
  return declaredSecrets;
}

// One browser step, validated. Shared by browser-connector lanes AND browser-session login steps —
// the vocabulary and the "exactly one target key" / template rules are identical, so they must not
// drift. `allowedSecret` is the browser form ({{secret.username}}/{{secret.password}}).
function validateBrowserStep(s: unknown, where: string, errors: string[], allowedSecret: (n: string) => boolean) {
  if (!isRecord(s)) return errors.push(`${where}: must be an object`);
  const type = s.type as (typeof BROWSER_STEP_TYPES)[number];
  if (!BROWSER_STEP_TYPES.includes(type)) return errors.push(`${where}: unknown step type "${String(s.type)}"`);
  const needsTarget = ["fill", "click", "press", "select", "waitFor", "expect", "totp"].includes(type);
  if (needsTarget) {
    const t = s.target;
    const keys = isRecord(t) ? BROWSER_TARGET_KEYS.filter((k) => t[k] !== undefined) : [];
    if (keys.length !== 1) errors.push(`${where}: target must set exactly one of ${BROWSER_TARGET_KEYS.join(", ")}`);
    else if (!isString((t as Record<string, unknown>)[keys[0]])) errors.push(`${where}: target.${keys[0]} must be a string`);
    if (isRecord(t) && t.name !== undefined && !isString(t.name)) errors.push(`${where}: target.name must be a string`);
  }
  if (type === "goto") {
    if (!isString(s.url)) errors.push(`${where}: goto needs a url`);
    else checkTemplates(s.url, `${where}.url`, errors, allowedSecret, "browser");
  }
  if ((type === "fill" || type === "select" || type === "press") && !isString(s.value)) {
    errors.push(`${where}: ${type} needs a value`);
  }
  if (isString(s.value)) checkTemplates(s.value, `${where}.value`, errors, allowedSecret, "browser");
  if (type === "sleep" && (!Number.isInteger(s.ms) || (s.ms as number) < 0 || (s.ms as number) > 60_000)) {
    errors.push(`${where}: sleep.ms must be 0–60000`);
  }
  if (s.timeoutMs !== undefined && (!Number.isInteger(s.timeoutMs) || (s.timeoutMs as number) < 100 || (s.timeoutMs as number) > 120_000)) {
    errors.push(`${where}: timeoutMs must be 100–120000`);
  }
}

// A browser-session auth block on an http connector: login steps + how to harvest the session + how
// to apply it. `hosts` is the http allowlist the login's goto steps must also stay within — enforced
// on the runner (every navigation re-asserts the allowlist), but a statically-resolvable off-allowlist
// login URL is rejected here too, matching the tokenUrl/absolute-path rules.
function validateBrowserSession(auth: Record<string, unknown>, hosts: unknown, errors: string[]) {
  if (!isString(auth.secretName) || !SECRET_NAME_RE.test(auth.secretName)) {
    errors.push("auth.secretName is required for browser-session (the portal login secret)");
  }
  const login = auth.login;
  if (!Array.isArray(login) || login.length === 0) {
    errors.push("auth.login must be a non-empty array of browser steps that sign in");
  } else if (login.length > 100) {
    errors.push("auth.login has more than 100 steps");
  } else {
    // The login addresses the ONE portal secret as {{secret.username}}/{{secret.password}} — same as
    // a browser connector; any secret.* path is fine.
    login.forEach((s, i) => validateBrowserStep(s, `auth.login[${i}]`, errors, () => true));
    // A statically-resolvable login goto host must be allowlisted (the runner re-checks every nav).
    const hostList = Array.isArray(hosts) ? hosts.map((h) => String(h).toLowerCase()) : [];
    for (const [i, s] of login.entries()) {
      if (isRecord(s) && s.type === "goto" && isString(s.url) && /^https:\/\/[^/]*[^{]/.test(s.url) && !/\{\{/.test(new URL(s.url.replace(/\{\{[^}]*\}\}/g, "x")).host)) {
        try {
          const h = new URL(s.url).hostname.toLowerCase();
          if (hostList.length && !hostList.includes(h)) errors.push(`auth.login[${i}]: goto host (${h}) is not in the connector's hosts allowlist`);
        } catch { /* a templated URL can't be resolved statically — the runner allowlist covers it */ }
      }
    }
  }
  const harvest = auth.harvest;
  let hasCookies = false;
  let hasStorage = false;
  let cookieCount = 0;
  if (!isRecord(harvest)) {
    errors.push("auth.harvest is required (either cookies: [names] or storageKey: name)");
  } else {
    if (harvest.cookies !== undefined) {
      if (!Array.isArray(harvest.cookies) || harvest.cookies.length === 0 || !harvest.cookies.every((c) => isString(c) && c.length > 0)) {
        errors.push("auth.harvest.cookies must be a non-empty array of cookie names");
      } else { hasCookies = true; cookieCount = harvest.cookies.length; }
    }
    if (harvest.storageKey !== undefined) {
      if (!isString(harvest.storageKey) || !harvest.storageKey) errors.push("auth.harvest.storageKey must be a localStorage key name");
      else hasStorage = true;
    }
    if (hasCookies && hasStorage) errors.push("auth.harvest: set cookies OR storageKey, not both");
    if (!hasCookies && !hasStorage) errors.push("auth.harvest must set cookies (names) or storageKey");
  }
  const apply = auth.apply;
  if (!isRecord(apply) || !SESSION_APPLY_MODES.includes(apply.as as (typeof SESSION_APPLY_MODES)[number])) {
    errors.push(`auth.apply.as must be one of ${SESSION_APPLY_MODES.join(", ")}`);
  } else {
    if (apply.as === "cookie" && !hasCookies) errors.push("auth.apply.as='cookie' needs auth.harvest.cookies (there is nothing to send as a Cookie header otherwise)");
    if (apply.as === "header" && (!isString(apply.header) || !apply.header)) errors.push("auth.apply.as='header' needs auth.apply.header (the header name)");
    // bearer/header send ONE token — from storageKey, or a single harvested cookie. Multiple cookies
    // with bearer/header is ambiguous: which one is the token?
    if ((apply.as === "bearer" || apply.as === "header") && cookieCount > 1) {
      errors.push(`auth.apply.as='${apply.as}' takes a single token, but harvest.cookies lists ${cookieCount} — use storageKey, or harvest one cookie`);
    }
  }
}

function validateBrowser(def: Record<string, unknown>, errors: string[]) {
  const startUrl = def.startUrl;
  if (!isString(startUrl) || !/^https:\/\//.test(startUrl)) errors.push("startUrl must be an https:// URL");
  if (def.hosts !== undefined && (!Array.isArray(def.hosts) || !def.hosts.every((h) => isString(h) && /^[a-z0-9.-]+$/i.test(h)))) {
    errors.push("hosts must be an array of hostnames");
  }
  const creds = def.credentials;
  const declaredSecrets = new Set<string>();
  if (!isRecord(creds) || !isString(creds.secretName) || !SECRET_NAME_RE.test(creds.secretName)) {
    errors.push("credentials.secretName is required (kebab-case logical secret name)");
  } else declaredSecrets.add(creds.secretName);
  // Browser templates address THE portal secret as {{secret.username}} / {{secret.password}} —
  // any secret.* path is fine here; there is only one secret it can mean.
  const allowedSecret = () => true;

  const lanes = def.lanes;
  if (!isRecord(lanes) || !LANES.some((l) => Array.isArray(lanes[l]) && (lanes[l] as unknown[]).length > 0)) {
    errors.push(`lanes must define at least one of ${LANES.join(", ")}`);
    return declaredSecrets;
  }
  for (const lane of Object.keys(lanes)) {
    if (!LANES.includes(lane as ConnectorLane)) { errors.push(`lanes.${lane}: unknown lane`); continue; }
    const steps = lanes[lane];
    if (!Array.isArray(steps)) { errors.push(`lanes.${lane} must be an array`); continue; }
    if (steps.length > 100) errors.push(`lanes.${lane}: more than 100 steps`);
    steps.forEach((s, i) => validateBrowserStep(s, `lanes.${lane}[${i}]`, errors, allowedSecret));
  }
  return declaredSecrets;
}

export type ValidationResult = { ok: boolean; errors: string[]; secretNames: string[] };

// Validate a definition. Fail-closed: anything not recognized is an error, never ignored.
export function validateConnectorDefinition(kind: unknown, definition: unknown): ValidationResult {
  const errors: string[] = [];
  if (!CONNECTOR_KINDS.includes(kind as ConnectorKind)) errors.push(`kind must be one of ${CONNECTOR_KINDS.join(", ")}`);
  if (!isRecord(definition)) return { ok: false, errors: [...errors, "definition must be an object"], secretNames: [] };
  if (definition.version !== 1) errors.push("definition.version must be 1");
  if (definition.kind !== kind) errors.push(`definition.kind must match the connector kind (${String(kind)})`);

  let secrets = new Set<string>();
  if (kind === "http") secrets = validateHttp(definition, errors);
  else if (kind === "browser") secrets = validateBrowser(definition, errors);

  return { ok: errors.length === 0, errors, secretNames: [...secrets].sort() };
}

// Does running this connector need the Node/Playwright browser harness? True for every browser-kind
// connector, AND for an http connector whose auth is browser-session (it opens a headless browser to
// sign in before any http call). The claim gate uses this to withhold such connectors from an agent
// that doesn't report the "browser" capability — an http connector is no longer proof of "no browser
// needed". Tolerant of a raw JSON definition (unknown shape) so the claim path can call it on the
// stored `definition` column.
export function connectorNeedsBrowser(kind: unknown, definition: unknown): boolean {
  if (kind === "browser") return true;
  if (kind !== "http") return false;
  const auth = isRecord(definition) ? definition.auth : undefined;
  return isRecord(auth) && auth.type === "browser-session";
}

// Which lanes a definition actually defines — drives SystemCatalog supports flags on publish.
export function definedLanes(definition: ConnectorDefinition): { onboard: boolean; offboard: boolean; test: boolean } {
  const lanes = (definition.lanes ?? {}) as Record<string, unknown[]>;
  const has = (l: string) => Array.isArray(lanes[l]) && lanes[l].length > 0;
  return { onboard: has("onboard"), offboard: has("offboard"), test: has("test") };
}
