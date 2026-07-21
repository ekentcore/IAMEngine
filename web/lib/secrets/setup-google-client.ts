// Phase-4 orchestration core for "Set up Google Workspace automatically": chain the already-built
// Google pieces (interactive OAuth super-admin sign-in -> gcloud PKCE token exchange -> GCP project +
// service-account provisioning -> domain-wide-delegation grant -> DWD verification -> Delinea
// writeback) into one per-client run. The Google analog of setup-m365-client.ts.
//
// Like the M365 core this function is PURE: every collaborator that touches the network, a runner job,
// or the database is injected via `deps`, so the whole staged chain (including the DWD manual-fallback
// and stranded-key recovery logic) is unit-testable with no real Google/Delinea/db. The real
// collaborators are wired in setup-google-deps.ts.
//
// Secret hygiene mirrors the M365 core: the PKCE verifier, the OAuth authorization code, the exchanged
// access token, and the service-account key material are held only in locals and NEVER interpolated
// into `actions[]`, `error`, or any returned field — only step names, ids (project/SA/customer), and
// the vault reference flow out.
import type { GoogleProvision } from "./provision-google-workspace";
import { DWD_SCOPES } from "./google-verify";
import type { PkcePair } from "./google-oauth";
import type { WriteGoogleResult } from "./write-google-workspace";

export type GoogleSetupStage =
  | "eligibility"
  | "oauth-dispatch"
  | "oauth-code"
  | "provision"
  | "dwd-dispatch"
  | "dwd-grant"
  | "verify"
  | "write"
  | "done"
  | "error"
  | "cancelled";

export type GoogleSetupClient = { id: string; slug: string; name: string; delineaFolderId: string | null };

export type GoogleSetupResult = {
  stage: GoogleSetupStage;
  ok: boolean;
  saEmail?: string;
  saClientId?: string;
  externalId?: string;
  verified?: boolean;
  customerId?: string;
  // Manual DWD-grant fallback card: when the automated domain-wide-delegation browser job doesn't
  // succeed, the operator can paste this into the Admin console's API-controls panel by hand.
  userAction?: { kind: "dwd"; clientId: string; scopes: string[] };
  browserWarnings: string[];
  actions: string[];
  error?: string;
};

// The dispatched-then-awaited browser-job result (OAuth sign-in / DWD grant). `resultText` carries the
// runner's recorded log text (the OAuth flow returns `OAUTH_CODE:<code>` on its own line); `warnings`
// are the WARN lines pulled out of the job's result (surfaced as browserWarnings).
export type JobAwaitResult = { ok: boolean; resultText?: string; warnings: string[] };

export type GoogleSetupDeps = {
  hasGoogleSystem(clientId: string): Promise<boolean>;
  // resolveSecretFields -> Username; null if unreadable or not an email address (can't impersonate).
  readSeedUsername(seedSecretRef: string): Promise<string | null>;
  // The google-admin slot already holds a real Delinea id (secretIsSet) — drives the needKey decision.
  vaultedKeyPresent(clientId: string): Promise<boolean>;
  makePkce(): PkcePair;
  buildAuthUrl(challenge: string, loginHint: string): string;
  dispatchOAuthJob(input: {
    client: GoogleSetupClient;
    seedSecretRef: string;
    authUrl: string;
  }): Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;
  // `signal` is the run's cancel signal — the poll loop exits early when it fires (returning a
  // non-ok await the core turns into a terminal "cancelled" at its next boundary check).
  awaitJobResult(jobId: string, timeoutMs: number, signal?: AbortSignal): Promise<JobAwaitResult>;
  exchangeCode(code: string, verifier: string): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }>;
  provision(input: {
    accessToken: string;
    clientSlug: string;
    needKey: boolean;
  }): Promise<{ ok: true; value: GoogleProvision } | { ok: false; error: string; actions: string[] }>;
  dispatchDwdJob(input: {
    client: GoogleSetupClient;
    seedSecretRef: string;
    saClientId: string;
    scopes: readonly string[];
  }): Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;
  probeWithRetry(input: { keyBase64: string; impersonate: string }): Promise<{ ok: boolean; customerId?: string; error?: string }>;
  write(input: {
    client: GoogleSetupClient;
    provision: GoogleProvision;
    impersonate: string;
    customerId?: string;
  }): Promise<WriteGoogleResult>;
  deleteIssuedKey(keyName: string, accessToken: string): Promise<boolean>;
};

// Job-await timeouts (the runner drives an interactive browser sign-in / an Admin-console grant).
const OAUTH_TIMEOUT_MS = 15 * 60 * 1000;
const DWD_TIMEOUT_MS = 10 * 60 * 1000;

