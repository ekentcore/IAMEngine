// Authorization for Route Handlers: `const g = await guard("perm"); if (g.res) return g.res;`
// returns the acting user, or a ready NextResponse (401/403) to return immediately. When auth is
// off, passes through as a system admin. Runner endpoints (/api/agents, /api/jobs/{claim,credential,
// result,progress}) are bearer-gated in middleware and must NOT use this.
import { NextResponse } from "next/server";
import { requirePermission, AuthError, type ActingUser } from "./guard";
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
