import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGraphAppRoleIds, chosenRoleNames, provisionM365App } from "./provision-m365-app";
import { GRAPH_RESOURCE_APP_ID } from "./graph-caps";

const FAST = { backoff: () => 0 };
const OK = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const ERR = (status: number) => new Response("nope", { status });

test("chosenRoleNames: required+optional is the deduped suggested roles", () => {
  const names = chosenRoleNames("required+optional");
  assert.ok(names.includes("User.ReadWrite.All")); // required cap #1 suggested
  assert.ok(names.includes("Mail.Send")); // an optional cap suggested
  assert.equal(new Set(names).size, names.length); // no dupes
});

test("chosenRoleNames: required is just the required caps' suggested roles", () => {
  const names = chosenRoleNames("required");
  assert.ok(names.includes("User.ReadWrite.All"));
  assert.ok(!names.includes("Mail.Send"));
});

test("resolveGraphAppRoleIds: reads the Graph SP appRoles into a name->id map", async () => {
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    // graphGet emits the $filter literally (no URL-encoding) — match the REAL URL, not a guessed one.
    if (u.includes("/servicePrincipals") && u.includes("appId eq")) {
      return OK({
        value: [
          {
            id: "graph-sp",
            appRoles: [
              { id: "guid-user-rw", value: "User.ReadWrite.All" },
              { id: "guid-mail", value: "Mail.Send" },
            ],
          },
        ],
      });
    }
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;
  const r = await resolveGraphAppRoleIds("tok", f, FAST);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.graphSpId, "graph-sp");
  assert.equal(r.ok && r.roleIdByName.get("user.readwrite.all"), "guid-user-rw");
  assert.equal(r.ok && r.roleIdByName.get("mail.send"), "guid-mail");
});

test("resolveGraphAppRoleIds: no matching service principal is a clean error, not a throw", async () => {
  const f = (async () => OK({ value: [] })) as unknown as typeof fetch;
  const r = await resolveGraphAppRoleIds("tok", f, FAST);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /not found/i.test(r.error));
});

test("resolveGraphAppRoleIds: a Graph read failure is surfaced, not swallowed", async () => {
  const f = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const r = await resolveGraphAppRoleIds("tok", f, FAST);
  assert.equal(r.ok, false);
});

// ── provisionM365App ────────────────────────────────────────────────────────────────────────────
//
// A routing fetch mock covering every leg the function drives: resolving the tenant's Microsoft
// Graph service principal's app roles, find-or-create on the app registration, find-or-create on
// its service principal, readGrantedAppRoles' own assignment/resource-SP reads, and the
// appRoleAssignedTo consent POST. Modelled on graph-app-roles.test.ts's tenantFetch, extended to
// POSTs/PATCHes that read init.body so the test can assert on exactly what was sent.
const GRAPH_SP_ID = "graph-sp";
const ALL_ROLE_NAMES = chosenRoleNames("required+optional");
const GRAPH_APP_ROLES = ALL_ROLE_NAMES.map((name, i) => ({ id: `guid-${i}`, value: name }));
const roleId = (name: string): string => GRAPH_APP_ROLES.find((r) => r.value === name)!.id;

type Router = {
  fetch: typeof fetch;
  posts: { path: string; body: Record<string, unknown> }[];
  patches: { path: string; body: Record<string, unknown> }[];
  assigns: { principalId: unknown; resourceId: unknown; appRoleId: unknown }[];
};

// Default credentials-select response: a passwordCredential/keyCredential with NO endDateTime, which
// the reconcile rule treats as valid (never expires) — so by default no test other than the two
// Task-4 credential tests below exercises addPassword / the keyCredentials PATCH, and their
// pre-existing patch/post-count assertions (written before credentials existed) stay accurate.
const CREDS_ALREADY_VALID = () => OK({ passwordCredentials: [{}], keyCredentials: [{}] });

