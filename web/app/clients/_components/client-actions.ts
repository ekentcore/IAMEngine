// Client-row mutation helpers shared by ClientsTable (v1) and ClientsExplorer (v2): one place for
// the PATCH/bulk endpoints and their error semantics (non-JSON error bodies — proxy 502s, HTML
// login redirects — must surface as a readable message, never an unhandled rejection).

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? res.statusText ?? `failed (${res.status})`;
}

// PATCH /api/clients/:slug with { action, ...payload }. Returns ok + a displayable error.
export async function patchClient(
  slug: string,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/api/clients/${slug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// Hard refresh one or many clients from ServiceNow (single uses the per-client PATCH action,
// several use the bulk route).
export async function hardRefreshClients(slugs: string[]): Promise<{ ok: boolean; error?: string }> {
  if (slugs.length === 1) return patchClient(slugs[0], "hard-refresh");
  try {
    const res = await fetch(`/api/clients/hard-refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slugs }),
    });
    if (!res.ok) return { ok: false, error: await errorOf(res) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
