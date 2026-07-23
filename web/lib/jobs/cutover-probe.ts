// Server-side liveness probe for the cutover console (feature #2). Hits the PUBLIC /api/health/probe
// marker on a base URL and confirms it is OUR app answering ("probe":"iam"), not some other service on
// the port. Used for two things: the rollback safety check (the old Mac "lighthouse" must be reachable
// before we tell agents to go back), and a display signal that the Azure host is up.
//
// Caveat this reflects on purpose: reachability is measured FROM THE APP SERVER running this code, which
// is not identical to reachability from each client-network agent. It's a strong proxy — a URL the app
// can't reach is one agents very likely can't either — and it never blocks hard (the button carries a
// force override), so a false negative is recoverable. Never throws.
export type ProbeResult = { ok: boolean; detail: string; db?: boolean };

export async function probeUrl(baseUrl: string | null | undefined, timeoutMs = 2500): Promise<ProbeResult> {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return { ok: false, detail: "no URL" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/health/probe`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { probe?: string; db?: boolean } | null;
    if (body?.probe !== "iam") return { ok: false, detail: "reachable but not the iam-engine app" };
    return { ok: true, detail: body.db ? "reachable · db ok" : "reachable · db down", db: Boolean(body.db) };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? `no response within ${timeoutMs}ms` : (e as Error).message;
    return { ok: false, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
