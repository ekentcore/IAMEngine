// POST /api/connectors/:id/publish — make a definition executable (connector.manage → global_admin).
// Publishing (re-)validates the definition, upserts the SystemCatalog row so clients can attach the
// system, and stamps status=published — the ONLY state the claim path injects into jobs.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { publishConnector } from "@/lib/connectors/repository";

type Ctx = { params: { id: string } };

export async function POST(_req: Request, { params }: Ctx) {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;
  const result = await publishConnector(params.id, `user:${_g.user.email}`);
  if (!result.ok) return NextResponse.json({ errors: result.errors }, { status: result.errors[0] === "unknown connector" ? 404 : 422 });
  return NextResponse.json(result.connector);
}
