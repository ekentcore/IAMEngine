// Shared server-side gate for the document-management routes (AI update, publish, discard): any
// signed-in operator whose role may manage docs (global_admin and above). Re-checked here on every
// route, independent of whether the UI showed the button.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { authEnabled } from "@/lib/auth/current-user";
import type { ActingUser } from "@/lib/auth/guard";
import { canManageDocs } from "./access";

type Ok = { user: ActingUser; res?: undefined };
type Deny = { res: NextResponse; user?: undefined };

export async function guardManageDocs(): Promise<Ok | Deny> {
  const g = await guardAuth();
  if (g.res) return { res: g.res };
  if (authEnabled() && !canManageDocs(g.user.role)) return { res: NextResponse.json({ error: "managing documents requires global admin" }, { status: 403 }) };
  return { user: g.user };
}
