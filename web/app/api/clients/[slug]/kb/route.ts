// GET /api/clients/:slug/kb — render the client's current systems into pasteable KB text
// (HTML + Markdown, for both onboard and offboard).
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { renderKb } from "@/lib/clients/kb-render";

export async function GET(_req: Request, { params }: { params: { slug: string } }) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  const client = await makeClientRepository(db).getClientBySlug(params.slug, await currentClientScope(db));
  if (!client) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(renderKb(client));
}
