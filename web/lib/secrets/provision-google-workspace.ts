// Provision the GCP side of a client's Google Workspace integration: a dedicated project, the two
// APIs the runner needs (Admin SDK for directory operations, IAM for the service account itself),
// the `iam-engine` service account, and — only when nothing valid is already vaulted — a fresh JSON
// key. This is the Google analog of provision-m365-app.ts: same "never throw, {ok:false,...} on any
// terminal failure" contract, same injected-fetcher house style, same idempotent find-or-create
// shape so a retried run lands on the existing project/SA instead of minting a duplicate.
//
// Google's Cloud Resource Manager (v3) and Service Usage (v1) APIs are asynchronous: project create
// and API enablement each return a long-running Operation that must be polled until `done`. IAM's
// service-account and key endpoints are synchronous.
//
// Secret hygiene: a service account key's `privateKeyData` (the base64 JSON key) is the one piece of
// material Google returns exactly once and cannot be re-read later. It is placed ONLY in the success
// value's `keyBase64` field — never interpolated into an `error` string, never pushed onto `actions`,
// and never logged. Every error message here is built from Google's own `error.message` field (or a
// bare `HTTP {status}` fallback), never the raw response body, so a key accidentally echoed back in
// an unexpected error payload still can't leak through this module's error strings.

const CRM = "https://cloudresourcemanager.googleapis.com/v3";
const SERVICEUSAGE = "https://serviceusage.googleapis.com/v1";
const IAM = "https://iam.googleapis.com/v1";

const POLL_MAX_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5000;

export type CredState = "issued" | "kept-valid";

export type GoogleProvision = {
  projectId: string;
  saEmail: string; // iam-engine@{projectId}.iam.gserviceaccount.com
  saClientId: string; // numeric uniqueId
  credState: CredState;
  keyBase64?: string; // base64 of full JSON key — present iff credState === "issued"
  issuedKeyName?: string; // full resource name of the key we created (for rotate-cleanup by Task 7)
  actions: string[]; // human trail, NO secret material
};

// "ctg-iam-" + a lowercased, GCP-safe slug, capped at 30 chars (the Resource Manager project ID
// limit) with any trailing "-" left by truncation stripped — a project ID can't end in a hyphen.
export function projectIdForSlug(slug: string): string {
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  let id = `ctg-iam-${cleaned}`;
  if (id.length > 30) id = id.slice(0, 30);
  while (id.endsWith("-")) id = id.slice(0, -1);
  return id;
}

function serviceAccountEmail(projectId: string): string {
  return `iam-engine@${projectId}.iam.gserviceaccount.com`;
}

type CallResult = { status: number; body: Record<string, unknown> | null };

// JSON fetch with a bearer header. Never throws — a network/timeout exception comes back as
// status 0 so every caller can treat "unreachable" the same as any other non-2xx.
async function call(
  token: string,
  method: "GET" | "POST" | "DELETE",
  url: string,
  body: unknown,
  fetcher: typeof fetch
): Promise<CallResult> {
  try {
    const res = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, body: parsed };
  } catch (e) {
    return { status: 0, body: { error: { message: (e as Error).message } } };
  }
}

function ok2xx(r: CallResult): boolean {
  return r.status >= 200 && r.status < 300;
}

// Google's error shape is { error: { message, status, ... } }. Fall back to a bare HTTP status when
// the body doesn't have that — never surface the raw body (it could carry unexpected fields).
function googleErr(r: CallResult): string {
  const err = r.body?.error as { message?: unknown } | undefined;
  if (err && typeof err.message === "string" && err.message) return err.message;
  return `HTTP ${r.status}`;
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

// Poll a long-running Operation (Resource Manager or Service Usage — same {done, error, response}
// shape) until `done`, at most POLL_MAX_ATTEMPTS checks, POLL_INTERVAL_MS apart.
async function pollOperation(
  token: string,
  baseUrl: string,
  opName: string,
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>
): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const r = await call(token, "GET", `${baseUrl}/${opName}`, undefined, fetcher);
    if (ok2xx(r) && r.body?.done) {
      const opError = r.body.error as { message?: unknown } | undefined;
      if (opError) return { ok: false, error: typeof opError.message === "string" ? opError.message : "operation failed" };
      return { ok: true };
    }
    if (attempt < POLL_MAX_ATTEMPTS - 1) await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: "operation did not complete within the poll window" };
}

