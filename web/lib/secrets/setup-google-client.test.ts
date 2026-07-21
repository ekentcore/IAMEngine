import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setupGoogleForClient,
  oauthSignInFailureReason,
  type GoogleSetupDeps,
  type GoogleSetupClient,
  type GoogleSetupStage,
} from "./setup-google-client";
import type { GoogleProvision } from "./provision-google-workspace";
import { DWD_SCOPES } from "./google-verify";

const CLIENT: GoogleSetupClient = { id: "client1", slug: "brighton-park", name: "Brighton Park", delineaFolderId: "142" };
const SEED_REF = "delinea-seed-ref-123";

function provision(overrides: Partial<GoogleProvision> = {}): GoogleProvision {
  return {
    projectId: "ctg-iam-brighton-park",
    saEmail: "iam-engine@ctg-iam-brighton-park.iam.gserviceaccount.com",
    saClientId: "10293847566",
    credState: "issued",
    keyBase64: "BASE64-KEY-MATERIAL",
    issuedKeyName: "projects/ctg-iam-brighton-park/serviceAccounts/x/keys/key-1",
    actions: ["created project ctg-iam-brighton-park", "issued a new service account key"],
    ...overrides,
  };
}

function happyDeps(overrides: Partial<GoogleSetupDeps> = {}): GoogleSetupDeps {
  return {
    hasGoogleSystem: async () => true,
    readSeedUsername: async () => "superadmin@brightonpark.org",
    vaultedKeyPresent: async () => false,
    makePkce: () => ({ verifier: "SECRET-VERIFIER", challenge: "CHALLENGE" }),
    buildAuthUrl: (challenge, loginHint) => `https://accounts.google.com/o/oauth2/v2/auth?c=${challenge}&hint=${loginHint}`,
    dispatchOAuthJob: async () => ({ ok: true, jobId: "oauth-job" }),
    dispatchDwdJob: async () => ({ ok: true, jobId: "dwd-job" }),
    awaitJobResult: async (jobId) =>
      jobId === "dwd-job"
        ? { ok: true, warnings: [] }
        : { ok: true, resultText: "some log line\nOAUTH_CODE:the-auth-code-xyz\ndone", warnings: [] },
    exchangeCode: async () => ({ ok: true, accessToken: "SECRET-ACCESS-TOKEN" }),
    provision: async () => ({ ok: true, value: provision() }),
    probeWithRetry: async () => ({ ok: true, customerId: "C0xyz123" }),
    write: async () => ({ ok: true, externalId: "ext-google-1", actions: ["wired google-admin"] }),
    deleteIssuedKey: async () => true,
    ...overrides,
  };
}

