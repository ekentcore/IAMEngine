// POST /api/clients/import — { coreIds: "CORE1269, CORE832" } import one or many clients straight
// from their CORE ids: resolve each in ServiceNow, create it, find its KB runbooks and build it out.
//
// The response is a stream of NDJSON lines, one per finished id, because a build is up to two KB
// fetches plus two AI extractions per client — twenty ids is minutes of work, and a request that
// only answers at the end leaves the operator staring at a spinner with no idea whether it is
// progressing or hung. Ids run sequentially: it keeps ServiceNow/Azure load flat and makes the
// stream a readable progress log.
import { guard } from "@/lib/auth/route-guard";
import { fleetWideAccess } from "@/lib/auth/fleet-access";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseCoreIds, importClientByCoreId, type ImportResult } from "@/lib/clients/import-by-coreid";
import { makeImportDeps } from "@/lib/clients/import-by-coreid-deps";

export const dynamic = "force-dynamic";
export const maxDuration = 900; // seconds — 25 clients x (2 KB fetches + 2 AI extracts)

// A full-roster paste would otherwise pin the server for the better part of an hour. (Not exported:
// a route module may only export the handlers and Next's own config keys.)
const MAX_IDS = 25;

export async function POST(req: Request) {
  const g = await guard("client.edit_systems"); if (g.res) return g.res;

  const fleet = await fleetWideAccess(db, g.user.id);
  if (!fleet.ok) return NextResponse.json({ error: fleet.reason }, { status: 403 });
  const actor = `ui:${g.user.email ?? g.user.id}`;

  let body: { coreIds?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON body" }, { status: 422 }); }

  const raw = typeof body.coreIds === "string" ? body.coreIds : Array.isArray(body.coreIds) ? body.coreIds.join(",") : "";
  const { ids, invalid } = parseCoreIds(raw);
  if (!ids.length && !invalid.length) return NextResponse.json({ error: "no CORE ids given" }, { status: 422 });
  if (ids.length > MAX_IDS) {
    return NextResponse.json({ error: `too many ids (${ids.length}); import at most ${MAX_IDS} at a time` }, { status: 422 });
  }

  // The scope still matters per client: a RESTRICTED client (Coretelligent, say) is outside even an
  // "all"-mode operator's scope unless they were granted it. Naming its CORE id must not claim,
  // re-parent or rebuild it behind their back.
  const deps = makeImportDeps(db, fleet.scope);
  const encoder = new TextEncoder();
  const line = (r: ImportResult) => encoder.encode(`${JSON.stringify(r)}\n`);

  const stream = new ReadableStream({
    async start(controller) {
      for (const id of ids) {
        // The operator closed the dialog or the tab. Without this the loop runs on regardless —
        // minutes of ServiceNow queries, Azure calls and writes for a result nobody will see (and
        // enqueue() would throw on the dead stream anyway).
        if (req.signal.aborted) break;

        let result: ImportResult;
        try {
          result = await importClientByCoreId(deps, id, actor);
        } catch (err) {
          // importClientByCoreId already traps per-id failures; this is the belt-and-braces case, so
          // one bad id can never kill the stream and strand the ids behind it.
          result = { coreId: id, status: "error", built: [], createdSystems: [], warnings: [], error: err instanceof Error ? err.message : String(err) };
        }
        controller.enqueue(line(result));
      }
      // Junk tokens are reported like any other row — the operator gets one table, not an error that
      // hides the ids that WOULD have imported. They come last: the real work streams first.
      for (const bad of invalid) {
        controller.enqueue(line({ coreId: bad, status: "invalid", built: [], createdSystems: [], warnings: [] }));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no", // don't let a proxy buffer the stream into one lump at the end
    },
  });
}
