import type { ApiSetupEntry } from "./api-setup-catalog";

export type SetupSource = "auto" | "paste" | "existing";

// The ordered wizard step ids for a vendor + chosen credential source. Pure so the stepper's flow is
// unit-testable without React: automatic vendors get the full run wizard; paste/existing (and an "auto"
// request on a vendor with no browser flow) collapse to the field/existing path with no run step.
export function wizardStepIds(entry: ApiSetupEntry, source: SetupSource): string[] {
  const canAuto = Boolean(entry.autoCreateEndpoint);
  if (source === "auto" && canAuto) return ["overview", "prep", "login", "run", "done"];
  if (source === "existing") return ["overview", "existing", "done"];
  return ["overview", "fields", "done"]; // paste, or auto requested on a non-automatic vendor
}
