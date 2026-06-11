// POST /api/clients/:slug/runbook/kb-json — import KB article body from an uploaded ServiceNow JSON
// export (the file's raw text is the request body), for when the integration account can't read
// kb_knowledge directly. Extracts each record's `text` (the article HTML), converts it to the same
// plain text the "Fetch from KB" button produces, and returns it for the normal parse-preview ->
// save flow. A KB edit never silently rewrites the client — the operator still previews + saves.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { htmlToText } from "@/lib/servicenow/kb";

export const dynamic = "force-dynamic";

type Row = { number?: unknown; short_description?: unknown; title?: unknown; text?: unknown };

export async function POST(req: Request) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;

  let raw: string;
  try { raw = await req.text(); } catch { return NextResponse.json({ error: "could not read the uploaded file" }, { status: 400 }); }

  let data: unknown;
  try { data = JSON.parse(raw); } catch { return NextResponse.json({ error: "not valid JSON — export the KB record(s) from ServiceNow as JSON" }, { status: 422 }); }

  // Accept { records: [...] } (SN UI export), { result: [...] } (Table API), a bare array, or one object.
  const d = data as { records?: unknown; result?: unknown };
  const rows: Row[] = Array.isArray(data) ? (data as Row[])
    : Array.isArray(d.records) ? (d.records as Row[])
    : Array.isArray(d.result) ? (d.result as Row[])
    : data && typeof data === "object" ? [data as Row] : [];

  const records = rows
    .map((r) => ({
      number: String(r.number ?? "").toUpperCase(),
      title: String(r.short_description ?? r.title ?? ""),
      html: typeof r.text === "string" ? r.text : "",
    }))
    .filter((r) => r.html.trim())
    .map((r) => ({ number: r.number, title: r.title, text: htmlToText(r.html) }));

  if (records.length === 0) {
    return NextResponse.json({ error: "no KB body found — expected records[].text (the article HTML) in the file" }, { status: 422 });
  }
  return NextResponse.json({ records });
}
