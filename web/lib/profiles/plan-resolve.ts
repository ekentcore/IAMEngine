// Plan-time resolution: for a v2.1 client (has personas/globals), flatten each job's config by
// merging globals + selected persona + the system's own lane config through the resolver. v2.0
// clients (no personas/globals) pass through unchanged. Onboard resolves the ONBOARD fragments
// (add groups / place OU / set attrs); offboard resolves the OFFBOARD fragments with offboard
// semantics (remove groups / move OU / set attrs).
import { buildPlanContext } from "./context";
import { resolveSystemConfig } from "./resolve";
import { evaluateLicenseRules } from "../m365/license-rules";
import type { PlannedJob } from "../orchestrator";

type PlanClient = { personas?: unknown; globals?: unknown; globalsOffboard?: unknown; locations?: unknown };

// Directory systems whose groups can be mirrored from a reference user (the runner resolves the
// reference user's live memberOf at execution time and unions it in). AD/entra mirror on-prem +
// synced groups; m365 mirrors the reference user's CLOUD-only Entra groups (cloud licensing groups,
// distribution/M365 groups) that AD sync never covers.
const DIRECTORY_SYSTEMS = new Set(["active-directory", "entra", "m365", "exchange"]);

// OFFBOARD resolution: resolve globalsOffboard + persona.offboardSystems and map the onboard-shaped
// keys to offboard semantics on the job config (groups -> removeGroups, ou -> moveToOu, attributes ->
// offboardAttributes). Additive — onboard config keys the runner already honors are untouched.
function resolveOffboardConfigs(client: PlanClient, payload: Record<string, unknown>, planned: PlannedJob[]): PlannedJob[] {
  const globalsOff = (client.globalsOffboard ?? null) as Record<string, Record<string, unknown>> | null;
  const personas = (client.personas ?? null) as Record<string, unknown> | null;
  if (!globalsOff && !personas) return planned;
  const { context, persona } = buildPlanContext(payload, { personas: personas as never, locations: client.locations as never });
  const personaOff = (persona?.def as { offboardSystems?: Record<string, unknown> } | undefined)?.offboardSystems ?? null;
  return planned.map((j) => {
    const gOff = globalsOff?.[j.systemKey] ?? null;
    const pOff = (personaOff?.[j.systemKey] as Record<string, unknown> | undefined) ?? null;
    if (!gOff && !pOff) return j;
    const off = resolveSystemConfig(j.systemKey, { globals: gOff as never, persona: pOff as never, own: null }, context);
    const cfg: Record<string, unknown> = { ...((j.config as Record<string, unknown> | null) ?? {}) };
    if (Array.isArray(off.groups) && off.groups.length) cfg.removeGroups = off.groups;
    if (typeof off.ou === "string" && off.ou) cfg.moveToOu = off.ou;
    if (off.attributes && typeof off.attributes === "object" && Object.keys(off.attributes as object).length) cfg.offboardAttributes = off.attributes;
    return { ...j, config: cfg };
  });
}

