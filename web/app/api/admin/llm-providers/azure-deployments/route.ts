// POST /api/admin/llm-providers/azure-deployments — list the deployments on an Azure resource, so
// the Settings form can offer them in a dropdown instead of making an operator type a name that has
// to match Azure exactly. (A typo'd deployment name and an unsupported model look identical from
// the outside: both just fail.)
//
// It returns the DEPLOYMENT names (what goes in `model`), each with the model behind it and its
// status. Deliberately NOT /openai/v1/models — that's the ~180-entry catalog of models the resource
// *could* run, which lists names you may have no deployment of.
//
// Key handling, which is the whole security question here:
//   * a key typed into the form is sent with the request — the operator owns both it and the
//     endpoint they typed, so there's nothing to protect them from.
//   * otherwise we may use an EXISTING provider's stored key, but ONLY against its own host. If the
//     endpoint has been pointed somewhere else, we refuse and ask for the key — the same rule the
//     PATCH route enforces, and for the same reason: the stored key must never be sent to a host
//     the operator hasn't proved they hold the key for.
// The key is never returned to the browser.
import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/route-guard";
import { db } from "@/lib/db";
import { keyDestinationChanged } from "@/lib/fixes/providers";
import { azureEndpointProblem } from "@/lib/fixes/provider-presets";

export const dynamic = "force-dynamic";

const LIST_API_VERSION = "2023-03-15-preview"; // the data-plane deployments list

export async function POST(req: Request) {
  const g = await guard("settings.manage");
  if (g.res) return g.res;

  let body: { endpoint?: unknown; apiKey?: unknown; providerId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 422 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim().replace(/\/+$/, "") : "";
  const problem = azureEndpointProblem(endpoint);
  if (problem) return NextResponse.json({ error: problem }, { status: 422 });

  const typedKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null;
  let apiKey = typedKey;

  if (!apiKey) {
    const providerId = typeof body.providerId === "string" ? body.providerId : "";
    if (!providerId) return NextResponse.json({ error: "enter the API key to list deployments" }, { status: 422 });
    const provider = await db.llmProvider.findUnique({ where: { id: providerId } });
    if (!provider) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (keyDestinationChanged(provider.baseUrl, endpoint)) {
      return NextResponse.json({ error: "re-enter the API key to list deployments on a different host" }, { status: 422 });
    }
    apiKey = provider.apiKey;
  }

  try {
    const res = await fetch(`${endpoint}/openai/deployments?api-version=${LIST_API_VERSION}`, {
      headers: { "api-key": apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      return NextResponse.json({ error: `Azure returned ${res.status}${text ? ` — ${text}` : ""}` }, { status: 502 });
    }
    const json = (await res.json()) as { data?: Array<{ id?: string; model?: string; status?: string }> };
    const deployments = (json.data ?? [])
      .filter((d) => d.id)
      .map((d) => ({ name: d.id as string, model: d.model ?? "", status: d.status ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json({ deployments });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "request failed" }, { status: 502 });
  }
}
