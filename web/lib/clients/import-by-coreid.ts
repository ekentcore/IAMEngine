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
import { deriveSlugFromParts } from "./sync-service";

export type Existing = { id: string; slug: string; name: string };

export type ImportDeps = {
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
  // Has any ClientSystem rows — i.e. hand-configured, not a bare roster row.
  hasSystems: (clientId: string) => Promise<boolean>;
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
    kbNumber: string
  ) => Promise<{ count: number; createdSystems: string[] } | null>;
  writeAudit: (entry: { actor: string; action: string; clientId?: string; detail?: unknown }) => Promise<void>;
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

// "CORE1269", "core1269", "core 1269", "CORE-1269" and a bare "1269" are all the same id — that is
// how the team writes it in tickets and chat. Anything else is junk and must not reach ServiceNow.
export function normalizeCoreId(raw: string): string | null {
  const v = (raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = /^(?:CORE[-_]?)?(\d+)$/.exec(v);
  return m ? `CORE${m[1]}` : null; // digits kept verbatim — the id is a string, "01269" != "1269"
}

// The textarea parser: ids separated by commas (or any whitespace/semicolons — paste is messy).
// De-duplicates on the NORMALIZED id, so "CORE1269, core1269" is one import, not two.
export function parseCoreIds(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  // Close up "CORE 1269" FIRST: splitting on whitespace would otherwise tear it into a junk "CORE"
  // token and a bare "1269", reporting an error for an id the operator wrote perfectly reasonably.
  const glued = (text ?? "").replace(/\bcore[\s_-]+(?=\d)/gi, "CORE");
  for (const token of glued.split(/[,;\s]+/)) {
    const t = token.trim();
    if (!t) continue;
    const id = normalizeCoreId(t);
    if (!id) {
      if (!invalid.includes(t)) invalid.push(t);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids, invalid };
}

const ACTIONS: Action[] = ["onboard", "offboard"] as Action[];

export async function importClientByCoreId(deps: ImportDeps, rawCoreId: string, actor: string): Promise<ImportResult> {
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

    // Is this client already ours? By CORE id, then by the sys_id the account resolves to (a
    // roster-synced row may carry no CORE id).
    let existing = (await deps.findByCoreId(coreId)) ?? (await deps.findBySysId(account.serviceNowSysId));

    // Only then by domain, and ONLY over a row that carries neither ServiceNow key — an UNCLAIMED
    // row (the profile-seeded case). A row that already belongs to some account must never be
    // adopted by a different one: subsidiaries share their parent's website, so a plain
    // "one client with this domain" match hands the child the PARENT's row — and re-keying it would
    // relabel the parent, orphan its sys_id, and leave its systems and case history under the
    // child's name.
    if (!existing && account.primaryDomain) {
      existing = await deps.findUnclaimedByDomain(account.primaryDomain);
    }

    if (existing) {
      result = { ...base, status: "exists", slug: existing.slug, name: existing.name };

      // Claim it for this account: fill in the ServiceNow keys it is MISSING. Deliberately not a
      // field refresh — refreshSnFields would rewrite name and primaryDomain from the ServiceNow
      // website, and a seeded client's primaryDomain is its EMAIL domain (what UPNs are minted
      // from). Silently swapping that provisions the next new user at the wrong domain.
      const claim = await deps.claimForSn(existing.id, account);
      if (!claim.ok) return { ...result, status: "error", error: claim.reason };
      if (claim.claimed) {
        await deps.writeAudit({
          actor,
          action: "client.reconcile",
          clientId: existing.id,
          detail: { serviceNowSysId: account.serviceNowSysId, coreId, source: "import" },
        });
      }

      await linkParent(deps, account, result);

      // What may be built here. saveRunbook REPLACES an action's sections, so an action that already
      // has a runbook is never rebuilt. And a client that already has SYSTEMS is hand-configured (a
      // profile-seeded client, or one an operator wired up): building its runbook would run
      // createMissingSystems and bolt catalog-default lanes onto it — systems the client may not own,
      // that the next case would then dispatch jobs against. Only a BARE row (no systems) is built
      // out — which is exactly the roster-synced row this feature exists to fix.
      const already = await deps.actionsWithRunbook(existing.id);
      for (const a of already) result.warnings.push(`${a} runbook already exists — left as it is`);

      if (await deps.hasSystems(existing.id)) {
        if (already.length < 2) {
          result.warnings.push(
            "this client already has systems configured — its runbook was not auto-built; fetch the KB from the client page to review it first"
          );
        }
        return result;
      }

      await buildFromKbs(deps, raw, existing.slug, result, already);
      return result;
    }

    let slug = deriveSlugFromParts(account.coreId ?? coreId, account.name);
    if (await deps.slugExists(slug)) slug = `${slug}-${account.serviceNowSysId.slice(0, 6)}`;

    const clientId = await deps.createFromSn(account, slug);
    // From here on the client EXISTS — carry it on the result so any later failure is reported
    // against a named client, not as a phantom.
    result = { ...base, slug, name: account.name };
    await deps.writeAudit({
      actor,
      action: "client.create",
      clientId,
      detail: { serviceNowSysId: account.serviceNowSysId, coreId, source: "import" },
    });
    await linkParent(deps, account, result);

    // Everything below is best-effort enrichment: a KB that can't be fetched or parsed leaves a
    // warning on the row, not a half-created client. Re-running the import finishes the job — an
    // existing client's EMPTY actions still get built.
    await buildFromKbs(deps, raw, slug, result, []);
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
      result.warnings.push("parent account is not in the system yet — import it too, so cases can inherit its systems");
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
  skip: Action[]
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
      const saved = await deps.saveRunbook(slug, action, article.text, sections, pick.number);
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
