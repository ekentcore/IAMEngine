// Per-user client visibility — the single source of truth for "which clients may this operator see".
// Resolution rule (see the ClientAccessMode enum + UserClientAccess model in schema.prisma):
//   only     → exactly the user's scope list (an allowlist; a restricted client listed here is granted)
//   all      → every client EXCEPT restricted ones the user hasn't been granted
//   exclude  → every client EXCEPT the scope (deny) list, and except ungranted restricted ones
// super_admin and the synthetic system user (auth disabled) bypass scoping entirely — the anti-lockout
// backstop. Enforced at every read path: list queries filter to the visible set, detail reads 404.
import type { PrismaClient, ClientAccessMode } from "@prisma/client";
import { authEnabled, getCurrentUser } from "./current-user";

export type ScopeInput = {
  mode: ClientAccessMode;
  scopeIds: Iterable<string>; // kind=scope rows — the only/exclude list
  grantIds: Iterable<string>; // kind=grant rows — explicit access to a restricted client
  clients: { id: string; restricted: boolean }[]; // the full roster
};

// Whether a single client is visible under a given mode + the user's scope/grant sets. Pure + total.
export function isClientVisible(
  mode: ClientAccessMode,
  client: { id: string; restricted: boolean },
  scope: Set<string>,
  grant: Set<string>,
): boolean {
  // only-mode is a pure allowlist: membership alone authorizes, even for a restricted client (an admin
  // explicitly listing it IS the grant). A non-listed client — restricted or not — is invisible.
  if (mode === "only") return scope.has(client.id);
  // all/exclude: a restricted client needs an explicit grant before the base mode is even considered.
  if (client.restricted && !grant.has(client.id)) return false;
  if (mode === "exclude") return !scope.has(client.id); // deny list wins (incl. over a grant)
  return true; // all
}

// The set of client IDs a non-super, signed-in user may see, given their config and the full roster.
export function computeVisibleClientIds(input: ScopeInput): string[] {
  const scope = new Set(input.scopeIds);
  const grant = new Set(input.grantIds);
  return input.clients.filter((c) => isClientVisible(input.mode, c, scope, grant)).map((c) => c.id);
}

// A resolved scope: null = unrestricted (super admin or auth-off system user), else the exact set of
// visible client IDs. The empty array means "sees nothing" (a signed-out/over-scoped user).
export type ClientScope = string[] | null;

// Resolve the CURRENT request's operator scope. Call from a request context (server component, route
// handler, or server action). null = no restriction.
export async function currentClientScope(db: PrismaClient): Promise<ClientScope> {
  if (!authEnabled()) return null; // auth off → synthetic system super-admin, sees everything
  const me = await getCurrentUser();
  if (!me) return []; // signed out (middleware blocks first; defensive — see nothing)
  if (me.role === "super_admin") return null; // top tier bypasses scoping (anti-lockout backstop)
  const [access, clients] = await Promise.all([
    db.userClientAccess.findMany({ where: { userId: me.id }, select: { clientId: true, kind: true } }),
    db.client.findMany({ select: { id: true, restricted: true } }),
  ]);
  return computeVisibleClientIds({
    mode: me.clientAccessMode,
    scopeIds: access.filter((a) => a.kind === "scope").map((a) => a.clientId),
    grantIds: access.filter((a) => a.kind === "grant").map((a) => a.clientId),
    clients,
  });
}

// Does a resolved scope permit this client? null scope allows anything; a missing id never matches.
export function scopeAllows(scope: ClientScope, clientId: string | null | undefined): boolean {
  if (scope === null) return true;
  if (!clientId) return false;
  return scope.includes(clientId);
}

// A Prisma `where` fragment for `clientId` (or `id` on Client): undefined = no filter, else an `in`.
export function clientIdWhere(scope: ClientScope): { in: string[] } | undefined {
  return scope === null ? undefined : { in: scope };
}

// Resource-level guards for operator mutation routes that act by case/job id: a scoped operator must
// not pause/verify/rerun/approve a case of a client they can't see (even by guessing the id). Returns
// false → the caller should 404. Unrestricted operators (null scope) always pass.
export async function caseInScope(db: PrismaClient, caseId: string): Promise<boolean> {
  const scope = await currentClientScope(db);
  if (scope === null) return true;
  const c = await db.caseRequest.findUnique({ where: { id: caseId }, select: { clientId: true } });
  return !!c && scopeAllows(scope, c.clientId);
}

export async function jobInScope(db: PrismaClient, jobId: string): Promise<boolean> {
  const scope = await currentClientScope(db);
  if (scope === null) return true;
  const j = await db.job.findUnique({ where: { id: jobId }, select: { case: { select: { clientId: true } } } });
  return !!j && scopeAllows(scope, j.case.clientId);
}
