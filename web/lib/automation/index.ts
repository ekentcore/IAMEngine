// Registry of per-system "intended automation" code-preview templaters. Add a system by
// adding its previewer here (mirrors the generator's extractor registry). Used by the client
// page to show, per automated system, the code the module would run.
import { previewM365 } from "./m365-preview";

export type Action = "onboard" | "offboard";
export type Previewer = (action: Action, config: any, identity: any, primaryDomain: string) => string;

const PREVIEWERS: Record<string, Previewer> = {
  m365: previewM365,
};

export function automationPreview(systemKey: string, action: Action, config: unknown, identity: unknown, primaryDomain: string): string | null {
  const fn = PREVIEWERS[systemKey];
  return fn ? fn(action, config as any, (identity ?? {}) as any, primaryDomain) : null;
}
