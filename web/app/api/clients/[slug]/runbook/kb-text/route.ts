// GET /api/clients/:slug/runbook/kb-text?article=KB0012345 — the article's CURRENT body from
// ServiceNow as plain text, for the runbook editor's "Fetch latest from KB" button. The operator
// then reviews the parse preview and saves — a KB edit never silently rewrites the client.
import { NextResponse } from "next/server";
import { snConfigFromEnv, SnGatewayError } from "@/lib/servicenow/gateway";
import { fetchKbArticle } from "@/lib/servicenow/kb";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const article = new URL(req.url).searchParams.get("article")?.trim().toUpperCase() ?? "";
  if (!/^KB\d{4,12}$/.test(article)) {
    return NextResponse.json({ error: "article must be a KB number, e.g. KB0012345" }, { status: 422 });
  }
  try {
    const kb = await fetchKbArticle(snConfigFromEnv(), article);
    if (!kb) return NextResponse.json({ error: `${article} not found in ServiceNow` }, { status: 404 });
    return NextResponse.json(kb);
  } catch (e) {
    const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
