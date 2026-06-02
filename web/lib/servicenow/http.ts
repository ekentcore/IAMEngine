// Low-level ServiceNow HTTP: basic auth, request timeout, typed errors. Shared by the
// roster gateway and the intake gateway so auth/timeout logic lives in one place.
import type { SnConfig } from "./types";

const REQUEST_TIMEOUT_MS = 15_000; // don't let a slow/unreachable SN hang a page render

export class SnGatewayError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly body?: string) {
    super(message);
    this.name = "SnGatewayError";
  }
}

type Fetcher = typeof fetch;

function authHeader(config: SnConfig): string {
  const token = Buffer.from(`${config.username}:${config.password}`).toString("base64");
  return `Basic ${token}`;
}

export function assertConfig(config: SnConfig): void {
  if (!config.instanceUrl || !config.username || !config.password) {
    throw new SnGatewayError("ServiceNow config incomplete (instanceUrl/username/password)");
  }
}

// GET a ServiceNow REST path with query params; returns the parsed `result` payload.
export async function snGet<T>(
  config: SnConfig,
  path: string,
  params: Record<string, string>,
  fetcher: Fetcher = fetch
): Promise<T> {
  const url = new URL(`${config.instanceUrl}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetcher(url.toString(), {
      headers: { Authorization: authHeader(config), Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SnGatewayError(`ServiceNow request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new SnGatewayError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SnGatewayError(
      `ServiceNow returned ${res.status} ${res.statusText}`,
      res.status,
      body.slice(0, 500)
    );
  }

  const json = (await res.json()) as { result: T };
  return json.result;
}

// Write a JSON body to a ServiceNow REST path (POST to create, PATCH to update — a work-note
// append is a PATCH of the record's `work_notes` journal field). Returns the parsed `result`.
// Mirrors snGet's auth + timeout + typed-error handling.
export async function snWrite<T>(
  config: SnConfig,
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  fetcher: Fetcher = fetch
): Promise<T> {
  const url = new URL(`${config.instanceUrl}${path}`);

  let res: Response;
  try {
    res = await fetcher(url.toString(), {
      method,
      headers: { Authorization: authHeader(config), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SnGatewayError(`ServiceNow request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new SnGatewayError(err instanceof Error ? err.message : String(err));
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new SnGatewayError(`ServiceNow returned ${res.status} ${res.statusText}`, res.status, text.slice(0, 500));
  }

  const json = (await res.json()) as { result: T };
  return json.result;
}

export const snPost = <T>(config: SnConfig, path: string, body: unknown, fetcher: Fetcher = fetch) =>
  snWrite<T>(config, "POST", path, body, fetcher);
