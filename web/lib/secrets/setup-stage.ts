// Coarse stages a browser-based credential setup passes through, in order. The runner flows emit one
// of these on the job progress channel; the create-api GET surfaces it, and the guided-setup wizard
// maps it to a checklist position. Deliberately coarse (four working stages + done) — no per-selector
// detail. `stageIndex` returns -1 for an unknown/absent stage so the UI shows an indeterminate step.
export const SETUP_STAGES = ["signin", "create", "harvest", "vault", "done"] as const;
export type SetupStage = (typeof SETUP_STAGES)[number];

export function stageIndex(stage: string | null | undefined): number {
  if (!stage) return -1;
  return (SETUP_STAGES as readonly string[]).indexOf(stage.toLowerCase());
}
