// Provision the m365-admin app registration end to end: create the app + service principal, grant the
// Graph app roles it needs, generate its Exchange Online client certificate, and hand back everything
// Delinea needs to store. This file starts with the piece every later step depends on: resolving each
// Graph app-role NAME (e.g. "User.ReadWrite.All") to the GUID Graph's approle-assignment API actually
// wants — GRAPH_APP_ROLE_IDS in graph-caps.ts is a hand-maintained, PARTIAL map (it only carries the
// roles we print in manual grant instructions, and omits every required-cap role), so provisioning
// reads the tenant's own Microsoft Graph service principal instead. That is also self-consistent with
// readGrantedAppRoles, which resolves the same ids back to names in reverse off the same object.
import { graphGet, graphSend, readGrantedAppRoles, type GraphFetch, type GraphRetryOpts } from "./graph-app-roles";
import { GRAPH_RESOURCE_APP_ID, GRAPH_REQUIRED_CAPS, GRAPH_OPTIONAL_CAPS, suggestedRole, graphCapGaps, satisfied, roleNamesForOptionalSelection } from "./graph-caps";
import { generateExoCert } from "../m365/exo-cert";
import { generatePassword } from "../auth/password";

export type GraphSpRoles = { graphSpId: string; roleIdByName: Map<string, string> };

// The Graph app-role NAMES to grant, deduped, using each cap's least-privilege suggested role (its
// first `anyOf` entry — see suggestedRole in graph-caps.ts).
export function chosenRoleNames(caps: "required" | "required+optional"): string[] {
  const list = caps === "required+optional" ? [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS] : [...GRAPH_REQUIRED_CAPS];
  return [...new Set(list.map((c) => suggestedRole(c)))];
}

// Resolve every Graph app-role NAME to its application-appRole GUID by reading the tenant's Microsoft
// Graph service principal's appRoles — robust vs. a static GUID map, and the same object
// readGrantedAppRoles reads to map id->name in reverse.
export async function resolveGraphAppRoleIds(
  token: string,
  fetcher: GraphFetch = fetch,
  opts: GraphRetryOpts = {}
): Promise<({ ok: true } & GraphSpRoles) | { ok: false; error: string }> {
  const r = await graphGet<{ value?: { id?: string; appRoles?: { id?: string; value?: string }[] }[] }>(
    token,
    `/servicePrincipals?$filter=appId eq '${GRAPH_RESOURCE_APP_ID}'&$select=id,appRoles`,
    fetcher,
    opts
  );
  if (!r.ok) return { ok: false, error: r.error };
  const sp = r.body.value?.[0];
  if (!sp?.id) return { ok: false, error: "Microsoft Graph service principal not found in tenant" };
  const roleIdByName = new Map<string, string>();
  for (const role of sp.appRoles ?? []) {
    if (role.id && role.value) roleIdByName.set(String(role.value).toLowerCase(), String(role.id));
  }
  return { ok: true, graphSpId: sp.id, roleIdByName };
}

// Exchange Online app-only auth needs THREE things, only one of which (the certificate) provisioning
// used to supply. The other two live on a DIFFERENT resource than Microsoft Graph, so they don't fit
// the GraphCap table and are granted here directly:
//   - the `Exchange.ManageAsApp` application permission on the "Office 365 Exchange Online" resource,
//   - the app's service principal added to the "Exchange Administrator" directory role (assigned ACTIVE).
// See web/app/help/cloud-auth/page.tsx and the runner's Connect-CtgExchange error hints.
const EXO_RESOURCE_APP_ID = "00000002-0000-0ff1-ce00-000000000000"; // Office 365 Exchange Online
const EXO_MANAGE_AS_APP_ROLE_ID = "dc50a0fb-09a3-484d-be87-e023b12c6440"; // Exchange.ManageAsApp (application role)
const EXCHANGE_ADMIN_ROLE_TEMPLATE_ID = "29232cdf-9323-42fd-ade2-1d097af3e4de"; // Exchange Administrator directory role

