// Phase 4 orchestration core: chain the already-built M365 auto-setup pieces (device-code Global-Admin
// auth -> Graph app-registration provisioning -> Delinea writeback) into one per-client run.
//
// This function is PURE and side-effect-free itself — every collaborator that touches the network, a
// runner job, or the database is injected via `deps`, so the whole chain (including the staged
// failure/WARN-surfacing logic) is unit-testable with no real Entra/Delinea/db. The real collaborators
// (startDeviceCode, pollDeviceCodeToken, provisionM365App, writeProvisionedM365App live in this same
// directory; hasGlobalAdminSecret/dispatchDeviceCodeJob/getJob are thin db/job wrappers a caller wires
// up — see the E4/E5 design spec for their real implementations, which are live-validated separately).
//
// setupM365ForClient runs STANDALONE, not from an existing onboarding/offboarding case: the one
// entra-devicecode browser job it needs still requires a CaseRequest FK, so `dispatchDeviceCodeJob` is
// expected to create a minimal synthetic one (action:"onboard", createdSource:"api") — that's the real
// impl's job, not this core's; this core only calls the dep and reads back `jobId`.
//
// Soft-failure handling: the runner's Invoke-CtgEntraDeviceCode ALWAYS reports Status='ok' even when
// the browser sign-in itself failed (MFA push/SMS not automatable, bad creds, GA login rejected) — the
// failure only shows up as a `WARN ...` line in the job's recorded result. So the device-code TOKEN
// poll is the primary success signal here; only when it fails do we look at the browser job's result
// for WARN lines to explain why, surfaced as `browserWarnings`.
//
// Never log or return a token, client secret, or certificate value — only step names, ids, and (for
// operator/manual fallback) the device-code user code + verification URL, which are not secrets.
import type { ProvisionResult } from "./provision-m365-app";
import type { WriteResult } from "./write-m365-app";

export type SetupClientInput = {
  id: string;
  slug: string;
  name: string;
  primaryDomain?: string | null;
  delineaFolderId?: string | null;
};

export type DeviceCodeStart =
  | { ok: true; deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }
  | { ok: false; error: string };

export type DeviceCodeToken = { ok: true; token: string } | { ok: false; error: string; code?: string };

export type ProvisionOutcome =
  | { ok: true; result: ProvisionResult }
  | { ok: false; error: string; actions: string[] };

