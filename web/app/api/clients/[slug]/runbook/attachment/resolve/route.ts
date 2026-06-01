// POST /api/clients/:slug/runbook/attachment/resolve
// Body: { action, seq, i?, user?: { department, jobTitle, location } }
// Fetches the section's sys_attachment spreadsheet (app-side creds), parses it, and asks the
// LLM which groups apply to the user. Deterministic parse + LLM-for-decision; redaction is
// applied inside azureChatJson. Degrades with clear errors when SN/Azure env is absent.
import { db } from "@/lib/db";
import { asArtifacts, isAttachment } from "@/lib/runbook/artifacts";
import { fetchAttachment } from "@/lib/servicenow/attachments";
import { snConfigFromEnv } from "@/lib/servicenow/gateway";
import { parseGroupSheet } from "@/lib/automation/xls-groups";
import { resolveGroups, type UserAttrs } from "@/lib/automation/group-resolver";

type Ctx = { params: { slug: string } };

export async function POST(req: Request, { params }: Ctx) {
  let body: { action?: string; seq?: number; i?: number; user?: UserAttrs };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 422 });
  }
  const { action, seq, i = 0, user = {} } = body;
  if ((action !== "onboard" && action !== "offboard") || !Number.isInteger(seq)) {
    return Response.json({ error: "action (onboard|offboard) and integer seq are required" }, { status: 422 });
  }

  const client = await db.client.findUnique({ where: { slug: params.slug }, select: { id: true } });
  if (!client) return Response.json({ error: "client not found" }, { status: 404 });

  const section = await db.runbookSection.findFirst({
    where: { clientId: client.id, action, seq },
    select: { artifacts: true },
  });
  const att = asArtifacts(section?.artifacts).filter(isAttachment)[i];
  if (!att?.sysId) return Response.json({ error: "no attachment with a sys_id for that section" }, { status: 404 });

  let fetched;
  try {
    fetched = await fetchAttachment(snConfigFromEnv(), att.sysId);
  } catch (e) {
    return Response.json({ error: `could not fetch attachment (check SN_* env): ${(e as Error).message}` }, { status: 502 });
  }

  let sheet;
  try {
    sheet = parseGroupSheet(fetched.data);
  } catch (e) {
    return Response.json({ error: `could not parse spreadsheet: ${(e as Error).message}` }, { status: 422 });
  }

  const resolution = await resolveGroups(sheet, user);
  const sheetMeta = { headers: sheet.headers, rowCount: sheet.rows.length, filename: att.filename };
  if (!resolution) {
    return Response.json({ error: "LLM not configured — set AZURE_OPENAI_* to resolve groups", sheet: sheetMeta }, { status: 503 });
  }
  return Response.json({ resolution, sheet: sheetMeta });
}