// /directoryRoles lists only the roles a tenant has ACTIVATED from their templates. Resolve our role's
// activated id, activating it from its template if the tenant hasn't yet. Returns the directoryRole id.
async function ensureDirectoryRoleActivated(
  token: string, roleTemplateId: string, fetcher: GraphFetch, opts: GraphRetryOpts
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const list = await graphGet<{ value?: { id?: string; roleTemplateId?: string }[] }>(
    token, `/directoryRoles?$select=id,roleTemplateId`, fetcher, opts);
  if (list.ok) {
    const hit = (list.body.value ?? []).find((r) => r.roleTemplateId === roleTemplateId);
    if (hit?.id) return { ok: true, id: hit.id };
  }
  const act = await graphSend<{ id?: string }>(token, "POST", "/directoryRoles", { roleTemplateId }, fetcher, opts);
  if (act.ok && act.body?.id) return { ok: true, id: act.body.id };
  // Activation can 409 when it was already active but our list read missed it — re-read once.
  const relist = await graphGet<{ value?: { id?: string; roleTemplateId?: string }[] }>(
    token, `/directoryRoles?$select=id,roleTemplateId`, fetcher, opts);
  const hit2 = relist.ok ? (relist.body.value ?? []).find((r) => r.roleTemplateId === roleTemplateId) : undefined;
  if (hit2?.id) return { ok: true, id: hit2.id };
  return { ok: false, error: act.ok ? "activated role returned no id" : act.error };
}