// The OAuth browser flow returns the authorization code as `OAUTH_CODE:<code>` on its own line.
const OAUTH_CODE_LINE = /(^|\n)\s*OAUTH_CODE:(\S+)/;

// When the OAuth job comes back with NO authorization code, the runner has already recorded WHY as a
// WARN action (the sign-in is non-fatal — the job succeeds so the app can decide). The runner spells
// them "WARN Google OAuth sign-in could not complete — <reason>(screenshot: …)"; pull the <reason>
// back out so the run error names what actually happened instead of the opaque "no authorization
// code". The common one is Google's anti-automation block ("Google rejected the sign-in: Couldn't
// sign you in"), which stops the flow at the email step — before the Delinea one-time code is ever
// requested — so an operator reading "returned no authorization code" wrongly thinks the sign-in ran.
const OAUTH_WARN_PREFIX = /^\s*WARN\s+Google OAuth sign-in could not complete\s*[—-]+\s*/i;
export function oauthSignInFailureReason(warnings: string[]): string | null {
  for (const w of warnings) {
    if (OAUTH_WARN_PREFIX.test(w)) return w.replace(OAUTH_WARN_PREFIX, "").trim() || null;
  }
  // No matched prefix but a Google-flavoured WARN is still better than nothing.
  const anyGoogle = warnings.find((w) => /google|sign-in|oauth|consent/i.test(w));
  return anyGoogle ? anyGoogle.replace(/^\s*WARN\s+/i, "").trim() : null;
}

// Every dep call degrades to a structured result rather than an uncaught throw (M365 Finding 9): a
// network blip in any collaborator comes back as an ok:false the caller can retry/report on.
async function callDep<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: `${name} threw: ${(e as Error).message}` };
  }
}

