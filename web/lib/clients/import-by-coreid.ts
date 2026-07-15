// Import a client from nothing but its CORE id: resolve the ServiceNow account, create the client,
// find its KB runbooks, and build it out (runbook sections + the ClientSystem rows those imply).
// Replaces a multi-screen chore — add client, hunt for the KB number, fetch, review, save, repeat
// for the other action — with one id.
//
// All I/O is injected, so the orchestration unit-tests without ServiceNow, Azure or a database
// (the pattern sync-service.ts already uses). Wiring to the real dependencies lives in
// import-by-coreid-deps.ts.
import type { Action } from "@prisma/client";
import type { SnAccount } from "../servicenow/types";
import type { KbDiscovery } from "../servicenow/kb-discovery";
import type { KbArticle } from "../servicenow/kb";
import type { NormalizedSnClient } from "../servicenow/mappers";
import type { ParsedSection } from "./runbook-parse";
import { normalizeAccount } from "../servicenow/mappers";
import { resolveActor, type ActorInput } from "../auth/actor";
import { deriveSlugFromParts } from "./sync-service";
import { normalizeCoreId } from "./core-id";

export type Existing = { id: string; slug: string; name: string };

export type ImportDeps = {
  // May the acting operator touch this client at all? (Restricted clients sit outside even a
  // fleet-wide operator's scope unless granted.)
  isVisible: (clientId: string) => Promise<boolean>;
  findByCoreId: (coreId: string) => Promise<Existing | null>;
  findBySysId: (sysId: string) => Promise<Existing | null>;
  // A client with this domain that carries NEITHER ServiceNow key — i.e. one no account has claimed
  // (the profile-seeded case) — and only when the domain maps to exactly one such row. A row that
  // already belongs to an account is off limits: a subsidiary shares its parent's website, and
  // adopting the parent's row would re-key it.
  findUnclaimedByDomain: (domain: string) => Promise<Existing | null>;
  // Fill in the ServiceNow keys this client is MISSING (sys_id, CORE id). Never a field refresh:
  // rewriting name/primaryDomain from the ServiceNow website would clobber a curated email domain.
  // ok:false when the account's sys_id already belongs to a DIFFERENT client (which would otherwise
  // die on the unique constraint).
  claimForSn: (clientId: string, c: NormalizedSnClient) => Promise<{ ok: boolean; claimed: boolean; reason?: string }>;
  // Has ANY systems. The gate on adoption-by-domain: a domain is a guess, and a row with systems has
  // lanes and credential refs that cases dispatch against, whatever built them.
  hasSystems: (clientId: string) => Promise<boolean>;
  // Hand-configured: has systems that did NOT come from a KB import. A client whose systems the
  // import itself created (it has a KB-sourced runbook) is not "configured" — it is a half-finished
  // import, and re-running must be able to finish it. This gates the BUILD only; never adoption.
  isHandConfigured: (clientId: string) => Promise<boolean>;
  // Every row that could represent this ServiceNow account — by CORE id, by sys_id, or by domain,
  // claimed or not. Used to check the operator may see ALL of them before anything is written.
  candidateRows: (coreId: string, sysId: string, domain: string) => Promise<Existing[]>;
  // The parent account, for a child — to tell whether the KBs we found are really the parent's.
  fetchAccountBySysId: (sysId: string) => Promise<SnAccount | null>;
  // -> is the child linked to THIS parent now? (true also when the link already existed)
  linkParent: (childSysId: string, parentSysId: string) => Promise<boolean>;
  fetchAccount: (coreId: string) => Promise<SnAccount | null>;
  slugExists: (slug: string) => Promise<boolean>;
  createFromSn: (c: NormalizedSnClient, slug: string) => Promise<string>; // -> client id
  // Which lifecycle actions already have runbook sections. Those are never rebuilt.
  actionsWithRunbook: (clientId: string) => Promise<Action[]>;
  findKbs: (domainSysId: string) => Promise<KbDiscovery>;
  fetchKb: (number: string) => Promise<KbArticle | null>;
  extract: (text: string, action: Action) => Promise<ParsedSection[] | null>;
  saveRunbook: (
    slug: string,
    action: Action,
    text: string,
    sections: ParsedSection[] | undefined,
    kbNumber: string,
    actor?: ActorInput // the operator running the import — the runbook-edit audit row names them
  ) => Promise<{ count: number; createdSystems: string[] } | null>;
  writeAudit: (entry: { actor: string; userId?: string | null; action: string; clientId?: string; detail?: unknown }) => Promise<void>;
};

export type BuiltAction = { action: Action; kb: string; title: string; sections: number };

