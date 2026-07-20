import { test } from "node:test";
import assert from "node:assert/strict";
import { setupM365ForClient, extractWarnings, type SetupDeps, type SetupClientInput } from "./setup-m365-client";
import type { ProvisionResult } from "./provision-m365-app";
import type { WriteResult } from "./write-m365-app";

const CLIENT: SetupClientInput = { id: "client1", slug: "acme", name: "Acme Corp", primaryDomain: "acme.com", delineaFolderId: "142" };
const TENANT = "acme.onmicrosoft.com";
const NOOP_SLEEP = async () => {};

function provision(overrides: Partial<ProvisionResult> = {}): ProvisionResult {
  return {
    appId: "app-guid-1",
    objectId: "obj-guid-1",
    spId: "sp-guid-1",
    tenantId: TENANT,
    created: false,
    granted: ["User.ReadWrite.All"],
    gaps: [],
    optionalGaps: [],
    verified: true,
    exchangeReady: true,
    credState: "issued",
    actions: ["granted (admin-consented) User.ReadWrite.All"],
    ...overrides,
  };
}

// A full set of deps that succeed at every stage — individual tests override just the piece they're
// exercising, and assert the resulting stage/short-circuit.
function happyDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    hasGlobalAdminSecret: async () => true,
    startDeviceCode: async () => ({
      ok: true,
      deviceCode: "SECRET-DEVICE-CODE",
      userCode: "ABCD-1234",
      verificationUri: "https://microsoft.com/devicelogin",
      interval: 5,
      expiresIn: 900,
    }),
    dispatchDeviceCodeJob: async () => ({ jobId: "job-1" }),
    pollDeviceCodeToken: async () => ({ ok: true, token: "SECRET-GRAPH-TOKEN" }),
    provisionM365App: async () => ({ ok: true, result: provision() }),
    writeProvisionedM365App: async () => ({ ok: true, wroteCreds: true, created: true, externalId: "ext-1" }),
    getJob: async () => ({ status: "done", result: null, error: null }),
    sleep: NOOP_SLEEP,
    ...overrides,
  };
}

test("happy path: chains device-code -> token -> provision -> write -> done", async () => {
  const deps = happyDeps();
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.equal(result.appId, "app-guid-1");
  assert.equal(result.wroteCreds, true);
  assert.equal(result.externalId, "ext-1"); // the Delinea secret id flows through -> audit + run log
  assert.ok(result.actions.some((a) => a.includes("wrote new credentials to Delinea (secret ext-1)")));
  assert.equal(result.verified, true);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.userCode, "ABCD-1234");
  assert.ok(result.actions.length > 0);
});

