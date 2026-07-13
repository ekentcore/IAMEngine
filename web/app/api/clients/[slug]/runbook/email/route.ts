import { NextResponse } from "next/server";
// GET /api/clients/:slug/runbook/email?action=onboard&seq=2&i=0
// Download the email template of a runbook section as a .eml. Placeholders are the KB
// template's; a pulled UM case fills them later. First file-download route in the app.
import { db } from "@/lib/db";
import { guardAuth } from "@/lib/auth/route-guard";
import { clientSlugInScope } from "@/lib/auth/client-scope";
import { asArtifacts, isEmail } from "@/lib/runbook/artifacts";
import { buildEml, emlFilename } from "@/lib/runbook/eml";

type Ctx = { params: { slug: string } };

export async function GET(req: Request, { params }: Ctx) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  // scope-gated: an out-of-scope client reads as not-found (see clientSlugInScope).
  if (!(await clientSlugInScope(db, params.slug))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const seq = Number(url.searchParams.get("seq"));
  const i = Number(url.searchParams.get("i") ?? 0);
  if ((action !== "onboard" && action !== "offboard") || !Number.isInteger(seq)) {
    return Response.json({ error: "action (onboard|offboard) and integer seq are required" }, { status: 422 });
  }

  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true } });
  if (!client) return Response.json({ error: "client not found" }, { status: 404 });

  const section = await db.runbookSection.findFirst({
    where: { clientId: client.id, action, seq },
    select: { artifacts: true },
  });
  const email = asArtifacts(section?.artifacts).filter(isEmail)[i];
  if (!email) return Response.json({ error: "no email artifact for that section" }, { status: 404 });

  return new Response(buildEml(email), {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${emlFilename(params.slug, email)}"`,
    },
  });
}
