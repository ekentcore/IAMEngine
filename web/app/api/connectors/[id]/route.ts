// PATCH  /api/connectors/:id — edit a connector { name?, definition?, notes? } (connector.manage).
// DELETE /api/connectors/:id — archive it (stops claim-time injection; catalog row stays so attached
//                              clients don't dangle). Publish again to un-archive.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { archiveConnector, updateConnector } from "@/lib/connectors/repository";

type Ctx = { params: { id: string } };

export async function PATCH(req: Request, { params }: Ctx) {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;

  let body: { name?: unknown; definition?: unknown; notes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const result = await updateConnector(
    params.id,
    {
      ...(body.name !== undefined ? { name: typeof body.name === "string" ? body.name : "" } : {}),
      ...(body.definition !== undefined ? { definition: body.definition } : {}),
      ...(body.notes !== undefined ? { notes: typeof body.notes === "string" ? body.notes : null } : {}),
    },
    `user:${_g.user.email}`
  );
  if (!result.ok) return NextResponse.json({ errors: result.errors }, { status: result.errors[0] === "unknown connector" ? 404 : 422 });
  return NextResponse.json(result.connector);
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;
  const result = await archiveConnector(params.id, `user:${_g.user.email}`);
  if (!result.ok) return NextResponse.json({ errors: result.errors }, { status: 404 });
  return NextResponse.json(result.connector);
}