function router(
  over: {
    findApp?: () => Response;
    spFind?: () => Response;
    assignments?: () => Response;
    credsSelect?: () => Response;
    addPassword?: () => Response;
    graphSpRoles?: () => Response; // the tenant's Microsoft Graph SP's appRoles (resolveGraphAppRoleIds)
    resourceSpAppRoles?: () => Response; // a resource SP's appRoles, as read back by readGrantedAppRoles
    exoSp?: () => Response; // the Office 365 Exchange Online SP (grantExchangeOnline) — default: not found
    directoryRoles?: () => Response; // activated directory roles (ensureDirectoryRoleActivated)
  } = {}
): Router {
  const posts: Router["posts"] = [];
  const patches: Router["patches"] = [];
  const assigns: Router["assigns"] = [];

  const f = (async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = () => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

    // resolveGraphAppRoleIds: the Microsoft Graph resource SP itself
    if (method === "GET" && u.includes("/servicePrincipals") && u.includes(`appId eq '${GRAPH_RESOURCE_APP_ID}'`)) {
      return over.graphSpRoles ? over.graphSpRoles() : OK({ value: [{ id: GRAPH_SP_ID, appRoles: GRAPH_APP_ROLES }] });
    }
    // find app
    if (method === "GET" && u.includes("/applications?$filter=displayName")) {
      return over.findApp ? over.findApp() : OK({ value: [] });
    }
    // create app
    if (method === "POST" && u.endsWith("/applications")) {
      const b = body(); posts.push({ path: "/applications", body: b });
      return OK({ id: "obj-1", appId: "app-1" });
    }
    // credentials reconcile: GET passwordCredentials/keyCredentials
    if (method === "GET" && u.includes("/applications/") && u.includes("$select=passwordCredentials")) {
      return over.credsSelect ? over.credsSelect() : CREDS_ALREADY_VALID();
    }
    // issue a new client secret
    if (method === "POST" && u.endsWith("/addPassword")) {
      const b = body(); posts.push({ path: "/addPassword", body: b });
      return over.addPassword ? over.addPassword() : OK({ secretText: "the-secret" });
    }
    // reconcile app (PATCH) — also hit by the credentials leg's keyCredentials upload; distinguish by body
    if (method === "PATCH" && u.includes("/applications/")) {
      const b = body(); patches.push({ path: u, body: b });
      return OK({});
    }
    // Exchange Online SP lookup (grantExchangeOnline) — a DISTINCT appId from our app's SP; default
    // "not found" so the Exchange grant aborts (best-effort) and pre-existing count assertions hold.
    if (method === "GET" && u.includes("/servicePrincipals") && u.includes("appId eq '00000002-0000-0ff1-ce00-000000000000'")) {
      return over.exoSp ? over.exoSp() : OK({ value: [] });
    }
    // Exchange Administrator directory role (ensureDirectoryRoleActivated)
    if (method === "GET" && u.includes("/directoryRoles")) {
      return over.directoryRoles ? over.directoryRoles() : OK({ value: [] });
    }
    if (method === "POST" && u.endsWith("/directoryRoles")) {
      return OK({ id: "exo-admin-role" });
    }
    if (method === "POST" && u.includes("/directoryRoles/") && u.endsWith("/members/$ref")) {
      posts.push({ path: "/directoryRoles/members/$ref", body: body() });
      return OK({});
    }
    // find our app's SP
    if (method === "GET" && u.includes("/servicePrincipals?$filter=appId eq")) {
      return over.spFind ? over.spFind() : OK({ value: [] });
    }
    // create our app's SP
    if (method === "POST" && u.endsWith("/servicePrincipals")) {
      const b = body(); posts.push({ path: "/servicePrincipals", body: b });
      return OK({ id: "app-sp" });
    }
    // readGrantedAppRoles: our app's own assignments
    if (u.includes("/appRoleAssignments")) {
      return over.assignments ? over.assignments() : OK({ value: [] });
    }
    // readGrantedAppRoles: resolve a resource SP's appRoles (id -> name)
    if (method === "GET" && /\/servicePrincipals\/[^/?]+\?\$select=appRoles/.test(u)) {
      return over.resourceSpAppRoles ? over.resourceSpAppRoles() : OK({ appRoles: GRAPH_APP_ROLES });
    }
    // admin-consent
    if (method === "POST" && u.includes("/appRoleAssignedTo")) {
      const b = body(); assigns.push(b as Router["assigns"][number]);
      return OK({ id: "a" });
    }
    throw new Error(`unexpected ${method} ${u}`);
  }) as unknown as typeof fetch;

  return { fetch: f, posts, patches, assigns };
}

