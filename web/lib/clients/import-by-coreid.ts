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

export type ImportDeps = {
  findByCoreId: (coreId: string) => Promise<{ slug: string; name: string } | null>;
  findBySysId: (sysId: string) => Promise<{ slug: string; name: string } | null>;
  fetchAccount: (coreId: string) => Promise<SnAccount | null>;
  slugExists: (slug: string) => Promise<boolean>;
  createFromSn: (c: NormalizedSnClient, slug: string) => Promise<string>; // -> client id
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

export type BuiltAction = {
  action: Action;
  kb: string;
  title: string;
  sections: number;
  confident: boolean; // the KB title read as a real runbook ("... Guide"), not a best-of-a-bad-lot pick
};

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
  for (const token of (text ?? "").split(/[,;\s]+/)) {
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

  try {
    // Already ours? Report it — never rebuild. saveRunbook REPLACES an action's sections, so a
    // re-import of an existing client would silently discard whatever an operator has edited.
    const known = await deps.findByCoreId(coreId);
    if (known) return { ...base, status: "exists", slug: known.slug, name: known.name };

    const raw = await deps.fetchAccount(coreId);
    if (!raw) return { ...base, status: "not_found", error: "no ServiceNow account with that CORE id" };

    const account = normalizeAccount(raw);

    // The same account may already be here under a different key — the roster sync creates clients
    // keyed on sys_id and older rows can carry no CORE id at all. That is "exists", not a second
    // client (which the unique sys_id constraint would reject anyway).
    const linked = await deps.findBySysId(account.serviceNowSysId);
    if (linked) return { ...base, status: "exists", slug: linked.slug, name: linked.name };

    let slug = deriveSlugFromParts(account.coreId ?? coreId, account.name);
    if (await deps.slugExists(slug)) slug = `${slug}-${account.serviceNowSysId.slice(0, 6)}`;

    const clientId = await deps.createFromSn(account, slug);
    await deps.writeAudit({
      actor,
      action: "client.create",
      clientId,
      detail: { serviceNowSysId: account.serviceNowSysId, coreId, source: "import" },
    });

    const result: ImportResult = { ...base, slug, name: account.name };

    // From here on the client EXISTS. Everything below is best-effort enrichment: a KB that can't be
    // fetched or parsed leaves a warning on the row, not a half-created client. The operator can
    // finish the build from the client page, and re-running the import reports "exists".
    await buildFromKbs(deps, raw, slug, result);
    return result;
  } catch (err) {
    return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

async function buildFromKbs(deps: ImportDeps, raw: SnAccount, slug: string, result: ImportResult): Promise<void> {
  const domain = raw.sys_domain?.value ?? "";
  const parentName = raw.account_parent?.display_value ?? null;

  let found: KbDiscovery;
  try {
    found = await deps.findKbs(domain);
  } catch (err) {
    result.warnings.push(`could not search ServiceNow for KB articles: ${msg(err)}`);
    return;
  }

  if (!found.onboard && !found.offboard) {
    result.warnings.push(
      `no onboarding or offboarding KB found in ServiceNow — build the runbook on the client page` +
        // A child account's runbook usually lives with the parent; its cases already inherit the
        // parent's modeled systems at plan time, so an empty runbook here is expected, not broken.
        (parentName ? ` (child of ${parentName} — cases inherit the parent's systems)` : "")
    );
    return;
  }

  for (const action of ACTIONS) {
    const pick = action === "onboard" ? found.onboard : found.offboard;
    if (!pick) {
      result.warnings.push(`no ${action}ing KB found in ServiceNow`);
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

      result.built.push({
        action,
        kb: pick.number,
        title: article.title || pick.title,
        sections: saved.count,
        confident: pick.confident,
      });
      for (const s of saved.createdSystems) if (!result.createdSystems.includes(s)) result.createdSystems.push(s);

      if (!pick.confident) {
        result.warnings.push(
          `${pick.number} "${pick.title}" doesn't look like a runbook guide — review the ${action} runbook`
        );
      }
    } catch (err) {
      result.warnings.push(`${pick.number} (${action}) failed: ${msg(err)}`);
    }
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
