// Authorization for Route Handlers: `const g = await guard("perm"); if (g.res) return g.res;`
// returns the acting user, or a ready NextResponse (401/403) to return immediately. When auth is
// off, passes through as a system admin. Runner endpoints (/api/agents, /api/jobs/{claim,credential,
// result,progress}) are bearer-gated in middleware and must NOT use this.
import { NextResponse } from "next/server";
import { requirePermission, requireUser, AuthError, type ActingUser } from "./guard";
import type { Permission } from "./permissions";

type GuardOk = { user: ActingUser; res?: undefined };
type GuardDeny = { res: NextResponse; user?: undefined };

export async function guard(perm: Permission): Promise<GuardOk | GuardDeny> {
  try {
    return { user: await requirePermission(perm) };
  } catch (e) {
    if (e instanceof AuthError) return { res: NextResponse.json({ error: e.message }, { status: e.status }) };
    throw e;
  }
}

// Authentication-only guard (no specific capability) for data-returning GET routes: validates the
// session SERVER-SIDE against the DB — token, expiry, revocation, active status — so an arbitrary or
// stale cookie can't read data. (Edge middleware can only check cookie PRESENCE; this is the
// authoritative check.) Any active operator may read; mutations still use guard(perm).
export async function guardAuth(): Promise<GuardOk | GuardDeny> {
  try {
    return { user: await requireUser() };
  } catch (e) {
    if (e instanceof AuthError) return { res: NextResponse.json({ error: e.message }, { status: e.status }) };
    throw e;
  }
}
