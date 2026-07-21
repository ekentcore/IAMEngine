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
    opts: { intervalSeconds: number; expiresInSeconds: number; sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal }
  ) => Promise<DeviceCodeToken>;
  provisionM365App: (input: {
    graphToken: string;
    tenantId: string;
    caps?: "required" | "required+optional";
    issueCreds?: boolean;
    forceReissue?: boolean;
    optionalRoles?: string[];
    issueCert?: boolean;
    certDays?: number;
    grantExchange?: boolean;
  }) => Promise<ProvisionOutcome>;
  writeProvisionedM365App: (input: { client: SetupClientInput; provision: ProvisionResult; secretName?: string; expectCert?: boolean; gaSecretRef?: string }) => Promise<WriteResult>;
  // db.secret.findUnique({ where: { clientId_name: { clientId, name: "m365-global-admin" } } }) !== null
  hasGlobalAdminSecret: (clientId: string) => Promise<boolean>;
  // Creates the synthetic CaseRequest + entra-devicecode Job. See the E4/E5 design spec for the real impl.
  // gaSecretRef (a Delinea externalId), when passed, is threaded onto the case's secretOverrides so the
  // job can broker the GA login WITHOUT a stored client secret.
  dispatchDeviceCodeJob: (client: SetupClientInput, userCode: string, gaSecretRef?: string) => Promise<{ jobId: string }>;
  getJob: (jobId: string) => Promise<{ status: string; result: unknown; error: string | null }>;
  sleep?: (ms: number) => Promise<void>;
  // Progress callback: fired as the run ENTERS each step, so a caller (the run recorder) can persist
  // live progress for the UI's step tracker. Best-effort — a rejected/slow onStage must never derail
  // the setup, so the caller swallows its own errors. `browser-signin` carries the device user-code +
  // verification URL so the UI can show them live for a manual MFA fallback.
  onStage?: (stage: SetupStage, meta?: { userCode?: string; verificationUri?: string }) => void | Promise<void>;
};

export type SetupInput = {
  client: SetupClientInput;
  tenant: string;
  caps?: "required" | "required+optional";
  // A per-run Global-Admin login reference (a Delinea externalId) supplied via the modal — when set, the
  // override IS the eligibility, so the stored-secret check below is bypassed and nothing gets vaulted
  // on the client. Undefined on the fleet path, which still requires a stored m365-global-admin secret.
  gaSecretRef?: string;
  // The operator's opt-in optional Graph permissions from the setup modal, each identified by its
  // suggestedRole (see graph-caps). Threaded into provisioning; `[]` means required-only, undefined
  // falls back to the provision default (`caps`). Ignored when `caps` alone is used (fleet path).
  optionalRoles?: string[];
  // Operator-requested credential rotation ("Rotate credentials" on the setup form): force a fresh
  // secret + certificate even when the app's existing ones are still valid, so the vault is re-written
  // with complete material. The escape hatch for a half-vaulted credential the automation can't detect.
  forceReissue?: boolean;
  // Setup-form options: whether to create/vault a certificate (default true), its validity in days, and
  // whether to grant Exchange Online admin (default true). Exchange app-only needs the cert, so the form
  // couples them. `issueCert=false` → the write must not treat a missing vault cert as a half-vaulted
  // credential (see expectCert on the write).
  issueCert?: boolean;
  certDays?: number;
  grantExchange?: boolean;
  // The run's cancel signal (see setup-cancel.ts). Checked between steps — a cancelled run returns a
  // terminal "cancelled" result at the next boundary instead of mutating further, and the device-code
  // token poll exits early. Optional: an un-cancellable caller just never aborts it.
  signal?: AbortSignal;
};

export type SetupStage = "no-ga-secret" | "device-code-init" | "browser-signin" | "token" | "provision" | "write" | "done" | "error" | "cancelled";

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

