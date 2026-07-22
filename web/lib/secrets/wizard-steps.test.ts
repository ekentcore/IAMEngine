import { test } from "node:test";
import assert from "node:assert/strict";
import { wizardStepIds } from "./wizard-steps";
import type { ApiSetupEntry } from "./api-setup-catalog";

const auto = { systemKey: "adobe", secretName: "adobe", label: "Adobe", consoleUrl: "https://x", steps: ["a"], autoBrowser: "adobe-console-setup", autoCreateEndpoint: "adobe-setup/create-api", autoConsoleSecret: "adobe-console" } as ApiSetupEntry;
const manual = { systemKey: "proofpoint", secretName: "proofpoint", label: "Proofpoint", consoleUrl: "https://x", steps: ["a"] } as ApiSetupEntry;

test("automatic vendor + auto source -> full run wizard", () => {
  assert.deepEqual(wizardStepIds(auto, "auto"), ["overview", "prep", "login", "run", "done"]);
});
test("paste/existing source -> field steps, no run", () => {
  assert.deepEqual(wizardStepIds(auto, "paste"), ["overview", "fields", "done"]);
  assert.deepEqual(wizardStepIds(auto, "existing"), ["overview", "existing", "done"]);
});
test("non-automatic vendor never offers the run step", () => {
  assert.deepEqual(wizardStepIds(manual, "auto"), ["overview", "fields", "done"]); // falls back to paste
});