test("provisionM365App: fresh tenant — creates app + SP, admin-consents every chosen role", async () => {
  const r = router();
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const actions = result.result.actions;

  const appCreate = r.posts.find((p) => p.path === "/applications");
  assert.ok(appCreate, "expected a POST to /applications");
  assert.deepEqual(appCreate!.body.tags, ["ctg:iam-engine"]);
  const rra = appCreate!.body.requiredResourceAccess as { resourceAppId: string; resourceAccess: { id: string; type: string }[] }[];
  assert.equal(rra.length, 2); // Graph block + the Exchange Online block
  assert.equal(rra[0].resourceAppId, GRAPH_RESOURCE_APP_ID);
  assert.equal(rra[0].resourceAccess.length, ALL_ROLE_NAMES.length);
  assert.deepEqual(new Set(rra[0].resourceAccess.map((x) => x.id)), new Set(ALL_ROLE_NAMES.map(roleId)));
  // The Exchange Online block declares Exchange.ManageAsApp (Office 365 Exchange Online resource).
  const exoBlock = rra.find((b) => b.resourceAppId === "00000002-0000-0ff1-ce00-000000000000");
  assert.ok(exoBlock, "expected an Exchange Online resource block");
  assert.ok(exoBlock!.resourceAccess.some((x) => x.id === "dc50a0fb-09a3-484d-be87-e023b12c6440"), "Exchange.ManageAsApp must be declared");

  const spCreate = r.posts.find((p) => p.path === "/servicePrincipals");
  assert.ok(spCreate, "expected a POST to /servicePrincipals");
  assert.equal(spCreate!.body.appId, "app-1");

  assert.equal(r.assigns.length, ALL_ROLE_NAMES.length);
  for (const a of r.assigns) {
    assert.equal(a.principalId, "app-sp");
    assert.equal(a.resourceId, GRAPH_SP_ID);
  }
  assert.deepEqual(new Set(r.assigns.map((a) => a.appRoleId)), new Set(ALL_ROLE_NAMES.map(roleId)));

  assert.ok(actions.some((a) => a === "created app registration app-1"));
  assert.ok(actions.some((a) => a === "created service principal"));
  for (const name of ALL_ROLE_NAMES) {
    assert.ok(actions.some((a) => a === `granted (admin-consented) ${name}`));
  }
});

