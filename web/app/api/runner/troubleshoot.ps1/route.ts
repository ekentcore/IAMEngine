// GET /api/runner/troubleshoot.ps1?agent=<agentId> — a self-contained diagnostic for a runner host
// that enrolled but never comes online ("pre-build runner", update stuck on "queued"). One-liner
// usage (shown per-agent on /agents):  irm http://<app>/api/runner/troubleshoot.ps1?agent=… | iex
//
// Open like the rest of /api/runner/* (a broken host has nothing to authenticate with) and contains
// NO secrets — it reads RUNNER_API_TOKEN from the host's own machine environment. The app URL is
// derived from the host the operator actually connected to, same as install.ps1.
import { troubleshootScript } from "@/lib/runner/troubleshoot";

export const dynamic = "force-dynamic";

const ps = (s: string, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent") ?? "";
  if (!agentId) return ps(`Write-Error "Missing ?agent=<agentId> — copy the troubleshoot command from the Agents page."`, 422);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? (url.protocol.replace(":", "") || "http");
  const appUrl = host ? `${proto}://${host}` : url.origin;
  return ps(troubleshootScript(appUrl, agentId));
}
