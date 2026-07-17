// Assemble a DRAFT http definition from imported HAR operations. The admin has, in the UI, picked
// which operations to keep, named them, chosen auth, and (optionally) provided sample→template
// substitutions. This produces a definition object that still has to pass validateConnectorDefinition
// before it can be saved — assembly never bypasses the schema.
import type { HttpDefinition, LaneStep } from "./definition";
import { type ImportedOperation, templatizeOperation } from "./import-har";

export type AssembleInput = {
  baseUrl: string;
  hosts: string[];
  auth: HttpDefinition["auth"];
  samples: { value: string; template: string }[];
  // Operations the admin kept, each with a final name + which lane step(s) it becomes.
  operations: { op: ImportedOperation; name: string }[];
  lanes: Partial<Record<"test" | "onboard" | "offboard", LaneStep[]>>;
};

// Turn a captured absolute path into one relative to baseUrl when it shares the prefix — so a
// definition reads "/users" not the full URL, and the host allowlist stays the single source of truth.
function relativizePath(path: string, baseUrl: string): string {
  try {
    const basePath = new URL(baseUrl).pathname.replace(/\/$/, "");
    if (basePath && path.startsWith(basePath + "/")) return path.slice(basePath.length);
    if (basePath && path.startsWith(basePath + "?")) return path.slice(basePath.length);
  } catch { /* fall through */ }
  return path.startsWith("/") ? path : `/${path}`;
}

export function assembleHttpDefinition(input: AssembleInput): HttpDefinition {
  const operations: HttpDefinition["operations"] = {};
  for (const { op, name } of input.operations) {
    const t = input.samples.length ? templatizeOperation(op, input.samples) : op;
    operations[name] = {
      request: {
        method: op.method as HttpDefinition["operations"][string]["request"]["method"],
        path: relativizePath(t.path, input.baseUrl),
        ...(Object.keys(t.headers).length ? { headers: t.headers } : {}),
        ...(t.body !== null && t.body !== undefined ? { body: t.body } : {}),
      },
      // Default the success status to what the capture actually returned, so re-runs match reality.
      ...(op.responseStatus ? { expect: { status: [op.responseStatus] } } : {}),
    };
  }
  return {
    version: 1,
    kind: "http",
    baseUrl: input.baseUrl,
    hosts: input.hosts,
    auth: input.auth,
    operations,
    lanes: input.lanes,
  };
}