export function resolvePlannedConfigs(
  client: PlanClient,
  payload: Record<string, unknown>,
  action: string,
  planned: PlannedJob[]
): PlannedJob[] {
  if (action === "offboard") return resolveOffboardConfigs(client, payload, planned);
  if (action !== "onboard") return planned;

  const personas = (client.personas ?? null) as Record<string, unknown> | null;
  const globals = (client.globals ?? null) as Record<string, Record<string, unknown>> | null;
  // "mirror <user>": copy a reference user's group memberships (live AD state → resolved by the
  // runner). Applies to v2.0 and v2.1 clients alike, so it's injected independently of personas.
  const mirror = typeof payload.mirrorPermissionsFromUser === "string" && payload.mirrorPermissionsFromUser.trim()
    ? payload.mirrorPermissionsFromUser.trim() : null;

  // One context for everything below (persona select + condition eval). Safe for v2.0 clients too —
  // selectPersona just returns null with no personas.
  const { context, persona, location } = buildPlanContext(payload, { personas: personas as never, locations: client.locations as never });

  // v2.1 resolution (persona/globals → flattened config) only when the client has those blocks.
  const resolved = (!personas && !globals)
    ? planned
    : planned.map((j) => ({
        ...j,
        config: resolveSystemConfig(
          j.systemKey,
          {
            globals: globals?.[j.systemKey] ?? null,
            persona: (persona?.def?.systems?.[j.systemKey] as Record<string, unknown> | undefined) ?? null,
            own: (j.config as Record<string, unknown> | null) ?? null,
          },
          context
        ),
      }));

  // Location-driven targets: a matched location can carry groups (+ an OU / address attributes) that
  // apply to the directory systems — e.g. a Boston hire gets FalconBOS + the floor-printer groups.
  // Groups are UNIONED into each directory job (the runner adds the ones each system actually has); an
  // OU is a default for AD only (a persona OU already set wins); attributes merge with the location
  // winning (they're office-specific, e.g. physicalDeliveryOfficeName / streetAddress).
  const locGroups = Array.isArray(location?.groups) ? (location!.groups as string[]).filter((g) => typeof g === "string" && g.trim()) : [];
  const locOu = typeof location?.ou === "string" ? location.ou : null;
  const locAttrs = location?.attributes && typeof location.attributes === "object" ? location.attributes as Record<string, unknown> : null;
  const withLoc = (locGroups.length === 0 && !locOu && !locAttrs)
    ? resolved
    : resolved.map((j) => {
        if (!DIRECTORY_SYSTEMS.has(j.systemKey)) return j;
        const cfg = { ...((j.config as Record<string, unknown> | null) ?? {}) };
        if (locGroups.length) {
          const base = Array.isArray(cfg.groups) ? [...(cfg.groups as unknown[])] : [];
          const seen = new Set(base.map((g) => String(g).toLowerCase()));
          for (const g of locGroups) { const k = g.toLowerCase(); if (!seen.has(k)) { seen.add(k); base.push(g); } }
          cfg.groups = base;
        }
        if (j.systemKey === "active-directory" && locOu && !cfg.ou) cfg.ou = locOu;
        if (locAttrs && Object.keys(locAttrs).length) cfg.attributes = { ...((cfg.attributes as Record<string, unknown> | undefined) ?? {}), ...locAttrs };
        return { ...j, config: cfg };
      });

  const withMirror = !mirror
    ? withLoc
    : withLoc.map((j) =>
        DIRECTORY_SYSTEMS.has(j.systemKey)
          ? { ...j, config: { ...((j.config as Record<string, unknown> | null) ?? {}), mirrorFromUser: mirror } }
          : j
      );

  // Per-client M365 licensing rules: ADD the intake-selected license(s) (e.g. needsComputer → E5 else
  // E1) to the client's base config.licenses — UNION, so a static add-on like "Defender for Office 365"
  // is kept alongside the rule-chosen tier. v2.0 + v2.1 alike. SKIP when the ticket explicitly listed
  // product licenses — a deliberate request overrides (the runner prefers payload.productLicenses).
  const explicitLicenses = Array.isArray(payload.productLicenses)
    && payload.productLicenses.some((x) => typeof x === "string" && x.trim() !== "");
  const licenseName = (l: unknown): string => (typeof l === "string" ? l : String((l as { name?: unknown; skuId?: unknown })?.name ?? (l as { skuId?: unknown })?.skuId ?? ""));
  const withLicenses = explicitLicenses
    ? withMirror
    : withMirror.map((j) => {
        if (j.systemKey !== "m365") return j;
        const cfg = (j.config as Record<string, unknown> | null) ?? {};
        const ruleLicenses = evaluateLicenseRules((cfg as { licenseRules?: unknown }).licenseRules, context);
        if (!ruleLicenses) return j;
        // base (static) licenses first, then append the rule-selected ones not already present (case-insensitive)
        const base = Array.isArray(cfg.licenses) ? [...cfg.licenses] : [];
        const seen = new Set(base.map((l) => licenseName(l).toLowerCase()).filter(Boolean));
        for (const r of ruleLicenses) { const k = r.toLowerCase(); if (!seen.has(k)) { seen.add(k); base.push(r); } }
        return { ...j, config: { ...cfg, licenses: base } };
      });

  // A group-based license entry with groupSource 'ad' is carried by an ON-PREM group the m365
  // (Graph) lane can't write. Append those groups to the active-directory job's groups here, at
  // PLAN time — the AD lane adds groups idempotently and runs before m365. (Deliberately not a
  // runtime handoff: seat-aware's LicenseFallbackAdGroup result field is consumed by nothing —
  // plan-time keeps the add visible in the plan preview and impossible to drop.)
  const adLicenseGroups: string[] = [];
  for (const j of withLicenses) {
    if (j.systemKey !== "m365" && j.systemKey !== "entra") continue;
    const cfg = j.config as { licenses?: unknown; defaultLicenses?: unknown } | null;
    for (const lics of [cfg?.licenses, cfg?.defaultLicenses]) {
      if (!Array.isArray(lics)) continue;
      for (const l of lics) {
        const o = l as { assignVia?: unknown; groupSource?: unknown; group?: unknown } | null;
        if (o && typeof o === "object" && o.assignVia === "group" && o.groupSource === "ad" && typeof o.group === "string" && o.group.trim()) {
          adLicenseGroups.push(o.group.trim());
        }
      }
    }
  }
  const withAdLicenseGroups = adLicenseGroups.length === 0 ? withLicenses : withLicenses.map((j) => {
    if (j.systemKey !== "active-directory") return j;
    const cfg = { ...((j.config as Record<string, unknown> | null) ?? {}) };
    const base = Array.isArray(cfg.groups) ? [...(cfg.groups as unknown[])] : [];
    const seen = new Set(base.map((g) => String(g).toLowerCase()));
    for (const g of adLicenseGroups) { const k = g.toLowerCase(); if (!seen.has(k)) { seen.add(k); base.push(g); } }
    return { ...j, config: { ...cfg, groups: base } };
  });

  // m365 and entra are the SAME Graph module ($DISPATCH['entra'] = $DISPATCH['m365']). When a client
  // models BOTH, the entra job would re-run the entire M365 onboard the m365 job already did — incl.
  // the expensive shared-mailbox/DL EXO mirror (hundreds of mailboxes). De-dupe: the entra lane skips
  // the EXO finish + group mirror (the m365 lane owns them). A client with ONLY entra is untouched.
  const hasM365 = withAdLicenseGroups.some((j) => j.systemKey === "m365");
  const deduped = !hasM365 ? withAdLicenseGroups : withAdLicenseGroups.map((j) => {
    if (j.systemKey !== "entra") return j;
    const cfg = { ...((j.config as Record<string, unknown> | null) ?? {}) };
    delete cfg.mirrorFromUser; // the m365 lane does the Graph group-mirror + EXO mirror
    return { ...j, config: { ...cfg, skipExoFinish: true } };
  });

  // Distribution lists requested on m365 can only be written by the Exchange Online lane (Graph
  // can't add DL members). Flow the m365/entra requested groups onto the exchange job's config so the
  // EXO step adds the distribution ones by name (it only sees its own config). It picks the DLs and
  // skips security/365 groups (those stay Graph's job).
  const m365Groups = deduped.find((j) => j.systemKey === "m365" || j.systemKey === "entra")?.config as { groups?: unknown } | null;
  const reqGroups = m365Groups && Array.isArray(m365Groups.groups) ? m365Groups.groups : null;
  if (!reqGroups || reqGroups.length === 0) return deduped;
  return deduped.map((j) =>
    j.systemKey === "exchange"
      ? { ...j, config: { ...((j.config as Record<string, unknown> | null) ?? {}), namedGroups: reqGroups } }
      : j
  );
}