export type SetupDeps = {
  startDeviceCode: (tenant: string) => Promise<DeviceCodeStart>;
  pollDeviceCodeToken: (
    tenant: string,
    deviceCode: string,
    opts: { intervalSeconds: number; expiresInSeconds: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
  ) => Promise<DeviceCodeToken>;
  provisionM365App: (input: {
    graphToken: string;
    tenantId: string;
    caps?: "required" | "required+optional";
    issueCreds?: boolean;
    forceReissue?: boolean;
  }) => Promise<ProvisionOutcome>;
  writeProvisionedM365App: (input: { client: SetupClientInput; provision: ProvisionResult; secretName?: string }) => Promise<WriteResult>;
  // db.secret.findUnique({ where: { clientId_name: { clientId, name: "m365-global-admin" } } }) !== null
  hasGlobalAdminSecret: (clientId: string) => Promise<boolean>;
  // Creates the synthetic CaseRequest + entra-devicecode Job. See the E4/E5 design spec for the real impl.
  // gaSecretRef (a Delinea externalId), when passed, is threaded onto the case's secretOverrides so the
  // job can broker the GA login WITHOUT a stored client secret.
  dispatchDeviceCodeJob: (client: SetupClientInput, userCode: string, gaSecretRef?: string) => Promise<{ jobId: string }>;
  getJob: (jobId: string) => Promise<{ status: string; result: unknown; error: string | null }>;
  sleep?: (ms: number) => Promise<void>;
};

export type SetupInput = {
  client: SetupClientInput;
  tenant: string;
  caps?: "required" | "required+optional";
  // A per-run Global-Admin login reference (a Delinea externalId) supplied via the modal — when set, the
  // override IS the eligibility, so the stored-secret check below is bypassed and nothing gets vaulted
  // on the client. Undefined on the fleet path, which still requires a stored m365-global-admin secret.
  gaSecretRef?: string;
};

export type SetupStage = "no-ga-secret" | "device-code-init" | "browser-signin" | "token" | "provision" | "write" | "done" | "error";

export type SetupResult = {
  ok: boolean;
  stage: SetupStage;
  appId?: string;
  // The Delinea secret id the credential was vaulted as / wired to — surfaced so the audit and run log
  // show WHICH vault entry to test. A reference, never a secret value.
  externalId?: string;
  wroteCreds?: boolean;
  verified?: boolean;
  gaps?: string[];
  userCode?: string;
  verificationUri?: string;
  error?: string;
  browserWarnings?: string[];
  actions: string[];
};

// A WARN "line" — trimmed, at the start of the string or right after a newline — matching the
// PowerShell modules' own convention ("WARN could not grant ...", "WARN MFA push not automatable ...").
// A plain substring match (the old behavior) false-positives on any value that merely CONTAINS the
// four letters "WARN" (e.g. a name/UPN like "Edward WARNock" or "forWARNs@x.com") — Finding 8.
const WARN_LINE = /(^|\n)\s*WARN\b/;

// Walks a job's recorded `result` (an opaque shape — the runner's Invoke-CtgEntraDeviceCode return
// value, arbitrary JSON) and pulls out every string that looks like a WARN line. Depth-bounded so a
// pathological/circular-looking shape can't spin forever.
export function extractWarnings(jobResult: unknown): string[] {
  const warnings: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 5) return;
    if (typeof v === "string") {
      if (WARN_LINE.test(v)) warnings.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val, depth + 1);
    }
  };
  visit(jobResult, 0);
  return warnings;
}

// Finding 9: every dep call must degrade to a structured SetupResult, never an uncaught throw — a
// network blip in any collaborator (a db query, a Graph call, a fetch) must not crash the case runner;
// it must come back as a normal ok:false result the caller can retry/report on like any other failure.
async function callDep<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: `${name} threw: ${(e as Error).message}` };
  }
}