test("no GA secret: stage no-ga-secret, dispatchDeviceCodeJob is never called", async () => {
  let dispatched = false;
  const deps = happyDeps({
    hasGlobalAdminSecret: async () => false,
    dispatchDeviceCodeJob: async () => {
      dispatched = true;
      return { jobId: "should-not-happen" };
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "no-ga-secret");
  assert.ok(result.error?.includes("m365-global-admin"));
  assert.equal(dispatched, false);
});

test("gaSecretRef provided: bypasses the no-ga-secret check and is threaded to dispatchDeviceCodeJob", async () => {
  let calledWith: unknown;
  const deps = happyDeps({
    hasGlobalAdminSecret: async () => false,
    dispatchDeviceCodeJob: async (_client, _userCode, gaSecretRef) => {
      calledWith = gaSecretRef;
      return { jobId: "job-1" };
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT, gaSecretRef: "delinea-ext-123" }, deps);
  assert.notEqual(result.stage, "no-ga-secret");
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.equal(calledWith, "delinea-ext-123");
});

test("device-code init fails: stage device-code-init", async () => {
  const deps = happyDeps({
    startDeviceCode: async () => ({ ok: false, error: "tenant not found" }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "device-code-init");
  assert.equal(result.error, "tenant not found");
});

test("token poll fails with a browser WARN: browserWarnings surfaced, stage browser-signin", async () => {
  const deps = happyDeps({
    pollDeviceCodeToken: async () => ({ ok: false, error: "device code expired before sign-in completed", code: "expired_token" }),
    getJob: async () => ({
      status: "failed",
      result: { actions: ["started sign-in", "WARN MFA push not automatable — push/SMS", "aborted"] },
      error: null,
    }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "browser-signin");
  assert.equal(result.error, "device code expired before sign-in completed");
  assert.deepEqual(result.browserWarnings, ["WARN MFA push not automatable — push/SMS"]);
  assert.equal(result.userCode, "ABCD-1234");
});

test("token poll fails with no browser WARN (e.g. network_error): stage token, no browserWarnings", async () => {
  const deps = happyDeps({
    pollDeviceCodeToken: async () => ({ ok: false, error: "fetch failed", code: "network_error" }),
    getJob: async () => ({ status: "running", result: { actions: ["started sign-in"] }, error: null }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "token");
  assert.equal(result.browserWarnings, undefined);
});

test("provision fails: stage provision, writeProvisionedM365App is never called", async () => {
  let wrote = false;
  const deps = happyDeps({
    provisionM365App: async () => ({ ok: false, error: "Graph app role not found in tenant: User.ReadWrite.All", actions: [] }),
    writeProvisionedM365App: async () => {
      wrote = true;
      return { ok: true, wroteCreds: true } as WriteResult;
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "provision");
  assert.equal(wrote, false);
});

test("write fails: stage write", async () => {
  const deps = happyDeps({
    writeProvisionedM365App: async () => ({ ok: false, wroteCreds: false, error: "Delinea write not configured — no write account" }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "write");
  assert.ok(result.error?.includes("Delinea write not configured"));
});

// FINDING 3: provision reports credState "unverified" downstream (write refuses) -> setup must NEVER
// report "done"/ok:true. The honest signal is write's own ok:false — setup doesn't need to special-case
// credState itself; it just has to key off write's result honestly (never assert success on its own).
test("Finding 3: provision credState unverified -> write refuses -> setup is ok:false, never 'done'", async () => {
  const deps = happyDeps({
    provisionM365App: async () => ({ ok: true, result: provision({ credState: "unverified", clientSecret: undefined, certBase64: undefined }) }),
    writeProvisionedM365App: async () => ({
      ok: false,
      wroteCreds: false,
      error: "could not verify the app registration's credentials (transient Graph error); not treating this as set up",
    }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.notEqual(result.stage, "done");
  assert.match(result.error ?? "", /could not verify|transient/);
});

// FINDING 3: provision "issued" + write ok -> genuinely "done".
test("Finding 3: provision credState issued + write ok -> stage done, ok:true", async () => {
  const deps = happyDeps({
    provisionM365App: async () => ({ ok: true, result: provision({ credState: "issued", clientSecret: "shh" }) }),
    writeProvisionedM365App: async () => ({ ok: true, wroteCreds: true, created: true, externalId: "ext-1" }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
});

// FIX A: the stranded case (write returns stranded:true) now triggers ONE bounded auto-recovery
// attempt — re-provision with forceReissue (mints a fresh secret) then re-write — before setup gives
// up. This is the case that used to force an operator to "rotate manually".
test("Fix A: stranded write triggers one recovery re-provision (forceReissue) + re-write, then succeeds", async () => {
  const provisionCalls: { forceReissue?: boolean }[] = [];
  let writeCalls = 0;
  const deps = happyDeps({
    provisionM365App: async (input) => {
      provisionCalls.push({ forceReissue: input.forceReissue });
      if (input.forceReissue) {
        return { ok: true, result: provision({ credState: "issued", clientSecret: "fresh-secret", appId: "app-guid-1" }) };
      }
      return { ok: true, result: provision({ credState: "kept-valid" }) };
    },
    writeProvisionedM365App: async () => {
      writeCalls++;
      if (writeCalls === 1) {
        return {
          ok: false,
          wroteCreds: false,
          stranded: true,
          error: "the app registration reports a valid credential but none is vaulted",
        };
      }
      return { ok: true, wroteCreds: true, created: false, externalId: "ext-1" };
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.stage, "done");
  assert.equal(result.appId, "app-guid-1");
  assert.equal(result.wroteCreds, true);
  assert.equal(writeCalls, 2, "expected exactly one recovery re-write on top of the initial write");
  assert.equal(provisionCalls.length, 2, "expected exactly one recovery re-provision on top of the initial provision");
  assert.equal(provisionCalls[0].forceReissue, undefined, "the initial provision must not force a reissue");
  assert.equal(provisionCalls[1].forceReissue, true, "the recovery provision must force a fresh secret");
  assert.ok(result.actions.some((a) => a.includes("rotating a fresh secret")), "expected the recovery step to be logged");
  assert.ok(result.actions.some((a) => a.includes("wrote the rotated credential to Delinea")));
});

// FIX A: recovery is bounded to exactly ONE attempt — if the retry also fails, setup gives up and
// surfaces the retry's own failure rather than looping. Provision's WARN lines from the FIRST attempt
// still get surfaced into actions so an operator sees why.
test("Fix A: a stranded write whose recovery ALSO fails is bounded to one retry, not a loop", async () => {
  let provisionCalls = 0;
  let writeCalls = 0;
  const deps = happyDeps({
    provisionM365App: async () => {
      provisionCalls++;
      return {
        ok: true,
        result: provision({ credState: "kept-valid", actions: ["kept existing client secret (valid)", "WARN could not verify granted roles (read incomplete)"] }),
      };
    },
    writeProvisionedM365App: async () => {
      writeCalls++;
      return {
        ok: false,
        wroteCreds: false,
        stranded: true,
        error: "the app registration reports a valid credential but none is vaulted",
      };
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.stage, "write");
  assert.match(result.error ?? "", /none is vaulted/);
  assert.equal(provisionCalls, 2, "exactly one recovery re-provision, not an unbounded retry loop");
  assert.equal(writeCalls, 2, "exactly one recovery re-write, not an unbounded retry loop");
  assert.ok(result.actions.some((a) => a.includes("WARN could not verify granted roles")), "expected provisioning's WARN line to be surfaced");
});

// FINDING 9: a thrown dep must become a structured SetupResult, never an uncaught exception.
test("Finding 9: hasGlobalAdminSecret rejects -> ok:false, structured result, not a throw", async () => {
  const deps = happyDeps({
    hasGlobalAdminSecret: async () => {
      throw new Error("db connection reset");
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.ok(result.stage === "no-ga-secret" || result.stage === "error");
  assert.match(result.error ?? "", /db connection reset/);
});

test("Finding 9: startDeviceCode rejects -> structured result, not a throw", async () => {
  const deps = happyDeps({
    startDeviceCode: async () => {
      throw new Error("network unreachable");
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /network unreachable/);
});

test("Finding 9: dispatchDeviceCodeJob rejects -> structured result, not a throw", async () => {
  const deps = happyDeps({
    dispatchDeviceCodeJob: async () => {
      throw new Error("could not create CaseRequest");
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /could not create CaseRequest/);
});

test("Finding 9: pollDeviceCodeToken rejects -> structured result, not a throw", async () => {
  const deps = happyDeps({
    pollDeviceCodeToken: async () => {
      throw new Error("unexpected poll crash");
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /unexpected poll crash/);
});

test("Finding 9: provisionM365App rejects -> structured result, not a throw", async () => {
  const deps = happyDeps({
    provisionM365App: async () => {
      throw new Error("Graph fetch threw");
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Graph fetch threw/);
});

test("Finding 9: writeProvisionedM365App rejects -> structured result, not a throw", async () => {
  const deps = happyDeps({
    writeProvisionedM365App: async () => {
      throw new Error("db write threw");
    },
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /db write threw/);
});

test("never leaks the token, device code, client secret, or cert material into actions[] or any returned string", async () => {
  const deps = happyDeps({
    provisionM365App: async () => ({
      ok: true,
      result: provision({ clientSecret: "SUPER-SECRET-CLIENT-SECRET", certBase64: "BASE64-CERT-BYTES", certPassword: "CERT-PASSWORD" }),
    }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  const haystack = JSON.stringify(result);
  for (const secret of ["SECRET-DEVICE-CODE", "SECRET-GRAPH-TOKEN", "SUPER-SECRET-CLIENT-SECRET", "BASE64-CERT-BYTES", "CERT-PASSWORD"]) {
    assert.ok(!haystack.includes(secret), `leaked secret value in result: ${secret}`);
    for (const action of result.actions) assert.ok(!action.includes(secret), `leaked secret value in actions[]: ${secret}`);
  }
});

// extractWarnings — the helper the token-poll-failure path uses to pull WARN lines out of an opaque
// job result shape.
test("extractWarnings: finds WARN strings nested inside arrays/objects, ignores non-WARN strings", () => {
  const result = {
    status: "ok",
    actions: ["signed in", "WARN GA login rejected", { nested: ["fine", "WARN nested warning too"] }],
    other: "not a warning",
  };
  assert.deepEqual(extractWarnings(result), ["WARN GA login rejected", "WARN nested warning too"]);
});

test("extractWarnings: returns [] for null/undefined/non-matching shapes", () => {
  assert.deepEqual(extractWarnings(null), []);
  assert.deepEqual(extractWarnings(undefined), []);
  assert.deepEqual(extractWarnings({ actions: ["all good"] }), []);
});

// FINDING 8: WARN must be matched as a LINE TOKEN (trimmed line starting with "WARN"), not as a bare
// substring — a value that merely CONTAINS the four letters "WARN" (a name, a UPN) must not be flagged.
test("Finding 8: a value merely containing the substring WARN (not a WARN line) is not flagged", () => {
  const result = { actions: ["signed in as forwarden@x.com", "notified Edward WARNock", "onboarded aWARNaby@x.com"] };
  assert.deepEqual(extractWarnings(result), []);
});

test("Finding 8: a genuine WARN line (possibly with leading whitespace) IS flagged", () => {
  const result = { actions: ["  WARN could not sign in", "WARN MFA push not automatable"] };
  assert.deepEqual(extractWarnings(result), ["  WARN could not sign in", "WARN MFA push not automatable"]);
});

test("Finding 8: a WARN line embedded after a newline inside a multi-line string is still flagged", () => {
  const multiline = "started sign-in\nWARN GA login rejected\ndone";
  assert.deepEqual(extractWarnings({ log: multiline }), [multiline]);
});

// Provisioning's own step log (grant outcomes, cert issuance, Exchange lines) must land in the run
// log VERBATIM — without it a failed MailboxSettings.Read / Exchange.ManageAsApp grant is invisible
// (the 56977 diagnosis: logs showed only "provisioned", none of the grant lines).
test("provision's actions (grant outcomes, WARNs) are appended verbatim to the run log", async () => {
  const provActions = [
    "granted (admin-consented) User.ReadWrite.All",
    "WARN could not grant MailboxSettings.Read: Authorization_RequestDenied",
    "granted (admin-consented) Exchange.ManageAsApp",
    "added the app to the Exchange Administrator role",
    "issued + uploaded a new certificate",
  ];
  const deps = happyDeps({
    provisionM365App: async () => ({ ok: true, result: provision({ actions: provActions }) }),
  });
  const result = await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(result.ok, true);
  for (const line of provActions) {
    assert.ok(result.actions.includes(line), `run log must carry provision line: ${line}`);
  }
});

// The operator's "Rotate credentials" checkbox: forceReissue on the input must reach provisioning.
test("input.forceReissue is threaded into provisionM365App", async () => {
  let seen: unknown = "unset";
  const deps = happyDeps({
    provisionM365App: async (input) => { seen = input.forceReissue; return { ok: true, result: provision() }; },
  });
  await setupM365ForClient({ client: CLIENT, tenant: TENANT, forceReissue: true }, deps);
  assert.equal(seen, true);
  await setupM365ForClient({ client: CLIENT, tenant: TENANT }, deps);
  assert.equal(seen, undefined, "absent input stays absent (no accidental rotation)");
});
