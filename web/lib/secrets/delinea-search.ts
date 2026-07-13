// Read-only ENUMERATION against Secret Server, for the credential-recovery tooling: page through
// every folder, and page through every secret under a folder tree. Names/ids/templates only —
// never values (that's resolveSecretFields in delinea.ts, used one secret at a time).
//
// Two Secret Server quirks this module encodes so callers don't have to:
//  - GET /api/v1/folders IGNORES filter.parentFolderId on our tenant version — it returns every
//    folder the account can see. So we page the full list and let the caller filter client-side
//    by parentFolderId/folderPath (the records carry both).
//  - GET /api/v1/secrets by default hides secrets the account can read-by-id but not list.
//    filter.scope=All + filter.includeRestricted=true reveals the full inventory (names only;
//    reading a value still requires actual access) — verified against the live tenant.
import type { DelineaConfig, Fetcher, FetchResponse } from "./delinea";

export type FolderRecord = {
  id: number;
  folderName: string;
  folderPath: string;
  parentFolderId: number | null;
};

export type SecretSearchRecord = {
  id: number;
  name: string;
  folderPath: string;
  secretTemplateId?: number;
  secretTemplateName?: string;
};

const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as Promise<FetchResponse>;

const PAGE = 1000;
const MAX_PAGES = 200; // hard stop — 200k records is far beyond any real tenant

// Page through a Secret Server search endpoint (`{ records, total }` envelope). `urlFor` gets the
// skip offset; stops on a short page, on reaching `total`, or at the MAX_PAGES backstop.
async function pageAll<T>(urlFor: (skip: number) => string, token: string, fetcher: Fetcher, map: (rec: Record<string, unknown>) => T): Promise<T[]> {
  const out: T[] = [];
  let skip = 0;
  let total: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetcher(urlFor(skip), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Delinea search failed (${res.status}) at skip=${skip}`);
    const body = (await res.json()) as { records?: Record<string, unknown>[]; total?: number };
    const records = body.records ?? [];
    for (const r of records) out.push(map(r));
    if (typeof body.total === "number") total = body.total;
    // Advance by what the server ACTUALLY returned, not by what we asked for: Secret Server may cap
    // a page below `take`, and stepping by PAGE would skip the remainder of that page. An empty page
    // is the only safe stop signal besides reaching `total`.
    skip += records.length;
    if (records.length === 0) break;
    if (total !== undefined && out.length >= total) break;
  }
  // A silent short read here becomes a "no matching secret" verdict for a client that HAS one, so
  // fail loudly rather than under-report.
  if (total !== undefined && out.length < total) {
    throw new Error(`Delinea search truncated: collected ${out.length} of ${total} records (raise MAX_PAGES)`);
  }
  return out;
}

// Every folder the account can see (see header: the server-side parent filter is unreliable, so
// callers filter on the returned parentFolderId/folderPath).
export async function listAllFolders(cfg: DelineaConfig, token: string, fetcher: Fetcher = defaultFetcher): Promise<FolderRecord[]> {
  return pageAll(
    (skip) => `${cfg.baseUrl}/api/v1/folders?take=${PAGE}&skip=${skip}`,
    token,
    fetcher,
    (r) => ({
      id: Number(r.id),
      folderName: String(r.folderName ?? ""),
      folderPath: String(r.folderPath ?? ""),
      parentFolderId: r.parentFolderId == null ? null : Number(r.parentFolderId),
    })
  );
}

// Every secret under a folder tree (subfolders included), restricted ones included — names and
// template metadata only, no values.
export async function listFolderSecrets(cfg: DelineaConfig, folderId: number, token: string, fetcher: Fetcher = defaultFetcher): Promise<SecretSearchRecord[]> {
  const base =
    `${cfg.baseUrl}/api/v1/secrets?filter.folderId=${encodeURIComponent(String(folderId))}` +
    `&filter.includeSubFolders=true&filter.includeRestricted=true&filter.scope=All`;
  return pageAll(
    (skip) => `${base}&take=${PAGE}&skip=${skip}`,
    token,
    fetcher,
    (r) => ({
      id: Number(r.id),
      name: String(r.name ?? ""),
      folderPath: String(r.folderPath ?? ""),
      secretTemplateId: r.secretTemplateId == null ? undefined : Number(r.secretTemplateId),
      secretTemplateName: r.secretTemplateName == null ? undefined : String(r.secretTemplateName),
    })
  );
}
