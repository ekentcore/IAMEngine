// GET /api/clients/:slug/runbook/kb-text?article=KB0012345 — the article's CURRENT body from
// ServiceNow as plain text, for the runbook editor's "Fetch latest from KB" button. The operator
// then reviews the parse preview and saves — a KB edit never silently rewrites the client.
import { NextResponse } from "next/server";
import { guardAuth } from "@/lib/auth/route-guard";
import { snConfigFromEnv, SnGatewayError } from "@/lib/servicenow/gateway";
import { fetchKbArticle } from "@/lib/servicenow/kb";
import { detectKbAction } from "@/lib/clients/runbook-parse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const _g = await guardAuth(); if (_g.res) return _g.res;
  const article = new URL(req.url).searchParams.get("article")?.trim().toUpperCase() ?? "";
  if (!/^KB\d{4,12}$/.test(article)) {
    return NextResponse.json({ error: "article must be a KB number, e.g. KB0012345" }, { status: 422 });
  }
  try {
    const kb = await fetchKbArticle(snConfigFromEnv(), article);
    if (!kb) {
      // ServiceNow ACLs FILTER unreadable rows (HTTP 200, zero results) — indistinguishable from
      // a truly missing article. Most often the integration account simply lacks knowledge read.
      return NextResponse.json({
        error: `${article} returned no rows — either it doesn't exist, or the API account can't read kb_knowledge. If the article exists in ServiceNow, grant the integration user knowledge access (the 'knowledge' role, or add it to the knowledge base's "Can Read" criteria).`,
      }, { status: 404 });
    }
    return NextResponse.json({ ...kb, detectedAction: detectKbAction(kb.title || kb.number, kb.text) });
  } catch (e) {
    const msg = e instanceof SnGatewayError ? `ServiceNow: ${e.message}` : (e as Error).message;
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