// find-or-create the GCP project. A 403 OR 404 on the read both mean "doesn't exist (yet)" — v3
// Resource Manager returns 403 for a project id that was never created just as often as 404.
async function ensureProject(
  token: string,
  projectId: string,
  slug: string,
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  actions: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const get = await call(token, "GET", `${CRM}/projects/${projectId}`, undefined, fetcher);
  if (ok2xx(get)) {
    actions.push(`found existing project ${projectId}`);
    return { ok: true };
  }
  if (get.status !== 403 && get.status !== 404) {
    return { ok: false, error: `read project: ${googleErr(get)}` };
  }

  const createBody: Record<string, unknown> = { projectId, displayName: `iam-engine ${slug}` };
  let create = await call(token, "POST", `${CRM}/projects`, createBody, fetcher);
  if (!ok2xx(create)) {
    const errMsg = googleErr(create);
    if (!/parent|organization/i.test(errMsg)) {
      return { ok: false, error: `create project: ${errMsg}` };
    }
    // Org policy requires a parent — look up the caller's organization and retry once with it.
    const orgs = await call(token, "GET", `${CRM}/organizations:search`, undefined, fetcher);
    const orgList = (orgs.body?.organizations as { name?: string }[] | undefined) ?? [];
    const parent = ok2xx(orgs) ? orgList[0]?.name : undefined;
    if (!parent) {
      return { ok: false, error: `create project (org-policy: ${errMsg}) and organizations:search found no parent` };
    }
    actions.push(`project create failed on org policy — retrying with parent ${parent}`);
    create = await call(token, "POST", `${CRM}/projects`, { ...createBody, parent }, fetcher);
    if (!ok2xx(create)) {
      return { ok: false, error: `create project (with parent): ${googleErr(create)}` };
    }
  }

  if (!create.body?.done) {
    const opName = create.body?.name;
    if (typeof opName !== "string" || !opName) {
      return { ok: false, error: "create project: no operation name returned" };
    }
    const poll = await pollOperation(token, CRM, opName, fetcher, sleep);
    if (!poll.ok) return { ok: false, error: `project create operation: ${poll.error}` };
  }
  actions.push(`created project ${projectId}`);
  return { ok: true };
}

