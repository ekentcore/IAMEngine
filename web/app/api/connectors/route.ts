// GET  /api/connectors — list connectors (connector.manage; the /connectors builder).
// POST /api/connectors — create a draft connector { key, name, kind, definition, notes? }.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { createConnector, listConnectors } from "@/lib/connectors/repository";

export async function GET() {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;
  return NextResponse.json(await listConnectors());
}

export async function POST(req: Request) {
  const _g = await guard("connector.manage"); if (_g.res) return _g.res;

  let body: { key?: unknown; name?: unknown; kind?: unknown; definition?: unknown; notes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const result = await createConnector(
    {
      key: typeof body.key === "string" ? body.key.trim() : "",
      name: typeof body.name === "string" ? body.name : "",
      kind: typeof body.kind === "string" ? body.kind : "",
      definition: body.definition,
      notes: typeof body.notes === "string" ? body.notes : null,
    },
    `user:${_g.user.email}`
  );
  if (!result.ok) return NextResponse.json({ errors: result.errors }, { status: 422 });
  return NextResponse.json(result.connector, { status: 201 });
}