// A human note for the run log when the client's Delinea folder wasn't configured and the write
// auto-detected it — says which signal found it and the id it landed on (also self-learned onto the
// client). Kept out of `warnings` (which render as ⚠); this is an informational success line.
const FOLDER_SOURCE_LABEL: Record<NonNullable<WriteResult["resolvedFolderSource"]>, string> = {
  "ga-secret": "the Global Admin login's Delinea folder",
  coreid: "a Delinea folder matching this client's core id",
  name: "a Delinea folder named for this client",
};
function folderDetectionNote(w: WriteResult): string | null {
  if (!w.resolvedFolderSource) return null;
  return `auto-detected this client's Delinea folder (${w.resolvedFolderId}) from ${FOLDER_SOURCE_LABEL[w.resolvedFolderSource]} — saved it on the client for next time`;
}

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

  // Cancel boundary: checked before every step that would mutate (or start a long wait). The row/run
  // status writes are the caller's job — this just stops doing work and reports why.
  const cancelledResult = (): SetupResult => {
    actions.push("the run was cancelled");
    return { ok: false, stage: "cancelled", error: "the run was cancelled", actions };
  };
  if (input.signal?.aborted) return cancelledResult();

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
  await deps.onStage?.("device-code-init");
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

  // 3. Dispatch the browser job that drives the GA sign-in against the userCode we just minted. Report
  // the sign-in step live, carrying the user-code + URL so the UI can offer a manual MFA fallback.
  await deps.onStage?.("browser-signin", { userCode: dc.userCode, verificationUri: dc.verificationUri });
  actions.push("dispatching entra-devicecode browser job");
  const dispatchR = await callDep("dispatchDeviceCodeJob", () => deps.dispatchDeviceCodeJob(client, dc.userCode, input.gaSecretRef));
  if (!dispatchR.ok) {
    actions.push(`dispatching the browser job errored: ${dispatchR.error}`);
    return { ok: false, stage: "error", error: dispatchR.error, userCode: dc.userCode, verificationUri: dc.verificationUri, actions };
  }
  const { jobId } = dispatchR.value;
  actions.push(`browser job ${jobId} dispatched — waiting for Global Admin sign-in`);

  // 4. The token poll is the primary success signal (see file header) — poll it to completion. The
  // cancel signal rides along so a cancelled run doesn't sit in this poll for the full ~15m window.
  if (input.signal?.aborted) return cancelledResult();
  actions.push("polling for the device-code token");
  const tokenR = await callDep("pollDeviceCodeToken", () =>
    deps.pollDeviceCodeToken(tenant, dc.deviceCode, {
      intervalSeconds: dc.interval,
      expiresInSeconds: dc.expiresIn,
      sleep: deps.sleep,
      signal: input.signal,
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
  if (input.signal?.aborted) return cancelledResult();
  await deps.onStage?.("provision");
  actions.push("obtained a Graph token — provisioning the app registration");
  const provR = await callDep("provisionM365App", () => deps.provisionM365App({ graphToken: tokenResult.token, tenantId: tenant, caps: input.caps, optionalRoles: input.optionalRoles, forceReissue: input.forceReissue, issueCert: input.issueCert, certDays: input.certDays, grantExchange: input.grantExchange }));
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
  // Provisioning's own step log — every grant outcome ("granted (admin-consented) X", "WARN could not
  // grant MailboxSettings.Read: …", the Exchange.ManageAsApp/Exchange-Administrator lines, cert
  // issuance) — goes into the run log VERBATIM. Without this the log only ever said "provisioned",
  // so a failed grant was invisible and the UI's ✓/⚠ permission lines had nothing to read. Never
  // contains a secret value (ProvisionResult.actions never carries one).
  for (const line of prov.result.actions) actions.push(line);

  // 6. Write whatever new credential material this run issued back to Delinea (a "kept existing, still
  // valid" run writes nothing — see writeProvisionedM365App). writeProvisionedM365App itself refuses to
  // report ok:true unless the credential is genuinely present+valid (credState-aware — see Findings 1/3).
  if (input.signal?.aborted) return cancelledResult();
  await deps.onStage?.("write");
  actions.push("writing provisioned credentials to Delinea");
  const writeR = await callDep("writeProvisionedM365App", () => deps.writeProvisionedM365App({ client, provision: prov.result, expectCert: input.issueCert ?? true, gaSecretRef: input.gaSecretRef }));
  if (!writeR.ok) {
    actions.push(`writing to Delinea errored: ${writeR.error}`);
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
    if (write.warnings) for (const w of write.warnings) actions.push(w);

    if (write.stranded) {
      // 7. Auto-recover: the app registration already carries a still-valid secret (credState
      // "kept-valid") but nothing is vaulted for it — that prior secret value is unrecoverable, so the
      // only fix is to rotate a fresh one and vault THAT. Bounded to exactly ONE recovery attempt: if
      // it fails too, fall through to a normal failure rather than looping.
      if (input.signal?.aborted) return cancelledResult();
      actions.push("the app has credential material that was never vaulted — rotating a fresh secret + certificate");
      const recoverProvR = await callDep("provisionM365App", () =>
        deps.provisionM365App({ graphToken: tokenResult.token, tenantId: tenant, caps: input.caps, optionalRoles: input.optionalRoles, forceReissue: true, issueCert: input.issueCert, certDays: input.certDays, grantExchange: input.grantExchange })
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
      // The recovery provision's own step log too (grants may have been re-checked, creds rotated).
      for (const line of recoverProv.result.actions) actions.push(line);

      const recoverWriteR = await callDep("writeProvisionedM365App", () =>
        deps.writeProvisionedM365App({ client, provision: recoverProv.result, expectCert: input.issueCert ?? true, gaSecretRef: input.gaSecretRef })
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
      const recoverFolderNote = folderDetectionNote(recoverWrite);
      if (recoverFolderNote) actions.push(recoverFolderNote);
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
  const folderNote = folderDetectionNote(write);
  if (folderNote) actions.push(folderNote);
  actions.push(write.wroteCreds ? `wrote new credentials to Delinea (secret ${write.externalId ?? "?"})` : "no new credentials to write (kept existing, still valid)");
  if (write.warnings) for (const w of write.warnings) actions.push(w);

  return doneResult(prov.result, write);
}