export async function setupGoogleForClient(input: {
  client: GoogleSetupClient;
  seedSecretRef: string;
  forceRotate: boolean;
  deps: GoogleSetupDeps;
  onStage?: (stage: GoogleSetupStage, extra?: Partial<GoogleSetupResult>) => Promise<void>;
  // The run's cancel signal (see setup-cancel.ts). Checked between steps — a cancelled run returns a
  // terminal "cancelled" result at the next boundary instead of mutating further, and the browser-job
  // awaits exit early. Optional: an un-cancellable caller just never aborts it.
  signal?: AbortSignal;
}): Promise<GoogleSetupResult> {
  const { client, seedSecretRef, forceRotate, deps, onStage, signal } = input;

  const actions: string[] = [];
  const browserWarnings: string[] = [];
  let saEmail: string | undefined;
  let saClientId: string | undefined;
  let externalId: string | undefined;
  let verified: boolean | undefined;
  let customerId: string | undefined;
  let userAction: GoogleSetupResult["userAction"];

  const emit = async (stage: GoogleSetupStage) => {
    // Best-effort progress callback — a rejected/slow onStage must never derail the setup.
    try {
      await onStage?.(stage, { saEmail, saClientId, externalId, verified, customerId, userAction });
    } catch {
      // ignored
    }
  };

  const result = (stage: GoogleSetupStage, ok: boolean, error?: string): GoogleSetupResult => ({
    stage,
    ok,
    saEmail,
    saClientId,
    externalId,
    verified,
    customerId,
    userAction,
    browserWarnings,
    actions,
    error,
  });

  const fail = async (stage: GoogleSetupStage, error: string): Promise<GoogleSetupResult> => {
    actions.push(`failed at ${stage}: ${error}`);
    return result(stage, false, error);
  };

  // A dep-throw is always an unexpected `error` terminal (distinct from a logical stage failure).
  const threw = async (error: string): Promise<GoogleSetupResult> => {
    await emit("error");
    return fail("error", error);
  };

  // Cancel boundary: checked before every step that would mutate (or start a long wait). The row/run
  // status writes are the caller's job — this just stops doing work and reports why.
  const cancelled = () => signal?.aborted === true;
  const cancelledResult = async (): Promise<GoogleSetupResult> => fail("cancelled", "the run was cancelled");
  if (cancelled()) return cancelledResult();

  // 1. Eligibility — the client must have a google-workspace system and a readable super-admin login
  // (an email we can impersonate over DWD). Both are terminal; nothing downstream can work without them.
  await emit("eligibility");
  const hasSys = await callDep("hasGoogleSystem", () => deps.hasGoogleSystem(client.id));
  if (!hasSys.ok) return threw(hasSys.error);
  if (!hasSys.value) return fail("eligibility", "client has no google-workspace system");

  const seedUserR = await callDep("readSeedUsername", () => deps.readSeedUsername(seedSecretRef));
  if (!seedUserR.ok) return threw(seedUserR.error);
  const impersonate = seedUserR.value;
  if (!impersonate) {
    return fail("eligibility", "could not read a super-admin email from the seed secret (Impersonate unknown)");
  }
  actions.push("eligibility: google-workspace system present + super-admin login readable");

  // 2. OAuth — mint PKCE, dispatch the interactive sign-in browser job, await it, parse the auth code.
  const pkce = deps.makePkce(); // pure/local; verifier stays in memory, never logged
  const authUrl = deps.buildAuthUrl(pkce.challenge, impersonate);

  await emit("oauth-dispatch");
  actions.push("dispatching the Google OAuth sign-in browser job");
  const oauthDispatch = await callDep("dispatchOAuthJob", () =>
    deps.dispatchOAuthJob({ client, seedSecretRef, authUrl })
  );
  if (!oauthDispatch.ok) return threw(oauthDispatch.error);
  if (!oauthDispatch.value.ok) return fail("oauth-dispatch", oauthDispatch.value.error);
  const oauthJobId = oauthDispatch.value.jobId;

  await emit("oauth-code");
  actions.push(`awaiting OAuth sign-in (job ${oauthJobId})`);
  const oauthAwait = await callDep("awaitJobResult", () => deps.awaitJobResult(oauthJobId, OAUTH_TIMEOUT_MS, signal));
  if (cancelled()) return cancelledResult();
  if (!oauthAwait.ok) return threw(oauthAwait.error);
  for (const w of oauthAwait.value.warnings) browserWarnings.push(w);
  const signInReason = oauthSignInFailureReason(oauthAwait.value.warnings);
  if (!oauthAwait.value.ok) {
    return fail(
      "oauth-code",
      signInReason
        ? `the Google sign-in did not complete: ${signInReason}`
        : "the Google sign-in job did not complete (timed out or failed) — check the runner's screenshot",
    );
  }
  const codeMatch = oauthAwait.value.resultText?.match(OAUTH_CODE_LINE);
  const authCode = codeMatch?.[2]; // held in memory only — NEVER pushed to actions/errors
  if (!authCode) {
    // No code AND a recorded sign-in reason = the sign-in was blocked/rejected before it finished (the
    // common case is Google's "Couldn't sign you in / browser may not be secure" block at the email
    // step, before the Delinea verification code is even requested). Name that instead of implying the
    // flow ran to the end. With no reason recorded, say plainly that the sign-in never reached the
    // consent redirect and point at the manual fallback.
    return fail(
      "oauth-code",
      signInReason
        ? `the Google sign-in did not complete, so no authorization code came back: ${signInReason}. This usually means Google blocked the automated browser before the sign-in finished — set the client up manually instead (convert the key at /tools/google-key and create the google-admin secret by hand).`
        : "the Google sign-in never reached the consent redirect, so no authorization code came back — Google likely blocked or interrupted the automated sign-in. Check the runner's screenshot, or set the client up manually (convert the key at /tools/google-key and create the google-admin secret by hand).",
    );
  }

  // 3. Provision — exchange the code for an access token (PKCE verifier held locally), then provision
  // (or reconcile) the GCP project + service account. needKey rotates a fresh key when the operator
  // asked (forceRotate) or nothing is currently vaulted.
  if (cancelled()) return cancelledResult();
  await emit("provision");
  const exchangeR = await callDep("exchangeCode", () => deps.exchangeCode(authCode, pkce.verifier));
  if (!exchangeR.ok) return threw(exchangeR.error);
  if (!exchangeR.value.ok) return fail("provision", exchangeR.value.error);
  const accessToken = exchangeR.value.accessToken; // held in memory only

  const vaultedR = await callDep("vaultedKeyPresent", () => deps.vaultedKeyPresent(client.id));
  if (!vaultedR.ok) return threw(vaultedR.error);
  const needKey = forceRotate || !vaultedR.value;

  const provR = await callDep("provision", () => deps.provision({ accessToken, clientSlug: client.slug, needKey }));
  if (!provR.ok) return threw(provR.error);
  if (!provR.value.ok) {
    for (const line of provR.value.actions) actions.push(line);
    return fail("provision", provR.value.error);
  }
  let prov = provR.value.value;
  saEmail = prov.saEmail;
  saClientId = prov.saClientId;
  for (const line of prov.actions) actions.push(line);

  // 4. DWD grant — dispatch the domain-wide-delegation browser job and await it. NON-TERMINAL on
  // failure: record a manual-fallback userAction and press on (the operator can paste the grant while
  // verification keeps retrying against the propagating grant).
  if (cancelled()) return cancelledResult();
  await emit("dwd-dispatch");
  actions.push("dispatching the domain-wide-delegation grant browser job");
  const dwdDispatch = await callDep("dispatchDwdJob", () =>
    deps.dispatchDwdJob({ client, seedSecretRef, saClientId: prov.saClientId, scopes: DWD_SCOPES })
  );
  const setDwdFallback = () => {
    userAction = { kind: "dwd", clientId: prov.saClientId, scopes: [...DWD_SCOPES] };
    actions.push("DWD grant not confirmed automatically — surfacing a manual-grant fallback");
  };
  if (!dwdDispatch.ok || !dwdDispatch.value.ok) {
    setDwdFallback();
  } else {
    const dwdJobId = dwdDispatch.value.jobId;
    await emit("dwd-grant");
    actions.push(`awaiting the DWD grant (job ${dwdJobId})`);
    const dwdAwait = await callDep("awaitJobResult", () => deps.awaitJobResult(dwdJobId, DWD_TIMEOUT_MS, signal));
    if (cancelled()) return cancelledResult();
    if (dwdAwait.ok) {
      for (const w of dwdAwait.value.warnings) browserWarnings.push(w);
      if (!dwdAwait.value.ok) setDwdFallback();
      else actions.push("DWD grant confirmed by the browser job");
    } else {
      // A thrown await on the DWD side is still not terminal — fall back to a manual grant.
      setDwdFallback();
    }
  }

  // 5. Verify — probe an actual impersonated Directory call (absorbing DWD propagation delay). Only
  // meaningful when we hold key material this run (issued); a kept-valid run has no key in hand to
  // probe with, so verification is left to the run that issued it. Failure never blocks the write.
  if (prov.keyBase64) {
    if (cancelled()) return cancelledResult();
    await emit("verify");
    const probeR = await callDep("probeWithRetry", () => deps.probeWithRetry({ keyBase64: prov.keyBase64!, impersonate }));
    if (!probeR.ok) {
      // A thrown probe is a non-blocking verify failure, never terminal.
      verified = false;
      actions.push(`verification errored (non-blocking): ${probeR.error}`);
    } else {
      verified = probeR.value.ok;
      if (probeR.value.customerId) customerId = probeR.value.customerId;
      actions.push(verified ? "verified DWD impersonation against the Directory API" : `verification failed (non-blocking): ${probeR.value.error ?? "unknown"}`);
    }
  }

  // 6. Write — vault the freshly-issued key back to Delinea. A stranded write (the SA reports a valid
  // key but none is vaulted) triggers exactly ONE re-provision with needKey:true, then a re-write.
  if (cancelled()) return cancelledResult();
  await emit("write");
  const writeR = await callDep("write", () => deps.write({ client, provision: prov, impersonate, customerId }));
  if (!writeR.ok) return threw(writeR.error);
  let write = writeR.value;

  // The prior key that a recovery re-provision supersedes — cleaned up only after a verified issued write.
  let rotatedAwayKeyName: string | undefined;

  if (!write.ok) {
    for (const line of write.actions) actions.push(line);
    if (write.stranded) {
      if (cancelled()) return cancelledResult();
      actions.push("the service account reports a valid key but none is vaulted — rotating a fresh key");
      const priorKeyName = prov.issuedKeyName; // the key (if any) this run had before recovery
      const recoverR = await callDep("provision", () => deps.provision({ accessToken, clientSlug: client.slug, needKey: true }));
      if (!recoverR.ok) return threw(recoverR.error);
      if (!recoverR.value.ok) {
        for (const line of recoverR.value.actions) actions.push(line);
        return fail("provision", recoverR.value.error);
      }
      prov = recoverR.value.value;
      saEmail = prov.saEmail;
      saClientId = prov.saClientId;
      for (const line of prov.actions) actions.push(line);
      if (priorKeyName && prov.credState === "issued") rotatedAwayKeyName = priorKeyName;

      const rewriteR = await callDep("write", () => deps.write({ client, provision: prov, impersonate, customerId }));
      if (!rewriteR.ok) return threw(rewriteR.error);
      write = rewriteR.value;
      if (!write.ok) {
        for (const line of write.actions) actions.push(line);
        return fail("write", write.error);
      }
    } else {
      return fail("write", write.error);
    }
  }

  // write.ok — carry the vault reference and its own trail.
  externalId = write.externalId;
  for (const line of write.actions) actions.push(line);

  // 6b. Best-effort key cleanup: delete a rotated-away prior key ONLY after a verified issued write —
  // never on a failed verify (we don't want to delete the still-in-use key if the new one is unproven).
  if (prov.credState === "issued" && verified === true && rotatedAwayKeyName) {
    const del = await callDep("deleteIssuedKey", () => deps.deleteIssuedKey(rotatedAwayKeyName!, accessToken));
    if (del.ok && del.value) actions.push("cleaned up the rotated-away prior service account key");
    else actions.push("could not clean up the rotated-away prior key (best-effort — left in place)");
  }

  await emit("done");
  return result("done", true);
}