// Grant everything Exchange Online app-only needs BEYOND the certificate: the Exchange.ManageAsApp app
// permission (admin-consented) + the Exchange Administrator role membership. Best-effort and fully
// reported: a tenant where these fail (e.g. the GA lacks RoleManagement.ReadWrite.Directory consent)
// still completes the rest of setup, and the WARNs say exactly what to finish by hand. Idempotent —
// Graph rejects a duplicate assignment, which we read as "already granted", not a failure.
async function grantExchangeOnline(
  token: string, appSpId: string, fetcher: GraphFetch, opts: GraphRetryOpts
): Promise<{ ok: boolean; actions: string[] }> {
  const actions: string[] = [];
  const exo = await graphGet<{ value?: { id?: string }[] }>(
    token, `/servicePrincipals?$filter=appId eq '${EXO_RESOURCE_APP_ID}'&$select=id`, fetcher, opts);
  const exoSpId = exo.ok ? exo.body.value?.[0]?.id : undefined;
  if (!exoSpId) {
    actions.push(`WARN could not resolve the Exchange Online service principal — Exchange app-only not granted (${exo.ok ? "not found in tenant" : exo.error})`);
    return { ok: false, actions };
  }
  const dup = (e: string) => /already|exists|conflict|added object references already exist/i.test(e);

  const grant = await graphSend(token, "POST", `/servicePrincipals/${exoSpId}/appRoleAssignedTo`,
    { principalId: appSpId, resourceId: exoSpId, appRoleId: EXO_MANAGE_AS_APP_ROLE_ID }, fetcher, opts);
  if (grant.ok) actions.push("granted (admin-consented) Exchange.ManageAsApp");
  else if (dup(grant.error)) actions.push("Exchange.ManageAsApp already granted");
  else { actions.push(`WARN could not grant Exchange.ManageAsApp: ${grant.error}`); return { ok: false, actions }; }

  const role = await ensureDirectoryRoleActivated(token, EXCHANGE_ADMIN_ROLE_TEMPLATE_ID, fetcher, opts);
  if (!role.ok) { actions.push(`WARN could not resolve/activate the Exchange Administrator role: ${role.error}`); return { ok: false, actions }; }
  const add = await graphSend(token, "POST", `/directoryRoles/${role.id}/members/$ref`,
    { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${appSpId}` }, fetcher, opts);
  if (add.ok) actions.push("added the app to the Exchange Administrator role");
  else if (dup(add.error)) actions.push("app already in the Exchange Administrator role");
  else { actions.push(`WARN could not add the app to the Exchange Administrator role: ${add.error}`); return { ok: false, actions }; }
  return { ok: true, actions };
}

// ── provisionM365App ────────────────────────────────────────────────────────────────────────────
//
// Finds-or-creates the iam-engine app registration, sets its requiredResourceAccess to the chosen
// Graph app roles, finds-or-creates the app's service principal, admin-consents each role (skipping
// ones already granted), reconciles its credentials (client secret + Exchange Online certificate —
// issuing a new one ONLY when none valid exists), and finally verifies what got granted against the
// capability table so a caller learns about any gap immediately instead of on the first failed step.
//
// Idempotency matters here specifically because this runs over HTTP against Graph, which means a
// caller retry (timeout, dropped connection, a re-run of a stuck job) must never double-POST. The
// app is found-before-create by `displayName eq 'iam-engine'` filtered to the `ctg:iam-engine` tag,
// and the SP is found-before-create by appId — both reads happen before any write, so a retry lands
// on the existing object instead of minting a duplicate.
export type ProvisionInput = {
  graphToken: string;
  tenantId: string;
  caps?: "required" | "required+optional";
  issueCreds?: boolean;
  // Mint a FRESH client secret even though the existing app already has a still-valid one — the
  // stranded-credential recovery path (see setup-m365-client.ts): a prior run's write to Delinea
  // failed AFTER Graph already issued a secret, so the vaulted value is unrecoverable and the only
  // fix is to rotate. Targets the client SECRET only — a valid certificate is still kept as-is.
  forceReissue?: boolean;
  // An explicit selection of OPTIONAL caps to grant, each identified by its suggestedRole (see
  // graph-caps.roleNamesForOptionalSelection). When present it wins over `caps`: the app gets every
  // required role plus exactly the chosen optional roles — the operator's opt-in from the setup modal.
  // `[]` therefore means required-only. Absent → fall back to the `caps` all-or-nothing default.
  optionalRoles?: string[];
};

// credState tells a caller how much to trust the credential material on this result — never infer
// trustworthiness from whether clientSecret/certBase64 strings happen to be set:
//   "issued"      — a NEW secret and/or cert was minted THIS run. Must be vaulted (it's the only copy).
//   "kept-valid"  — the existing-credentials READ SUCCEEDED and found a still-valid credential, so
//                   nothing was re-issued. Whatever is already vaulted is trusted to still be correct.
//   "unverified"  — the existing-credentials READ FAILED (transient Graph error), so we genuinely don't
//                   know whether a valid credential exists. Fail-safe: nothing was issued. NOT a success
//                   a caller should report as "set up" — see write-m365-app.ts / setup-m365-client.ts.
export type CredState = "issued" | "kept-valid" | "unverified";

export type ProvisionResult = {
  appId: string;
  objectId: string;
  spId: string;
  tenantId: string;
  clientSecret?: string;
  certBase64?: string;
  certPassword?: string;
  certThumbprint?: string; // not a secret — safe to carry/log; the "certificate thumbprint" Delinea field
  credState: CredState;
  created: boolean;
  granted: string[];
  gaps: string[];
  optionalGaps: string[];
  verified: boolean;
  // Exchange Online app-only was fully granted this run (Exchange.ManageAsApp + Exchange Administrator
  // role). False when a piece couldn't be granted — the actions log carries the WARN with what's left.
  exchangeReady: boolean;
  actions: string[];
};

const APP_DISPLAY_NAME = "iam-engine";
const APP_TAG = "ctg:iam-engine";

export async function provisionM365App(
  input: ProvisionInput,
  fetcher: GraphFetch = fetch,
  opts: GraphRetryOpts = {}
): Promise<{ ok: true; result: ProvisionResult } | { ok: false; error: string; actions: string[] }> {
  const { graphToken: token, tenantId } = input;
  const caps = input.caps ?? "required+optional";
  const actions: string[] = [];

  const roles = await resolveGraphAppRoleIds(token, fetcher, opts);
  if (!roles.ok) return { ok: false, error: `resolve Graph app roles: ${roles.error}`, actions };
  // An explicit optional selection (from the setup modal's checklist) wins over the caps flag: grant
  // required + exactly the chosen optional roles. Absent → the legacy all-or-nothing caps behaviour.
  const wantRoleNames = input.optionalRoles ? roleNamesForOptionalSelection(input.optionalRoles) : chosenRoleNames(caps);
  // A REQUIRED cap's suggested role failing to resolve is fatal — the app cannot do its job without
  // it. An OPTIONAL cap's suggested role failing to resolve (the tenant's Graph SP simply doesn't
  // carry that app role) must not abort the whole run — skip it with a WARN and grant everything else.
  const requiredRoleNames = new Set(GRAPH_REQUIRED_CAPS.map((c) => suggestedRole(c).toLowerCase()));
  const wantRoleIds: { name: string; id: string }[] = [];
  for (const name of wantRoleNames) {
    const id = roles.roleIdByName.get(name.toLowerCase());
    if (!id) {
      if (requiredRoleNames.has(name.toLowerCase())) {
        return { ok: false, error: `Graph app role not found in tenant: ${name}`, actions };
      }
      actions.push(`WARN optional Graph role not found in tenant, skipping: ${name}`);
      continue;
    }
    wantRoleIds.push({ name, id });
  }

  // find-or-create the app (idempotent by displayName + tag). The TAG, not the displayName, is the
  // identity: Entra does not enforce displayName uniqueness, so `/applications?$filter=displayName eq
  // ...` can return an unrelated app that merely happens to share the name "iam-engine". Adopting that
  // app (PATCHing its requiredResourceAccess, admin-consenting Graph roles onto it) would hijack
  // someone else's registration. So a match only counts when it carries APP_TAG; an untagged same-name
  // hit falls through to create — a duplicate displayName is harmless in Entra, a hijacked app is not.
  type RRABlock = { resourceAppId?: string; resourceAccess?: { id?: string; type?: string }[] };
  const find = await graphGet<{ value?: { id?: string; appId?: string; tags?: string[]; requiredResourceAccess?: RRABlock[] }[] }>(
    token, `/applications?$filter=displayName eq '${APP_DISPLAY_NAME}'&$select=id,appId,tags,requiredResourceAccess`, fetcher, opts);
  if (!find.ok) return { ok: false, error: `find app: ${find.error}`, actions };
  let app = (find.body.value ?? []).find((a) => (a.tags ?? []).includes(APP_TAG));
  let created = false;
  const requiredResourceAccess = [
    { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: wantRoleIds.map((r) => ({ id: r.id, type: "Role" })) },
    // Exchange Online app-only: declare Exchange.ManageAsApp so the app manifest reflects the grant below.
    { resourceAppId: EXO_RESOURCE_APP_ID, resourceAccess: [{ id: EXO_MANAGE_AS_APP_ROLE_ID, type: "Role" }] },
  ];
  if (!app?.id || !app.appId) {
    const c = await graphSend<{ id: string; appId: string }>(token, "POST", "/applications", {
      displayName: APP_DISPLAY_NAME, signInAudience: "AzureADMyOrg", tags: [APP_TAG], requiredResourceAccess,
    }, fetcher, opts);
    if (!c.ok || !c.body) return { ok: false, error: `create app: ${!c.ok ? c.error : "no body"}`, actions };
    app = c.body; created = true; actions.push(`created app registration ${app.appId}`);
  } else {
    // MERGE, don't replace: PATCHing requiredResourceAccess with only the Graph block would wipe any
    // other-resource block (Exchange, SharePoint...) and any Graph role a human hand-added in the
    // portal. Preserve every non-Graph block untouched, and for the Graph block UNION the existing
    // resourceAccess with the roles we want (dedupe by id).
    const existingRRA = app.requiredResourceAccess ?? [];
    // Preserve every OTHER resource block untouched; union the Graph block and the Exchange block.
    const otherBlocks = existingRRA.filter((b) => b.resourceAppId !== GRAPH_RESOURCE_APP_ID && b.resourceAppId !== EXO_RESOURCE_APP_ID);
    const existingGraphAccess = existingRRA.find((b) => b.resourceAppId === GRAPH_RESOURCE_APP_ID)?.resourceAccess ?? [];
    const mergedGraphAccessById = new Map<string, { id: string; type: string }>();
    for (const ra of existingGraphAccess) if (ra.id) mergedGraphAccessById.set(ra.id, { id: ra.id, type: ra.type ?? "Role" });
    for (const r of wantRoleIds) mergedGraphAccessById.set(r.id, { id: r.id, type: "Role" });
    const existingExoAccess = existingRRA.find((b) => b.resourceAppId === EXO_RESOURCE_APP_ID)?.resourceAccess ?? [];
    const mergedExoAccessById = new Map<string, { id: string; type: string }>();
    for (const ra of existingExoAccess) if (ra.id) mergedExoAccessById.set(ra.id, { id: ra.id, type: ra.type ?? "Role" });
    mergedExoAccessById.set(EXO_MANAGE_AS_APP_ROLE_ID, { id: EXO_MANAGE_AS_APP_ROLE_ID, type: "Role" });
    const mergedRequiredResourceAccess = [
      ...otherBlocks,
      { resourceAppId: GRAPH_RESOURCE_APP_ID, resourceAccess: [...mergedGraphAccessById.values()] },
      { resourceAppId: EXO_RESOURCE_APP_ID, resourceAccess: [...mergedExoAccessById.values()] },
    ];
    const p = await graphSend(token, "PATCH", `/applications/${app.id}`, { requiredResourceAccess: mergedRequiredResourceAccess }, fetcher, opts);
    if (!p.ok) return { ok: false, error: `update app permissions: ${p.error}`, actions };
    actions.push(`found existing app ${app.appId} — reconciled requiredResourceAccess`);
  }
  const objectId = app.id!, appId = app.appId!;

  // find-or-create the app's service principal
  const spFind = await graphGet<{ value?: { id?: string }[] }>(
    token, `/servicePrincipals?$filter=appId eq '${appId}'&$select=id`, fetcher, opts);
  if (!spFind.ok) return { ok: false, error: `find SP: ${spFind.error}`, actions };
  let spId = spFind.body.value?.[0]?.id;
  if (!spId) {
    const spc = await graphSend<{ id: string }>(token, "POST", "/servicePrincipals", { appId }, fetcher, opts);
    if (!spc.ok || !spc.body) return { ok: false, error: `create SP: ${!spc.ok ? spc.error : "no body"}`, actions };
    spId = spc.body.id; actions.push("created service principal");
  }

  // admin-consent: assign each chosen CAPABILITY's suggested role, skipping capabilities already
  // satisfied by whatever is granted — by capability, not by exact role name. A broader already-granted
  // role (e.g. Directory.ReadWrite.All) satisfies the same need as the narrower suggested role
  // (User.ReadWrite.All); granting the narrow one on top would be redundant, flagged as surplus by
  // graphSurplusRoles. Reasoning in caps also means "have Directory.ReadWrite.All" correctly skips
  // every cap it happens to cover, not just the one whose suggested role matches it by name.
  const already = await readGrantedAppRoles(token, appId, fetcher, opts);
  if (!already.ok || !already.complete) {
    // A failed OR incomplete read degrades to "treat unresolved caps as not-yet-satisfied" and attempts
    // those grants below — Graph rejects duplicates fail-soft, but without this line the resulting
    // per-role WARNs read like N distinct grant failures instead of one root cause (an unreadable read).
    actions.push("note: existing-consent read was incomplete — some grants may be re-attempted");
  }
  const grantedSoFar = already.ok ? already.roles : [];
  const wantRoleIdByName = new Map(wantRoleIds.map((r) => [r.name.toLowerCase(), r.id]));
  const chosenCaps = caps === "required+optional" ? [...GRAPH_REQUIRED_CAPS, ...GRAPH_OPTIONAL_CAPS] : [...GRAPH_REQUIRED_CAPS];
  const grantedThisRun = new Set<string>();
  const skippedCaps = new Set<string>(); // cap.need already logged as satisfied — don't log it twice
  for (const cap of chosenCaps) {
    const roleName = suggestedRole(cap);
    if (satisfied(cap, grantedSoFar)) {
      // already covered — either this exact role or a broader one (e.g. Directory.ReadWrite.All)
      if (!skippedCaps.has(cap.need)) { actions.push(`role already granted: ${roleName}`); skippedCaps.add(cap.need); }
      continue;
    }
    const roleId = wantRoleIdByName.get(roleName.toLowerCase());
    if (!roleId) continue; // unresolved: required already returned ok:false above; optional already WARNed above
    if (grantedThisRun.has(roleName.toLowerCase())) continue; // another cap this run already queued the same role
    grantedThisRun.add(roleName.toLowerCase());
    const a = await graphSend(token, "POST", `/servicePrincipals/${roles.graphSpId}/appRoleAssignedTo`, {
      principalId: spId, resourceId: roles.graphSpId, appRoleId: roleId,
    }, fetcher, opts);
    if (!a.ok) { actions.push(`WARN could not grant ${roleName}: ${a.error}`); continue; }
    actions.push(`granted (admin-consented) ${roleName}`);
  }

  // Exchange Online app-only: the certificate (issued below) is necessary but NOT sufficient — the app
  // also needs Exchange.ManageAsApp + the Exchange Administrator role. Grant them here; best-effort so a
  // tenant where they fail still finishes Graph setup, with WARNs saying what to complete by hand.
  const exo = await grantExchangeOnline(token, spId, fetcher, opts);
  for (const line of exo.actions) actions.push(line);
  const exchangeReady = exo.ok;

  // credentials — reconcile rule: only issue a new secret/cert when none valid exists. `clientSecret`
  // / `certBase64` / `certPassword` stay undefined unless THIS run issued a new one — a caller must
  // never re-write Delinea with a value that was merely "kept", since addPassword's secretText and a
  // freshly generated cert's private key are each returned exactly once and cannot be re-read later.
  // `credState` is how a caller learns whether that credential material — or whatever is already
  // vaulted — can be trusted; see the CredState doc comment above ProvisionResult.
  let clientSecret: string | undefined, certBase64: string | undefined, certPassword: string | undefined, certThumbprint: string | undefined;
  let credState: CredState = "kept-valid";
  const issue = input.issueCreds ?? true;
  const forceReissue = input.forceReissue === true;

  const issueClientSecret = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const ap = await graphSend<{ secretText?: string }>(token, "POST", `/applications/${objectId}/addPassword`,
      { passwordCredential: { displayName: "ctg-secret" } }, fetcher, opts);
    if (!ap.ok || !ap.body?.secretText) return { ok: false, error: `add secret: ${!ap.ok ? ap.error : "no secretText"}` };
    clientSecret = ap.body.secretText;
    actions.push("issued a new client secret");
    return { ok: true };
  };

  const issueCert = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const cert = await generateExoCert({ password: generatePassword() });
    // Graph's keyCredentials.key wants the raw DER, base64-encoded — strip the PEM armor + newlines
    // generateExoCert's cerPem carries.
    const der = cert.cerPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
    const patch = await graphSend(token, "PATCH", `/applications/${objectId}`, {
      keyCredentials: [{ type: "AsymmetricX509Cert", usage: "Verify", key: der, displayName: "ctg-cert" }],
    }, fetcher, opts);
    if (!patch.ok) return { ok: false, error: `upload cert: ${patch.error}` };
    certBase64 = cert.pfxBase64; // the PKCS#12 the runner authenticates with — Delinea CertificateBase64
    certPassword = cert.password; // Delinea CertificatePassword
    certThumbprint = cert.thumbprintSha1; // NOT a secret — safe to carry; the Delinea "certificate thumbprint" field
    actions.push("issued + uploaded a new certificate");
    return { ok: true };
  };

  if (!issue) {
    credState = "unverified";
    actions.push("credential issuance was not requested this run (issueCreds=false) — not verified");
  } else {
    const creds = await graphGet<{ passwordCredentials?: { endDateTime?: string }[]; keyCredentials?: { endDateTime?: string }[] }>(
      token, `/applications/${objectId}?$select=passwordCredentials,keyCredentials`, fetcher, opts);
    if (!creds.ok) {
      if (created) {
        // This app was JUST created by this same run — it PROVABLY has no credential yet (a brand-new
        // app registration starts with none), so a failed read here can't mean "there might be a good
        // one out there, don't clobber it". The "never clobber a good vaulted secret" rationale below
        // only protects an EXISTING app; it doesn't apply to one we know is empty. Issue unconditionally.
        actions.push("WARN could not read credentials on the just-created app — issuing new credentials anyway (a brand-new app provably has none to clobber)");
        const ap = await issueClientSecret();
        if (!ap.ok) return { ok: false, error: ap.error, actions };
        const cp = await issueCert();
        if (!cp.ok) return { ok: false, error: cp.error, actions };
        credState = "issued";
      } else {
        // Fail SAFE: a failed read on an EXISTING app must never be treated as "no valid credential
        // exists" — that would reissue and clobber a perfectly good vaulted secret/cert (the previous
        // value is unrecoverable once overwritten). Only issue when we AFFIRMATIVELY read that nothing
        // valid is there. We genuinely don't know here, so this is not a success — see CredState.
        actions.push("WARN could not read existing credentials — skipping credential issuance this run (kept whatever exists)");
        credState = "unverified";
      }
    } else {
      const now = Date.now();
      const hasValid = (list?: { endDateTime?: string }[]) =>
        (list ?? []).some((c) => !c.endDateTime || Date.parse(c.endDateTime) > now);
      const secretValid = hasValid(creds.body.passwordCredentials);
      const certValid = hasValid(creds.body.keyCredentials);
      let issuedAny = false;
      if (!secretValid || forceReissue) {
        if (forceReissue && secretValid) {
          actions.push("forcing a fresh client secret despite an existing valid one (recovering a stranded credential)");
        }
        const ap = await issueClientSecret();
        if (!ap.ok) return { ok: false, error: ap.error, actions };
        issuedAny = true;
      } else {
        actions.push("kept existing client secret (valid)");
      }
      if (!certValid) {
        const cp = await issueCert();
        if (!cp.ok) return { ok: false, error: cp.error, actions };
        issuedAny = true;
      } else {
        actions.push("kept existing certificate (valid)");
      }
      credState = issuedAny ? "issued" : "kept-valid";
    }
  }

  // verify granted vs required — reads back what Graph actually recorded (not what we THINK we just
  // granted), so a caller learns about a partial/failed consent immediately. `verified` requires BOTH
  // a successful read AND a COMPLETE one (every assignment resolved to a name) — an incomplete read
  // (some resource-SP lookup was throttled/unreadable) is not a trustworthy "here's everything granted"
  // any more than a failed one is, and reporting `gaps` from it would produce a false "all required
  // caps missing" on a fully-provisioned app. When not verified, gaps/optionalGaps stay empty and a
  // WARN explains why instead of asserting a spurious gap.
  const verify = await readGrantedAppRoles(token, appId, fetcher, opts);
  const verified = verify.ok && verify.complete;
  const granted = verify.ok ? verify.roles : [];
  let gaps: string[] = [];
  let optionalGaps: string[] = [];
  if (verified) {
    gaps = graphCapGaps(granted).map((c) => suggestedRole(c));
    optionalGaps = GRAPH_OPTIONAL_CAPS.filter((c) => !satisfied(c, granted)).map((c) => suggestedRole(c));
  } else {
    actions.push("WARN could not verify granted roles (read incomplete) — consent may still be propagating");
  }

  return {
    ok: true,
    result: {
      appId, objectId, spId: spId!, tenantId,
      clientSecret, certBase64, certPassword, certThumbprint, credState,
      created, granted, gaps, optionalGaps, verified, exchangeReady, actions,
    },
  };
}