export async function setupM365ForClient(input: SetupInput, deps: SetupDeps): Promise<SetupResult> {
  const { client, tenant } = input;
  const actions: string[] = [];

  // 1. Fail fast if there's no Global-Admin login for the runner's device-code broker to use — nothing
  // downstream can work without it, and this avoids minting a device code that will just expire unused.
  // A gaSecretRef (from the modal) bypasses this entirely — the override IS the eligibility, and there
  // may be no stored client secret at all (that's the point).
  if (!input.gaSecretRef) {
    actions.push(`checking for an m365-global-admin secret on ${client.slug}`);
    const hasGaR = await callDep("hasGlobalAdminSecret", () => deps.hasGlobalAdminSecret(client.id));
    if (!hasGaR.ok) {
      actions.push(`error checking for an m365-global-admin secret: ${hasGaR.error}`);
      return { ok: false, stage: "error", error: hasGaR.error, actions };
    }
    if (!hasGaR.value) {
      actions.push("no m365-global-admin secret found");
      return {
        ok: false,
        stage: "no-ga-secret",
        error: "client has no m365-global-admin Delinea secret; wire the GA login (UPN+password, OTP enabled) first",
        actions,
      };
    }
  }

  // 2. Mint the device code (userCode + deviceCode) directly against Microsoft — no browser involved yet.
  actions.push(`starting device-code flow for tenant ${tenant}`);
  const dcR = await callDep("startDeviceCode", () => deps.startDeviceCode(tenant));
  if (!dcR.ok) {
    actions.push(`device-code init errored: ${dcR.error}`);
    return { ok: false, stage: "error", error: dcR.error, actions };
  }
  const dc = dcR.value;
  if (!dc.ok) {
    actions.push(`device-code init failed: ${dc.error}`);
    return { ok: false, stage: "device-code-init", error: dc.error, actions };
  }

  // 3. Dispatch the browser job that drives the GA sign-in against the userCode we just minted.
  actions.push("dispatching entra-devicecode browser job");
  const dispatchR = await callDep("dispatchDeviceCodeJob", () => deps.dispatchDeviceCodeJob(client, dc.userCode, input.gaSecretRef));
  if (!dispatchR.ok) {
    actions.push(`dispatching the browser job errored: ${dispatchR.error}`);
    return { ok: false, stage: "error", error: dispatchR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
  }
  const { jobId } = dispatchR.value;
  actions.push(`browser job ${jobId} dispatched — waiting for Global Admin sign-in`);

  // 4. The token poll is the primary success signal (see file header) — poll it to completion.
  actions.push("polling for the device-code token");
  const tokenR = await callDep("pollDeviceCodeToken", () =>
    deps.pollDeviceCodeToken(tenant, dc.deviceCode, {
      intervalSeconds: dc.interval,
      expiresInSeconds: dc.expiresIn,
      sleep: deps.sleep,
    })
  );
  if (!tokenR.ok) {
    actions.push(`token poll errored: ${tokenR.error}`);
    return { ok: false, stage: "error", error: tokenR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
  }
  const tokenResult = tokenR.value;

  if (!tokenResult.ok) {
    actions.push(`token poll failed: ${tokenResult.error}`);
    // A soft-failed browser sign-in never surfaces as a token-poll error code — it's a WARN line buried
    // in the browser job's own recorded result. Best-effort: a failed/unreachable getJob must not mask
    // the real token-poll failure above, so any error here is swallowed.
    let browserWarnings: string[] = [];
    try {
      const job = await deps.getJob(jobId);
      browserWarnings = extractWarnings(job.result);
    } catch {
      // ignored — fall through with no warnings
    }
    if (browserWarnings.length > 0) actions.push(`browser job reported ${browserWarnings.length} warning(s)`);
    return {
      ok: false,
      stage: browserWarnings.length > 0 ? "browser-signin" : "token",
      error: tokenResult.error,
      browserWarnings: browserWarnings.length > 0 ? browserWarnings : undefined,
      userCode: dc.userCode,
      verificationUri: dc.verificationUri,
      actions,
    };
  }

  // 5. Have a Graph token carrying the GA's privileges — provision (or reconcile) the app registration.
  actions.push("obtained a Graph token — provisioning the app registration");
  const provR = await callDep("provisionM365App", () => deps.provisionM365App({ graphToken: tokenResult.token, tenantId: tenant, caps: input.caps }));
  if (!provR.ok) {
    actions.push(`provisioning errored: ${provR.error}`);
    return { ok: false, stage: "error", error: provR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
  }
  const prov = provR.value;
  if (!prov.ok) {
    actions.push(`provisioning failed: ${prov.error}`);
    return {
      ok: false,
      stage: "provision",
      error: prov.error,
      userCode: dc.userCode,
      verificationUri: dc.verificationUri,
      actions,
    };
  }
  actions.push(`app registration provisioned (appId ${prov.result.appId}, verified=${prov.result.verified})`);
  // Diagnostic WARN lines from provisioning (e.g. a role that couldn't be granted, a credential read
  // that failed) — surfaced below if the write fails, so an operator can see WHY instead of just that
  // it did. Never contains a secret value (ProvisionResult.actions never carries one).
  const provisionWarnings = extractWarnings(prov.result.actions);

  // 6. Write whatever new credential material this run issued back to Delinea (a "kept existing, still
  // valid" run writes nothing — see writeProvisionedM365App). writeProvisionedM365App itself refuses to
  // report ok:true unless the credential is genuinely present+valid (credState-aware — see Findings 1/3).
  actions.push("writing provisioned credentials to Delinea");
  const writeR = await callDep("writeProvisionedM365App", () => deps.writeProvisionedM365App({ client, provision: prov.result }));
  if (!writeR.ok) {
    actions.push(`writing to Delinea errored: ${writeR.error}`);
    for (const w of provisionWarnings) actions.push(w);
    return { ok: false, stage: "error", error: writeR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
  }
  // A success return shares this shape regardless of whether it came from the normal path or the
  // stranded-credential recovery path below — factored out so the two returns can't drift apart.
  const doneResult = (p: ProvisionResult, w: { wroteCreds: boolean; externalId?: string }): SetupResult => ({
    ok: true,
    stage: "done",
    appId: p.appId,
    externalId: w.externalId,
    wroteCreds: w.wroteCreds,
    verified: p.verified,
    gaps: p.gaps,
    userCode: dc.userCode,
    verificationUri: dc.verificationUri,
    actions,
  });

  const write = writeR.value;
  if (!write.ok) {
    actions.push(`Delinea write failed: ${write.error}`);
    // Surface WHY provisioning may have led here (e.g. a credential read that failed, a role that
    // couldn't be granted) so an operator isn't left staring at just the write error.
    for (const w of provisionWarnings) actions.push(w);
    if (write.warnings) for (const w of write.warnings) actions.push(w);

    if (write.stranded) {
      // 7. Auto-recover: the app registration already carries a still-valid secret (credState
      // "kept-valid") but nothing is vaulted for it — that prior secret value is unrecoverable, so the
      // only fix is to rotate a fresh one and vault THAT. Bounded to exactly ONE recovery attempt: if
      // it fails too, fall through to a normal failure rather than looping.
      actions.push("the app has a credential that was never vaulted — rotating a fresh secret");
      const recoverProvR = await callDep("provisionM365App", () =>
        deps.provisionM365App({ graphToken: tokenResult.token, tenantId: tenant, caps: input.caps, forceReissue: true })
      );
      if (!recoverProvR.ok) {
        actions.push(`recovery re-provisioning errored: ${recoverProvR.error}`);
        return { ok: false, stage: "error", error: recoverProvR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
      }
      const recoverProv = recoverProvR.value;
      if (!recoverProv.ok) {
        actions.push(`recovery re-provisioning failed: ${recoverProv.error}`);
        return { ok: false, stage: "provision", error: recoverProv.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
      }
      actions.push(`app registration re-provisioned with a freshly issued credential (appId ${recoverProv.result.appId})`);

      const recoverWriteR = await callDep("writeProvisionedM365App", () =>
        deps.writeProvisionedM365App({ client, provision: recoverProv.result })
      );
      if (!recoverWriteR.ok) {
        actions.push(`writing the rotated credential to Delinea errored: ${recoverWriteR.error}`);
        return { ok: false, stage: "error", error: recoverWriteR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
      }
      const recoverWrite = recoverWriteR.value;
      if (!recoverWrite.ok) {
        actions.push(`Delinea write failed after recovery: ${recoverWrite.error}`);
        if (recoverWrite.warnings) for (const w of recoverWrite.warnings) actions.push(w);
        return { ok: false, stage: "write", error: recoverWrite.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
      }
      actions.push(recoverWrite.wroteCreds ? `wrote the rotated credential to Delinea (secret ${recoverWrite.externalId ?? "?"})` : "no new credentials to write (kept existing, still valid)");
      if (recoverWrite.warnings) for (const w of recoverWrite.warnings) actions.push(w);
      return doneResult(recoverProv.result, recoverWrite);
    }

    return {
      ok: false,
      stage: "write",
      error: write.error,
      userCode: dc.userCode,
      verificationUri: dc.verificationUri,
      actions,
    };
  }
  // write.ok is only ever true when the credential is genuinely present+valid: either this run vaulted
  // a freshly issued one (wroteCreds:true), or provision's credState was "kept-valid" AND something was
  // already vaulted for this client (wroteCreds:false) — writeProvisionedM365App enforces both; there is
  // no other ok:true path (see Finding 1/3). So this message is never printed on an unverified/stranded
  // credential.
  actions.push(write.wroteCreds ? `wrote new credentials to Delinea (secret ${write.externalId ?? "?"})` : "no new credentials to write (kept existing, still valid)");
  if (write.warnings) for (const w of write.warnings) actions.push(w);

  return doneResult(prov.result, write);
}
