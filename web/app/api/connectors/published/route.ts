// GET /api/connectors/published — the published custom connectors a client can attach as systems
// (FR #102). Read-only and gated on client.edit_systems, not connector.manage: the people who need
// this list are the ones editing a client's systems, not only the connector builders.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { publishedConnectorSystems } from "@/lib/connectors/repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const _g = await guard("client.edit_systems"); if (_g.res) return _g.res;
  return NextResponse.json(await publishedConnectorSystems());
}