// Enable the two APIs the runner needs: Admin SDK (directory operations) + IAM (the service account
// itself, e.g. key rotation later).
async function enableServices(
  token: string,
  projectId: string,
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  actions: string[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await call(
    token,
    "POST",
    `${SERVICEUSAGE}/projects/${projectId}/services:batchEnable`,
    { serviceIds: ["admin.googleapis.com", "iam.googleapis.com"] },
    fetcher
  );
  if (!ok2xx(res)) return { ok: false, error: `enable APIs: ${googleErr(res)}` };
  if (!res.body?.done) {
    const opName = res.body?.name;
    if (typeof opName === "string" && opName) {
      const poll = await pollOperation(token, SERVICEUSAGE, opName, fetcher, sleep);
      if (!poll.ok) return { ok: false, error: `enable APIs operation: ${poll.error}` };
    }
  }
  actions.push("enabled admin.googleapis.com + iam.googleapis.com");
  return { ok: true };
}

// find-or-create the iam-engine service account. A freshly-created SA can 404 on an immediate
// re-read (IAM's read-your-writes lag), so the create response — not a follow-up read — is treated
// as authoritative for uniqueId/email.
async function ensureServiceAccount(
  token: string,
  projectId: string,
  fetcher: typeof fetch,
  actions: string[]
): Promise<{ ok: true; email: string; uniqueId: string } | { ok: false; error: string }> {
  const email = serviceAccountEmail(projectId);
  const get = await call(token, "GET", `${IAM}/projects/${projectId}/serviceAccounts/${email}`, undefined, fetcher);
  if (ok2xx(get)) {
    actions.push(`found existing service account ${email}`);
    return { ok: true, email, uniqueId: String(get.body?.uniqueId ?? "") };
  }
  if (get.status !== 404) {
    return { ok: false, error: `read service account: ${googleErr(get)}` };
  }

  const create = await call(
    token,
    "POST",
    `${IAM}/projects/${projectId}/serviceAccounts`,
    { accountId: "iam-engine", serviceAccount: { displayName: "iam-engine (Coretelligent IAM)" } },
    fetcher
  );
  if (!ok2xx(create)) return { ok: false, error: `create service account: ${googleErr(create)}` };
  actions.push(`created service account ${email}`);
  return {
    ok: true,
    email: typeof create.body?.email === "string" ? create.body.email : email,
    uniqueId: String(create.body?.uniqueId ?? ""),
  };
}

// Mint a fresh JSON key. Only ever called when the caller has told us nothing valid is vaulted
// (needKey=true) — the reconcile decision itself lives with the caller (Task 7), not here.
async function createServiceAccountKey(
  token: string,
  projectId: string,
  email: string,
  fetcher: typeof fetch
): Promise<{ ok: true; keyBase64: string; name: string } | { ok: false; error: string }> {
  const res = await call(token, "POST", `${IAM}/projects/${projectId}/serviceAccounts/${email}/keys`, {}, fetcher);
  if (!ok2xx(res)) return { ok: false, error: `create service account key: ${googleErr(res)}` };
  const privateKeyData = res.body?.privateKeyData;
  const name = res.body?.name;
  if (typeof privateKeyData !== "string" || !privateKeyData || typeof name !== "string" || !name) {
    return { ok: false, error: "create service account key: response missing privateKeyData/name" };
  }
  return { ok: true, keyBase64: privateKeyData, name };
}

export async function provisionGoogleWorkspace(input: {
  accessToken: string;
  clientSlug: string;
  needKey: boolean;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: true; value: GoogleProvision } | { ok: false; error: string; actions: string[] }> {
  const token = input.accessToken;
  const fetcher = input.fetcher ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const actions: string[] = [];
  const projectId = projectIdForSlug(input.clientSlug);

  const project = await ensureProject(token, projectId, input.clientSlug, fetcher, sleep, actions);
  if (!project.ok) return { ok: false, error: project.error, actions };

  const services = await enableServices(token, projectId, fetcher, sleep, actions);
  if (!services.ok) return { ok: false, error: services.error, actions };

  const sa = await ensureServiceAccount(token, projectId, fetcher, actions);
  if (!sa.ok) return { ok: false, error: sa.error, actions };

  let credState: CredState = "kept-valid";
  let keyBase64: string | undefined;
  let issuedKeyName: string | undefined;
  if (input.needKey) {
    const key = await createServiceAccountKey(token, projectId, sa.email, fetcher);
    if (!key.ok) return { ok: false, error: key.error, actions };
    keyBase64 = key.keyBase64;
    issuedKeyName = key.name;
    credState = "issued";
    actions.push("issued a new service account key"); // never the key material itself
  } else {
    actions.push("kept existing service account key (nothing to rotate)");
  }

  return {
    ok: true,
    value: {
      projectId,
      saEmail: sa.email,
      saClientId: sa.uniqueId,
      credState,
      keyBase64,
      issuedKeyName,
      actions,
    },
  };
}

// Best-effort key cleanup (e.g. rotating out a superseded key). Returns a bare boolean — the caller
// already has its own actions/audit trail and just needs to know whether the delete landed.
export async function deleteServiceAccountKey(accessToken: string, keyName: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const res = await call(accessToken, "DELETE", `${IAM}/${keyName}`, undefined, fetcher);
  return ok2xx(res);
}