test("happy path: eligibility -> oauth -> provision -> dwd -> verify -> write -> done, in order", async () => {
  const stages: GoogleSetupStage[] = [];
  const deps = happyDeps();
  const result = await setupGoogleForClient({
    client: CLIENT,
    seedSecretRef: SEED_REF,
    forceRotate: false,
    deps,
    onStage: async (s) => {
      stages.push(s);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.equal(result.saEmail, provision().saEmail);
  assert.equal(result.saClientId, "10293847566");
  assert.equal(result.externalId, "ext-google-1");
  assert.equal(result.verified, true);
  assert.equal(result.customerId, "C0xyz123");
  assert.equal(result.userAction, undefined);
  assert.deepEqual(stages, [
    "eligibility",
    "oauth-dispatch",
    "oauth-code",
    "provision",
    "dwd-dispatch",
    "dwd-grant",
    "verify",
    "write",
    "done",
  ]);
});

test("no google-workspace system: terminal error at eligibility, oauth never dispatched", async () => {
  let dispatched = false;
  const deps = happyDeps({
    hasGoogleSystem: async () => false,
    dispatchOAuthJob: async () => {
      dispatched = true;
      return { ok: true, jobId: "x" };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "eligibility");
  assert.match(result.error ?? "", /google-workspace/);
  assert.equal(dispatched, false);
});

test("unreadable/non-email seed username: terminal error at eligibility", async () => {
  let dispatched = false;
  const deps = happyDeps({
    readSeedUsername: async () => null,
    dispatchOAuthJob: async () => {
      dispatched = true;
      return { ok: true, jobId: "x" };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "eligibility");
  assert.equal(dispatched, false);
});

test("OAuth job times out (no code): terminal error at oauth-code", async () => {
  const deps = happyDeps({
    awaitJobResult: async (jobId) =>
      jobId === "oauth-job" ? { ok: false, warnings: [] } : { ok: true, warnings: [] },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "oauth-code");
});

test("OAuth job succeeds but result text has no OAUTH_CODE line: error at oauth-code", async () => {
  const deps = happyDeps({
    awaitJobResult: async (jobId) =>
      jobId === "oauth-job" ? { ok: true, resultText: "signed in\nno code here", warnings: [] } : { ok: true, warnings: [] },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "oauth-code");
  // No recorded reason -> the clearer generic that names WHAT happened (never reached the redirect)
  // instead of the old "the OAuth job finished but returned no authorization code".
  assert.match(result.error ?? "", /never reached the consent redirect/);
  assert.doesNotMatch(result.error ?? "", /job finished but returned no authorization code/);
});

test("no OAUTH_CODE but a runner sign-in WARN: the error names the real reason (the block), not just 'no code'", async () => {
  const warn =
    "WARN Google OAuth sign-in could not complete — Google rejected the sign-in: Couldn't sign you in (screenshot: /tmp/ctg-browser-google-email-error-1.png)";
  const deps = happyDeps({
    awaitJobResult: async (jobId) =>
      jobId === "oauth-job" ? { ok: true, resultText: "signed in\nno code", warnings: [warn] } : { ok: true, warnings: [] },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "oauth-code");
  assert.match(result.error ?? "", /Google rejected the sign-in: Couldn't sign you in/);
  assert.match(result.error ?? "", /blocked the automated browser|set the client up manually/i);
  // And the raw warning is still preserved for the run log.
  assert.ok(result.browserWarnings.includes(warn));
});

test("oauthSignInFailureReason: strips the runner's WARN prefix, keeps the reason + screenshot", () => {
  assert.equal(
    oauthSignInFailureReason([
      "WARN Google OAuth sign-in could not complete — Google rejected the sign-in: Couldn't sign you in (screenshot: /tmp/x.png)",
    ]),
    "Google rejected the sign-in: Couldn't sign you in (screenshot: /tmp/x.png)",
  );
  // No matching WARN prefix but a google-flavoured warn -> still surfaced (WARN stripped).
  assert.equal(oauthSignInFailureReason(["WARN consent screen was slow"]), "consent screen was slow");
  // Nothing relevant -> null (caller falls back to its generic message).
  assert.equal(oauthSignInFailureReason([]), null);
  assert.equal(oauthSignInFailureReason(["WARN some unrelated thing"]), null);
});

test("OAuth job warnings surface into browserWarnings", async () => {
  const deps = happyDeps({
    awaitJobResult: async (jobId) =>
      jobId === "oauth-job"
        ? { ok: true, resultText: "OAUTH_CODE:c", warnings: ["WARN consent screen slow"] }
        : { ok: true, warnings: [] },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.ok(result.browserWarnings.includes("WARN consent screen slow"));
});

test("DWD job failure is NOT terminal: userAction set, run still reaches write + done", async () => {
  const deps = happyDeps({
    awaitJobResult: async (jobId) =>
      jobId === "dwd-job"
        ? { ok: false, warnings: ["WARN could not add API client"] }
        : { ok: true, resultText: "OAUTH_CODE:c", warnings: [] },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.deepEqual(result.userAction, { kind: "dwd", clientId: "10293847566", scopes: [...DWD_SCOPES] });
});

test("verify failure -> verified:false but write still happens and run is done", async () => {
  let wrote = false;
  const deps = happyDeps({
    probeWithRetry: async () => ({ ok: false, error: "unauthorized_client" }),
    write: async () => {
      wrote = true;
      return { ok: true, externalId: "ext-google-1", actions: [] };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.equal(result.verified, false);
  assert.equal(wrote, true);
});

test("forceRotate forces provision needKey:true on the first (only) provision", async () => {
  const calls: { needKey: boolean }[] = [];
  const deps = happyDeps({
    vaultedKeyPresent: async () => true, // even with a vaulted key, forceRotate must force needKey
    provision: async (input) => {
      calls.push({ needKey: input.needKey });
      return { ok: true, value: provision() };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: true, deps });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].needKey, true);
});

test("no forceRotate + vaulted key present -> provision needKey:false", async () => {
  const calls: { needKey: boolean }[] = [];
  const deps = happyDeps({
    vaultedKeyPresent: async () => true,
    provision: async (input) => {
      calls.push({ needKey: input.needKey });
      return { ok: true, value: provision({ credState: "kept-valid", keyBase64: undefined, issuedKeyName: undefined }) };
    },
    write: async () => ({ ok: true, externalId: "ext-google-1", actions: [] }),
  });
  await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(calls[0].needKey, false);
});

test("stranded write triggers exactly one re-provision with needKey:true, then re-write succeeds", async () => {
  const calls: { needKey: boolean }[] = [];
  let writeCalls = 0;
  const deps = happyDeps({
    provision: async (input) => {
      calls.push({ needKey: input.needKey });
      return { ok: true, value: provision({ issuedKeyName: input.needKey ? "key-recover" : "key-1" }) };
    },
    write: async () => {
      writeCalls++;
      if (writeCalls === 1) return { ok: false, stranded: true, error: "valid key but none vaulted", actions: [] };
      return { ok: true, externalId: "ext-google-1", actions: [] };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.equal(calls.length, 2, "exactly one recovery re-provision");
  assert.equal(calls[1].needKey, true, "recovery provision forces a fresh key");
  assert.equal(writeCalls, 2);
});

test("stranded write whose recovery ALSO fails is bounded to one retry, terminal at write", async () => {
  let provisionCalls = 0;
  let writeCalls = 0;
  const deps = happyDeps({
    provision: async () => {
      provisionCalls++;
      return { ok: true, value: provision() };
    },
    write: async () => {
      writeCalls++;
      return { ok: false, stranded: true, error: "valid key but none vaulted", actions: [] };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "write");
  assert.equal(provisionCalls, 2, "one recovery re-provision, not a loop");
  assert.equal(writeCalls, 2, "one recovery re-write, not a loop");
});

test("key cleanup: called with the prior (rotated-away) key only on issued + verified + a superseded prior key", async () => {
  let deleted: string | undefined;
  let writeCalls = 0;
  let provisionCalls = 0;
  const deps = happyDeps({
    provision: async () => {
      provisionCalls++;
      return { ok: true, value: provision({ issuedKeyName: provisionCalls === 1 ? "key-1" : "key-recover" }) };
    },
    write: async () => {
      writeCalls++;
      if (writeCalls === 1) return { ok: false, stranded: true, error: "valid key but none vaulted", actions: [] };
      return { ok: true, externalId: "ext-google-1", actions: [] };
    },
    deleteIssuedKey: async (keyName) => {
      deleted = keyName;
      return true;
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, true);
  assert.equal(deleted, "key-1", "the superseded prior key is cleaned up");
});

test("key cleanup: NOT called on a plain issued+verified run with no superseded prior key", async () => {
  let deleteCalled = false;
  const deps = happyDeps({
    deleteIssuedKey: async () => {
      deleteCalled = true;
      return true;
    },
  });
  await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(deleteCalled, false);
});

test("key cleanup: NOT called when verify failed, even with a superseded prior key", async () => {
  let deleteCalled = false;
  let writeCalls = 0;
  let provisionCalls = 0;
  const deps = happyDeps({
    probeWithRetry: async () => ({ ok: false, error: "unauthorized_client" }),
    provision: async () => {
      provisionCalls++;
      return { ok: true, value: provision({ issuedKeyName: provisionCalls === 1 ? "key-1" : "key-recover" }) };
    },
    write: async () => {
      writeCalls++;
      if (writeCalls === 1) return { ok: false, stranded: true, error: "valid key but none vaulted", actions: [] };
      return { ok: true, externalId: "ext-google-1", actions: [] };
    },
    deleteIssuedKey: async () => {
      deleteCalled = true;
      return true;
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(deleteCalled, false);
});

test("provision failure: terminal at provision, write never called", async () => {
  let wrote = false;
  const deps = happyDeps({
    provision: async () => ({ ok: false, error: "enable APIs: permission denied", actions: [] }),
    write: async () => {
      wrote = true;
      return { ok: true, externalId: "x", actions: [] };
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "provision");
  assert.equal(wrote, false);
});

test("exchangeCode failure: terminal at provision", async () => {
  const deps = happyDeps({
    exchangeCode: async () => ({ ok: false, error: "invalid_grant" }),
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "provision");
});

test("write failure (non-stranded): terminal at write", async () => {
  const deps = happyDeps({
    write: async () => ({ ok: false, error: "Delinea write not configured", actions: [] }),
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "write");
  assert.match(result.error ?? "", /Delinea write not configured/);
});

test("Finding 9: a thrown dep becomes a structured error result, never an uncaught throw", async () => {
  const deps = happyDeps({
    hasGoogleSystem: async () => {
      throw new Error("db connection reset");
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "error");
  assert.match(result.error ?? "", /db connection reset/);
});

test("Finding 9: a thrown provision becomes a structured error result", async () => {
  const deps = happyDeps({
    provision: async () => {
      throw new Error("Graph fetch threw");
    },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "error");
  assert.match(result.error ?? "", /Graph fetch threw/);
});

test("never leaks the verifier, auth code, access token, or key material into result/actions", async () => {
  const deps = happyDeps({
    provision: async () => ({ ok: true, value: provision({ keyBase64: "SUPER-SECRET-KEY-BYTES" }) }),
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps });
  const haystack = JSON.stringify(result);
  for (const secret of ["SECRET-VERIFIER", "the-auth-code-xyz", "SECRET-ACCESS-TOKEN", "SUPER-SECRET-KEY-BYTES", "BASE64-KEY-MATERIAL"]) {
    assert.ok(!haystack.includes(secret), `leaked secret in result: ${secret}`);
    for (const a of result.actions) assert.ok(!a.includes(secret), `leaked secret in actions[]: ${secret}`);
  }
});

// --- cancellation ------------------------------------------------------------------------------------

test("a pre-aborted signal returns cancelled before touching any dep", async () => {
  const controller = new AbortController();
  controller.abort();
  const mustNotRun = () => { throw new Error("must not be called after cancel"); };
  const deps = happyDeps({
    hasGoogleSystem: async () => mustNotRun(),
    dispatchOAuthJob: async () => mustNotRun(),
    provision: async () => mustNotRun(),
    write: async () => mustNotRun(),
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "cancelled");
});

test("cancel during the OAuth await stops before the code exchange and provisioning", async () => {
  const controller = new AbortController();
  let exchanged = false;
  let provisioned = false;
  const deps = happyDeps({
    // The signal rides into the await (real impl exits early); abort mid-await and return a
    // success anyway — the core's next boundary check must still refuse to continue.
    awaitJobResult: async (_jobId, _timeout, signal) => {
      assert.equal(signal, controller.signal, "the cancel signal must reach the job await");
      controller.abort();
      return { ok: true, resultText: "OAUTH_CODE:the-auth-code-xyz", warnings: [] };
    },
    exchangeCode: async () => { exchanged = true; return { ok: true, accessToken: "SECRET-ACCESS-TOKEN" }; },
    provision: async () => { provisioned = true; return { ok: true, value: provision() }; },
  });
  const result = await setupGoogleForClient({ client: CLIENT, seedSecretRef: SEED_REF, forceRotate: false, deps, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "cancelled");
  assert.equal(exchanged, false, "the code exchange must not run after the cancel");
  assert.equal(provisioned, false, "provisioning must not run after the cancel");
});