test("provisionM365App: untagged same-name app is NOT adopted — creates a new tagged app instead", async () => {
  // Entra does not enforce displayName uniqueness. A same-name app that lacks APP_TAG is some
  // unrelated registration; adopting it (PATCHing permissions, admin-consenting roles onto it) would
  // hijack the wrong app. The fix: only a TAGGED match counts as "found" — an untagged same-name hit
  // must fall through to create.
  const r = router({
    findApp: () => OK({ value: [{ id: "other", appId: "other-app" /* no tags */ }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  const appCreate = r.posts.find((p) => p.path === "/applications");
  assert.ok(appCreate, "expected a POST to /applications — the untagged app must not be adopted");
  assert.deepEqual(appCreate!.body.tags, ["ctg:iam-engine"]);

  assert.equal(r.patches.length, 0, "must NOT PATCH the untagged same-name app");
  assert.ok(!r.patches.some((p) => p.path.endsWith("/applications/other")));

  assert.ok(result.result.actions.some((a) => a === "created app registration app-1"));
});

test("provisionM365App: reconcile — existing tagged app + SP get PATCHed, not re-created", async () => {
  const r = router({
    findApp: () => OK({ value: [{ id: "obj-1", appId: "app-1", tags: ["ctg:iam-engine"] }] }),
    spFind: () => OK({ value: [{ id: "app-sp" }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(r.posts.filter((p) => p.path === "/applications").length, 0, "must not create a duplicate app");
  assert.equal(r.posts.filter((p) => p.path === "/servicePrincipals").length, 0, "must not create a duplicate SP");
  // exactly one PATCH: the requiredResourceAccess reconcile. Credentials default to "already valid"
  // (see CREDS_ALREADY_VALID), so the credentials leg issues nothing and adds no second PATCH here.
  assert.equal(r.patches.length, 1);
  assert.ok(r.patches[0].path.endsWith("/applications/obj-1"));
  const rra = r.patches[0].body.requiredResourceAccess as { resourceAccess: { id: string }[] }[];
  assert.equal(rra[0].resourceAccess.length, ALL_ROLE_NAMES.length);

  assert.ok(result.result.actions.some((a) => a === "found existing app app-1 — reconciled requiredResourceAccess"));
  assert.ok(!result.result.actions.some((a) => a.startsWith("created app registration")));
  // still consents every role — none reported as already granted in this scenario
  assert.equal(r.assigns.length, ALL_ROLE_NAMES.length);
});

test("provisionM365App: admin-consent skips a role already granted", async () => {
  const skipped = ALL_ROLE_NAMES[0];
  const r = router({
    assignments: () => OK({ value: [{ appRoleId: roleId(skipped), resourceId: GRAPH_SP_ID }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.ok(result.result.actions.some((a) => a === `role already granted: ${skipped}`));
  assert.equal(r.assigns.length, ALL_ROLE_NAMES.length - 1, "the already-granted role must not get a second assignment POST");
  assert.ok(!r.assigns.some((a) => a.appRoleId === roleId(skipped)));
});

// ── credentials (reconcile rule) + verify ──────────────────────────────────────────────────────────

test("provisionM365App: fresh app — issues client secret + certificate, no gaps when fully granted", async () => {
  const r = router({
    // no valid passwordCredentials/keyCredentials on the app yet — both must be issued
    credsSelect: () => OK({ passwordCredentials: [], keyCredentials: [] }),
    // the final verify (and the admin-consent already-granted check) both read this: report every
    // chosen role as granted so `graphCapGaps` finds nothing missing.
    assignments: () => OK({ value: ALL_ROLE_NAMES.map((name) => ({ appRoleId: roleId(name), resourceId: GRAPH_SP_ID })) }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.clientSecret, "the-secret");
  assert.ok(result.result.certBase64, "expected a certBase64 to be issued");
  assert.ok(result.result.certPassword, "expected a certPassword to be issued");
  assert.ok(result.result.certThumbprint, "expected a certThumbprint to be issued");
  assert.match(result.result.certThumbprint!, /^[0-9A-F]+$/, "thumbprint should be uppercase hex");
  assert.equal(result.result.created, true);
  assert.equal(result.result.credState, "issued");
  assert.deepEqual(result.result.gaps, []);

  assert.ok(r.posts.some((p) => p.path === "/addPassword"), "expected a POST to .../addPassword");
  assert.ok(r.patches.some((p) => "keyCredentials" in p.body), "expected a PATCH carrying keyCredentials");

  assert.ok(result.result.actions.some((a) => a === "issued a new client secret"));
  assert.ok(result.result.actions.some((a) => a === "issued + uploaded a new certificate"));
});

test("provisionM365App: reconcile-keep — a non-expired secret + cert are kept, nothing re-issued", async () => {
  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const r = router({
    credsSelect: () => OK({ passwordCredentials: [{ endDateTime: future }], keyCredentials: [{ endDateTime: future }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.clientSecret, undefined, "must not report a secret that was merely kept");
  assert.equal(result.result.certBase64, undefined, "must not report a cert that was merely kept");
  assert.equal(result.result.certPassword, undefined);
  assert.equal(result.result.credState, "kept-valid");

  assert.ok(!r.posts.some((p) => p.path === "/addPassword"), "addPassword must NOT be called when a valid secret already exists");
  assert.ok(!r.patches.some((p) => "keyCredentials" in p.body), "no keyCredentials PATCH must fire when a valid cert already exists");

  assert.ok(result.result.actions.some((a) => a === "kept existing client secret + certificate (both valid)"));
});

// The core1787 bug: an existing app whose SECRET is missing/expired but whose CERT is still valid. The
// old code re-issued only the secret and KEPT the cert, so certBase64/certPassword stayed undefined and
// never reached Delinea (56977 got the secret, no cert). Secret+cert are a unit: issue BOTH.
test("provisionM365App: secret missing but cert valid -> re-issues BOTH (cert material must be vaultable)", async () => {
  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const r = router({
    // No password credentials (secret missing/expired), but a still-valid cert.
    credsSelect: () => OK({ passwordCredentials: [], keyCredentials: [{ endDateTime: future }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.credState, "issued");
  assert.equal(result.result.clientSecret, "the-secret", "a fresh secret is issued");
  assert.ok(result.result.certBase64, "the cert is ALSO re-issued so its base64 can be vaulted");
  assert.ok(result.result.certPassword, "the cert password is produced to vault");
  assert.ok(r.posts.some((p) => p.path === "/addPassword"), "addPassword fired");
  assert.ok(r.patches.some((p) => "keyCredentials" in p.body), "keyCredentials PATCH fired — cert rotated as a unit");
});

// ── forceReissue (stranded-credential recovery, see setup-m365-client.ts) ──────────────────────────

test("provisionM365App: forceReissue mints a fresh secret AND a fresh cert even though valid ones exist", async () => {
  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const r = router({
    credsSelect: () => OK({ passwordCredentials: [{ endDateTime: future }], keyCredentials: [{ endDateTime: future }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1", forceReissue: true }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.clientSecret, "the-secret", "forceReissue must mint (and report) a fresh secret");
  assert.equal(result.result.credState, "issued");
  assert.ok(r.posts.some((p) => p.path === "/addPassword"), "expected a POST to .../addPassword despite an existing valid secret");
  assert.ok(result.result.actions.some((a) => a === "issued a new client secret"));

  // forceReissue is the stranded-recovery rotation: nothing real is vaulted, so the KEPT cert's PFX +
  // password are unrecoverable too. It must rotate the certificate as well, so the recovery vaults a
  // COMPLETE, usable credential (secret + cert base64/password) rather than a secret with no cert material.
  assert.ok(result.result.certBase64, "forceReissue must mint a fresh cert (its base64 is needed to vault a complete credential)");
  assert.ok(result.result.certPassword, "forceReissue must produce the fresh cert's password to vault");
  assert.ok(r.patches.some((p) => "keyCredentials" in p.body), "expected a keyCredentials PATCH — the cert is rotated under forceReissue");
  assert.ok(result.result.actions.some((a) => a === "issued + uploaded a new certificate"));
});

test("provisionM365App: without forceReissue, an existing valid secret is kept (baseline contrast)", async () => {
  const future = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const r = router({
    credsSelect: () => OK({ passwordCredentials: [{ endDateTime: future }], keyCredentials: [{ endDateTime: future }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.credState, "kept-valid");
  assert.ok(!r.posts.some((p) => p.path === "/addPassword"), "addPassword must NOT be called without forceReissue when a valid secret already exists");
});

// ── Fix A / Finding 2: a failed credentials GET must NOT re-mint/clobber creds on an EXISTING app,
// but MUST issue on a just-created app (which provably has no credential to clobber) ───────────────

test("provisionM365App: Fix A — a failed credentials GET on an EXISTING app issues nothing and WARNs, credState unverified", async () => {
  const r = router({
    findApp: () => OK({ value: [{ id: "obj-1", appId: "app-1", tags: ["ctg:iam-engine"] }] }),
    spFind: () => OK({ value: [{ id: "app-sp" }] }),
    credsSelect: () => ERR(403),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.created, false);
  assert.equal(result.result.credState, "unverified");
  assert.equal(result.result.clientSecret, undefined);
  assert.equal(result.result.certBase64, undefined);
  assert.equal(result.result.certPassword, undefined);
  assert.ok(!r.posts.some((p) => p.path === "/addPassword"), "a failed creds read on an existing app must not trigger addPassword");
  assert.ok(!r.patches.some((p) => "keyCredentials" in p.body), "a failed creds read on an existing app must not trigger a keyCredentials PATCH");
  assert.ok(result.result.actions.some(
    (a) => a === "WARN could not read existing credentials — skipping credential issuance this run (kept whatever exists)"
  ));
});

test("provisionM365App: Finding 2 — a failed credentials GET on a NEWLY CREATED app issues credentials anyway, credState issued", async () => {
  // default router: findApp returns no match -> the app is created THIS run, so it provably has no
  // credential yet. The "never clobber a good vaulted secret" rationale does not apply.
  const r = router({ credsSelect: () => ERR(403) });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.created, true);
  assert.equal(result.result.credState, "issued");
  assert.equal(result.result.clientSecret, "the-secret");
  assert.ok(result.result.certBase64, "expected a certBase64 to be issued on the new app");
  assert.ok(result.result.certPassword, "expected a certPassword to be issued on the new app");
  assert.ok(r.posts.some((p) => p.path === "/addPassword"), "a newly created app must have its client secret issued despite the failed read");
  assert.ok(r.patches.some((p) => "keyCredentials" in p.body), "a newly created app must have its certificate issued despite the failed read");
  assert.ok(result.result.actions.some((a) => a.startsWith("WARN could not read credentials on the just-created app")));
});

// ── Fix B: the final verify must honor `complete` ──────────────────────────────────────────────────

test("provisionM365App: Fix B — an incomplete post-grant verify must not report all-required-missing", async () => {
  // an assignment whose appRoleId cannot be resolved to a name makes readGrantedAppRoles incomplete
  const r = router({
    assignments: () => OK({ value: [{ appRoleId: "unresolvable-id", resourceId: GRAPH_SP_ID }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.verified, false);
  assert.deepEqual(result.result.gaps, [], "an unverified read must never report gaps as all-missing");
  assert.deepEqual(result.result.optionalGaps, []);
  assert.ok(result.result.actions.some(
    (a) => a === "WARN could not verify granted roles (read incomplete) — consent may still be propagating"
  ));
  // this is a READ problem, not a grant problem — the writes still went out
  assert.equal(r.assigns.length, ALL_ROLE_NAMES.length);
});

// ── Fix C: existing-app PATCH must MERGE requiredResourceAccess, not replace ──────────────────────

test("provisionM365App: Fix C — reconcile PATCH preserves a non-Graph block and unions extra Graph roles", async () => {
  const EXTRA_GRAPH_ROLE_ID = "extra-hand-added-role-id";
  // A resource we DON'T manage (SharePoint) — it must survive the reconcile untouched. (Exchange, which
  // we DO manage now, is asserted separately below.)
  const NON_GRAPH_BLOCK = { resourceAppId: "00000003-0000-0ff1-ce00-000000000000", resourceAccess: [{ id: "some-sharepoint-role", type: "Role" }] };
  const r = router({
    findApp: () => OK({
      value: [{
        id: "obj-1", appId: "app-1", tags: ["ctg:iam-engine"],
        requiredResourceAccess: [
          NON_GRAPH_BLOCK,
          { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [{ id: EXTRA_GRAPH_ROLE_ID, type: "Role" }] },
        ],
      }],
    }),
    spFind: () => OK({ value: [{ id: "app-sp" }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);

  assert.equal(r.patches.length, 1);
  const rra = r.patches[0].body.requiredResourceAccess as { resourceAppId: string; resourceAccess: { id: string }[] }[];

  const nonGraph = rra.find((b) => b.resourceAppId === NON_GRAPH_BLOCK.resourceAppId);
  assert.ok(nonGraph, "the non-Graph resource block must survive the reconcile");
  assert.deepEqual(nonGraph!.resourceAccess, NON_GRAPH_BLOCK.resourceAccess);

  const graphBlock = rra.find((b) => b.resourceAppId === GRAPH_RESOURCE_APP_ID);
  assert.ok(graphBlock, "expected a Graph resource block");
  const graphIds = graphBlock!.resourceAccess.map((x) => x.id);
  assert.ok(graphIds.includes(EXTRA_GRAPH_ROLE_ID), "a hand-added Graph role must survive (union, not replace)");
  for (const name of ALL_ROLE_NAMES) assert.ok(graphIds.includes(roleId(name)), `wanted role ${name} must still be present`);

  // The reconcile also ensures the Exchange Online block carries Exchange.ManageAsApp.
  const exoBlock = rra.find((b) => b.resourceAppId === "00000002-0000-0ff1-ce00-000000000000");
  assert.ok(exoBlock, "expected an Exchange Online resource block after reconcile");
  assert.ok(exoBlock!.resourceAccess.some((x) => x.id === "dc50a0fb-09a3-484d-be87-e023b12c6440"), "Exchange.ManageAsApp must be present");
});

test("provisionM365App: Exchange app-only — grants Exchange.ManageAsApp and the Exchange Administrator role", async () => {
  const r = router({
    findApp: () => OK({ value: [{ id: "obj-1", appId: "app-1", tags: ["ctg:iam-engine"] }] }),
    spFind: () => OK({ value: [{ id: "app-sp" }] }),
    exoSp: () => OK({ value: [{ id: "exo-sp" }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  // admin-consent for Exchange.ManageAsApp against the EXO service principal
  const exoAssign = r.assigns.find((a) => a.appRoleId === "dc50a0fb-09a3-484d-be87-e023b12c6440");
  assert.ok(exoAssign, "expected an Exchange.ManageAsApp appRoleAssignedTo");
  assert.equal(exoAssign!.principalId, "app-sp");
  assert.equal(exoAssign!.resourceId, "exo-sp");

  // the app SP added to the (activated) Exchange Administrator directory role
  const roleAdd = r.posts.find((p) => p.path === "/directoryRoles/members/$ref");
  assert.ok(roleAdd, "expected the app to be added to the Exchange Administrator role");
  assert.match(String(roleAdd!.body["@odata.id"]), /directoryObjects\/app-sp$/);

  assert.equal(result.result.exchangeReady, true);
  assert.ok(result.result.actions.some((a) => a === "granted (admin-consented) Exchange.ManageAsApp"));
  assert.ok(result.result.actions.some((a) => a === "added the app to the Exchange Administrator role"));
});

// ── Fix E: an unresolvable OPTIONAL role is skipped, a REQUIRED one is fatal ───────────────────────

test("provisionM365App: Fix E — an unresolvable optional role is skipped with a WARN; run proceeds", async () => {
  const requiredNames = new Set(chosenRoleNames("required"));
  const missingOptional = ALL_ROLE_NAMES.find((n) => !requiredNames.has(n))!;
  const trimmedRoles = GRAPH_APP_ROLES.filter((r) => r.value !== missingOptional);
  const r = router({ graphSpRoles: () => OK({ value: [{ id: GRAPH_SP_ID, appRoles: trimmedRoles }] }) });

  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.ok(result.result.actions.some((a) => a === `WARN optional Graph role not found in tenant, skipping: ${missingOptional}`));
  for (const name of chosenRoleNames("required")) {
    assert.ok(result.result.actions.some((a) => a === `granted (admin-consented) ${name}`), `expected ${name} to still be granted`);
  }
});

test("provisionM365App: Fix E — an unresolvable REQUIRED role is fatal", async () => {
  const missingRequired = chosenRoleNames("required")[0];
  const trimmedRoles = GRAPH_APP_ROLES.filter((r) => r.value !== missingRequired);
  const r = router({ graphSpRoles: () => OK({ value: [{ id: GRAPH_SP_ID, appRoles: trimmedRoles }] }) });

  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.error, /not found in tenant/);
});

// ── Fix F: decide grants by CAPABILITY, not exact role name ────────────────────────────────────────

test("provisionM365App: Fix F — a cap already satisfied by a BROADER granted role is not re-granted", async () => {
  const DW_ID = "guid-directory-readwrite-all"; // Directory.ReadWrite.All is not itself in ALL_ROLE_NAMES
  const r = router({
    assignments: () => OK({ value: [{ appRoleId: DW_ID, resourceId: GRAPH_SP_ID }] }),
    resourceSpAppRoles: () => OK({ appRoles: [...GRAPH_APP_ROLES, { id: DW_ID, value: "Directory.ReadWrite.All" }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  // every required cap's suggested role is covered by Directory.ReadWrite.All — none should be re-granted
  assert.ok(!r.assigns.some((a) => a.appRoleId === roleId("User.ReadWrite.All")));
  assert.ok(!r.assigns.some((a) => a.appRoleId === roleId("Group.ReadWrite.All")));
  assert.ok(result.result.actions.some((a) => a === "role already granted: User.ReadWrite.All"));
});

// ── Fix G: note an incomplete pre-grant read ────────────────────────────────────────────────────────

test("provisionM365App: Fix G — an incomplete pre-grant read gets one legible note", async () => {
  const r = router({
    assignments: () => OK({ value: [{ appRoleId: "unresolvable-id", resourceId: GRAPH_SP_ID }] }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.ok(result.result.actions.some((a) => a === "note: existing-consent read was incomplete — some grants may be re-attempted"));
});

// ── Fix H: surface failed OPTIONAL grants via optionalGaps ─────────────────────────────────────────

test("provisionM365App: Fix H — a missing optional grant surfaces in optionalGaps, required gaps stay clean", async () => {
  const missingOptionalRole = "Mail.Send";
  const grantedNames = ALL_ROLE_NAMES.filter((n) => n !== missingOptionalRole);
  const r = router({
    assignments: () => OK({ value: grantedNames.map((name) => ({ appRoleId: roleId(name), resourceId: GRAPH_SP_ID })) }),
  });
  const result = await provisionM365App({ graphToken: "tok", tenantId: "ten-1" }, r.fetch, FAST);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");

  assert.equal(result.result.verified, true);
  assert.deepEqual(result.result.gaps, [], "required caps are all satisfied");
  assert.ok(result.result.optionalGaps.includes(missingOptionalRole));
});