export type ImportResult = {
  coreId: string; // normalized; the raw input when it couldn't be normalized
  status: "imported" | "exists" | "not_found" | "invalid" | "error";
  slug?: string;
  name?: string;
  built: BuiltAction[];
  createdSystems: string[];
  warnings: string[];
  error?: string;
};

export { normalizeCoreId, parseCoreIds } from "./core-id";

const ACTIONS: Action[] = ["onboard", "offboard"] as Action[];

// Do two client names denote the same company? Only used to sanity-check a DOMAIN guess, never to
// identify a client (the CORE id and sys_id do that). Deliberately loose about punctuation and legal
// suffixes — "Acme Corp." and "Acme Corporation" are the same company — and deliberately strict
// about the rest: "Acme" and "Acme West" are not.
export function sameCompany(a: string, b: string): boolean {
  const norm = (s: string) =>
    (s ?? "")
      .toLowerCase()
      .replace(/[.,'’"()]/g, "")
      .replace(/\b(inc|llc|l\.?l\.?c|ltd|limited|corp|corporation|co|company|lp|llp|plc|gmbh|group|holdings)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  return x !== "" && y !== "" && x === y;
}

export async function importClientByCoreId(deps: ImportDeps, rawCoreId: string, actor: ActorInput): Promise<ImportResult> {
  const who = resolveActor(actor);
  const coreId = normalizeCoreId(rawCoreId);
  if (!coreId) {
    return { coreId: rawCoreId.trim(), status: "invalid", built: [], createdSystems: [], warnings: [], error: "not a CORE id" };
  }

  const base: ImportResult = { coreId, status: "imported", built: [], createdSystems: [], warnings: [] };
  // Set the moment the client is known, so a failure AFTER creation still reports which client it
  // left behind instead of an anonymous "Failed" row.
  let result = base;

  try {
    const raw = await deps.fetchAccount(coreId);
    if (!raw) return { ...base, status: "not_found", error: "no ServiceNow account with that CORE id" };

    const account = normalizeAccount(raw);
    if (!account.serviceNowSysId) {
      // Every downstream key hangs off the sys_id (the create upserts on it, the parent link needs
      // it). An account without one would upsert onto the EMPTY-string sys_id — colliding with any
      // other such client.
      return { ...base, status: "error", error: "ServiceNow account has no sys_id" };
    }

    // Every row that could stand for this ServiceNow account, whichever key it hangs off. Checking
    // ALL of them for visibility — not just the one we end up matching — is what stops an operator
    // steering the match: a decoy row carrying a restricted client's CORE id would otherwise be the
    // one we match (visible, harmless-looking) while the restricted row it shadows is never
    // consulted, and the decoy would claim that company's ServiceNow account.
    const candidates = await deps.candidateRows(coreId, account.serviceNowSysId, account.primaryDomain);
    for (const c of candidates) {
      if (!(await deps.isVisible(c.id))) {
        return { ...base, status: "error", error: "that client is restricted — you do not have access to it" };
      }
    }

    // Is this client already ours? These two keys IDENTIFY the account — a row carrying either is
    // beyond doubt this client.
    let existing = (await deps.findByCoreId(coreId)) ?? (await deps.findBySysId(account.serviceNowSysId));
    let matchedByDomain = false;

    // A domain is a GUESS, not an identity. It is here to catch the profile-seeded row that carries
    // neither key — but a subsidiary shares its parent's WEBSITE, so "the one client with this
    // domain" is very often the PARENT. A child account (one with a parent in ServiceNow) is
    // therefore never matched this way: it gets its own row.
    if (!existing && account.primaryDomain && !account.parentSysId) {
      const guess = await deps.findUnclaimedByDomain(account.primaryDomain);
      // The domain must AGREE WITH THE NAME. A website is shared up and down a corporate family:
      // "!account.parentSysId" only proves ServiceNow doesn't call this account a child — it does not
      // stop a PARENT account from adopting an unclaimed SUBSIDIARY's row (Acme Inc claiming the row
      // someone hand-added for Acme West). Two rows for two companies is a nuisance; one row wearing
      // the wrong company's identity is a live case running against the wrong tenant.
      if (guess && !sameCompany(guess.name, account.name)) {
        result.warnings.push(
          `a client with this domain already exists (${guess.slug}) but its name doesn't match — imported as a separate client; merge them by hand if they are the same company`
        );
      } else if (guess) {
        existing = guess;
        matchedByDomain = true;
      }
    }

    if (existing) {
      // Belt and braces: the candidate sweep above should already have caught this, but the row we
      // are about to WRITE to is checked directly too — the guard must not rest on one query being
      // built correctly.
      if (!(await deps.isVisible(existing.id))) {
        return { ...base, status: "error", error: "that client is restricted — you do not have access to it" };
      }

      result = { ...base, status: "exists", slug: existing.slug, name: existing.name };

      // A guess must never re-key a client that has ANY systems. They carry the lanes and Delinea
      // secret refs that cases dispatch against, so binding that row to the wrong ServiceNow account
      // would run one client's onboarding against another's tenant — and ServiceNow's own hierarchy
      // data is patchy, so "it has no parent" is not proof it isn't a subsidiary sharing a website.
      // Deliberately NOT isHandConfigured: that asks "did a human build this?", which is the wrong
      // question here — a row's systems are dangerous to mis-key no matter what created them.
      if (matchedByDomain && (await deps.hasSystems(existing.id))) {
        result.warnings.push(
          `a client with this domain already exists (${existing.slug}) and has systems configured, but is not linked to ServiceNow — link it by hand if it is the same company`
        );
        return result;
      }

      // Claim it for this account: fill in the ServiceNow keys it is MISSING. Deliberately not a
      // field refresh — refreshSnFields would rewrite name and primaryDomain from the ServiceNow
      // website, and a seeded client's primaryDomain is its EMAIL domain (what UPNs are minted
      // from). Silently swapping that provisions the next new user at the wrong domain.
      const claim = await deps.claimForSn(existing.id, account);
      if (!claim.ok) return { ...result, status: "error", error: claim.reason };
      if (claim.claimed) {
        await deps.writeAudit({
          actor: who.actor,
          userId: who.userId,
          action: "client.reconcile",
          clientId: existing.id,
          detail: { serviceNowSysId: account.serviceNowSysId, coreId, source: "import", matchedByDomain },
        });
      }

      await linkParent(deps, account, result);

      // What may be built here. saveRunbook REPLACES an action's sections, so an action that already
      // has a runbook is never rebuilt. And a HAND-configured client (systems that no KB import
      // created) is left alone: building its runbook would run createMissingSystems and bolt
      // catalog-default lanes onto it — systems the client may not own, that the next case would then
      // dispatch jobs against. A client the import itself built is not "configured": re-running must
      // be able to finish an action a previous run failed on.
      const already = await deps.actionsWithRunbook(existing.id);
      for (const a of already) result.warnings.push(`${a} runbook already exists — left as it is`);

      if (await deps.isHandConfigured(existing.id)) {
        if (already.length < 2) {
          result.warnings.push(
            "this client already has systems configured — its runbook was not auto-built; fetch the KB from the client page to review it first"
          );
        }
        return result;
      }

      await buildFromKbs(deps, raw, existing.slug, result, already, actor);
      return result;
    }

    let slug = deriveSlugFromParts(account.coreId ?? coreId, account.name);
    if (await deps.slugExists(slug)) slug = `${slug}-${account.serviceNowSysId.slice(0, 6)}`;

    const clientId = await deps.createFromSn(account, slug);
    // From here on the client EXISTS — carry it on the result so any later failure is reported
    // against a named client, not as a phantom.
    result = { ...base, slug, name: account.name };
    await deps.writeAudit({
      actor: who.actor,
      userId: who.userId,
      action: "client.create",
      clientId,
      detail: { serviceNowSysId: account.serviceNowSysId, coreId, source: "import" },
    });
    await linkParent(deps, account, result);

    // Everything below is best-effort enrichment: a KB that can't be fetched or parsed leaves a
    // warning on the row, not a half-created client. Re-running the import finishes the job — an
    // existing client's EMPTY actions still get built.
    await buildFromKbs(deps, raw, slug, result, [], actor);
    return result;
  } catch (err) {
    return { ...result, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

// Children inherit the parent's modeled systems at plan time — but only through Client.parentId.
// createFromSn does not set it (the roster sync links parents in a second pass, because a child can
// arrive before its parent), so an import that skipped this would leave a child whose cases plan
// nothing, while the UI cheerfully says it inherits.
async function linkParent(deps: ImportDeps, account: NormalizedSnClient, result: ImportResult): Promise<void> {
  if (!account.parentSysId) return;
  try {
    const linked = await deps.linkParent(account.serviceNowSysId, account.parentSysId);
    if (!linked) {
      // Be precise about the remedy: importing the parent does NOT reach back and link this child
      // (the link is written from the child's side). Re-running THIS import once the parent exists
      // does — as does the next ServiceNow roster sync, which links parents in its own pass.
      result.warnings.push(
        "the parent account isn't in the system yet, so this client doesn't inherit its systems — import the parent, then run this import again"
      );
    }
  } catch (err) {
    result.warnings.push(`could not link the parent account: ${msg(err)}`);
  }
}

// `skip`: actions that already have a runbook. They are never rebuilt — saveRunbook replaces an
// action's sections wholesale, which would discard an operator's edits.
async function buildFromKbs(
  deps: ImportDeps,
  raw: SnAccount,
  slug: string,
  result: ImportResult,
  skip: Action[],
  actor?: ActorInput
): Promise<void> {
  const domain = raw.sys_domain?.value ?? "";
  const parentName = raw.account_parent?.display_value ?? null;
  const todo = ACTIONS.filter((a) => !skip.includes(a));
  if (!todo.length) return;

  if (!domain) {
    // No domain means no way to find the client's KBs — say THAT, rather than the misleading
    // "no KB found in ServiceNow" (which reads as "this client has no runbook").
    result.warnings.push("the ServiceNow account has no domain, so its KB articles can't be found — build the runbook on the client page");
    return;
  }

  // A child account often sits in the PARENT's ServiceNow domain — in which case every KB we would
  // "find" for it is really the parent's. Saving those onto the child looks like a win and quietly
  // breaks inheritance: planning only falls back to the parent when the child has NO systems of its
  // own, and building would give it some. Leave the child bare; its cases already inherit.
  const parentSysId = raw.account_parent?.value ?? "";
  if (parentSysId) {
    // FAIL CLOSED. If we can't establish that the child has a domain of its OWN, we must not build:
    // the KBs in a shared domain are the parent's, and saving them here gives the child systems,
    // which permanently severs the parent-inheritance that planning relies on (it falls back to the
    // parent only while the child has none). Not building is recoverable — an operator can fetch the
    // KB from the client page. Building the wrong runbook is not.
    let parentDomain: string | null = null;
    try {
      const parent = await deps.fetchAccountBySysId(parentSysId);
      parentDomain = parent?.sys_domain?.value ?? null;
    } catch {
      parentDomain = null;
    }

    if (parentDomain === null) {
      result.warnings.push(
        `could not check whether this account shares ${parentName ?? "its parent"}'s ServiceNow domain, so its runbook was not auto-built — build it on the client page (its cases inherit the parent's systems meanwhile)`
      );
      return;
    }
    if (parentDomain === domain) {
      result.warnings.push(
        `this account shares ${parentName ?? "its parent"}'s ServiceNow domain, so the KBs there are the parent's — not imported; cases inherit the parent's systems`
      );
      return;
    }
  }

  let found: KbDiscovery;
  try {
    found = await deps.findKbs(domain);
  } catch (err) {
    result.warnings.push(`could not search ServiceNow for KB articles: ${msg(err)}`);
    return;
  }

  if (!todo.some((a) => (a === "onboard" ? found.onboard : found.offboard))) {
    result.warnings.push(
      `no ${todo.join(" or ")} KB found in ServiceNow — build the runbook on the client page` +
        // A child account's runbook usually lives with the parent; its cases inherit the parent's
        // modeled systems at plan time, so an empty runbook here is expected, not broken.
        (parentName ? ` (child of ${parentName} — cases inherit the parent's systems)` : "")
    );
    return;
  }

  for (const action of todo) {
    const pick = action === "onboard" ? found.onboard : found.offboard;
    if (!pick) {
      result.warnings.push(`no ${action}ing KB found in ServiceNow`);
      continue;
    }

    // A pick that doesn't read like a runbook guide (Century Equity has only an "Offboard User
    // Request" form) is NOT saved. Saving it would create ClientSystem rows from whatever the
    // extractor made of that prose — config a live case would then dispatch against. Name it and
    // let a human decide; the client page's Fetch button takes it from here.
    if (!pick.confident) {
      result.warnings.push(
        `${pick.number} "${pick.title}" doesn't look like a runbook guide — not imported; review it on the client page`
      );
      continue;
    }

    try {
      const article = await deps.fetchKb(pick.number);
      if (!article || !article.text.trim()) {
        result.warnings.push(`${pick.number} (${action}) is empty or unreadable — build that runbook on the client page`);
        continue;
      }

      // AI extraction structures the messy KB HTML the heuristic parser can't; when it isn't
      // configured or the call fails it returns null and saveRunbook falls back to the heuristic
      // parse of the same text.
      const sections = (await deps.extract(article.text, action)) ?? undefined;
      const saved = await deps.saveRunbook(slug, action, article.text, sections, pick.number, actor);
      if (!saved) {
        result.warnings.push(`could not save the ${action} runbook`);
        continue;
      }

      result.built.push({ action, kb: pick.number, title: article.title || pick.title, sections: saved.count });
      for (const s of saved.createdSystems) if (!result.createdSystems.includes(s)) result.createdSystems.push(s);
    } catch (err) {
      result.warnings.push(`${pick.number} (${action}) failed: ${msg(err)}`);
    }
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
