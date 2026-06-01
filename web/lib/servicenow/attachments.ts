// Fetch a ServiceNow attachment's binary by sys_id (the group-mapping spreadsheets the KB
// links via /sys_attachment.do?sys_id=…). Creds live in the app, never in the browser — the
// app proxies the download. Mirrors http.ts auth/timeout.
import type { SnConfig } from "./types";
import { SnGatewayError, assertConfig } from "./http";

const REQUEST_TIMEOUT_MS = 20_000;

export type FetchedAttachment = { data: Buffer; contentType: string };

export async function fetchAttachment(
  config: SnConfig,
  sysId: string,
  fetcher: typeof fetch = fetch
): Promise<FetchedAttachment> {
  assertConfig(config);
  if (!/^[0-9a-f]{32}$/i.test(sysId)) throw new SnGatewayError(`invalid attachment sys_id: ${sysId}`);

  const url = `${config.instanceUrl}/api/now/attachment/${sysId}/file`;
  const auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;

  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { Authorization: auth, Accept: "*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SnGatewayError(`attachment request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new SnGatewayError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    throw new SnGatewayError(`ServiceNow attachment returned ${res.status} ${res.statusText}`, res.status);
  }
  return {
    data: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

// Parse the sys_id out of a sys_attachment href (handles full or relative URLs).
export function sysIdFromHref(href: string): string | null {
  return /sys_id=([0-9a-f]{32})/i.exec(href)?.[1] ?? null;
}
