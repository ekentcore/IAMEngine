import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunbook } from "@/lib/runbook/build";
import type { ClientSystemWithCatalog } from "@/lib/clients/types";
import type { Lifecycle, Mode } from "@prisma/client";

type Opts = {
  key: string;
  seq: number;
  mode?: Mode;
  onboardWhen?: Lifecycle;
  offboardWhen?: Lifecycle;
  dependsOn?: string[];
  config?: unknown;
};

function sys(o: Opts): ClientSystemWithCatalog {
  return {
    id: o.key,
    clientId: "c1",
    systemKey: o.key,
    seq: o.seq,
    mode: o.mode ?? "api",
    onboardWhen: o.onboardWhen ?? "always",
    offboardWhen: o.offboardWhen ?? "always",
    dependsOn: o.dependsOn ?? [],
    requiresApproval: false,
    captureEvidence: false,
    secretNames: [],
    config: o.config ?? null,
    system: { key: o.key, name: o.key, defaultMode: "api", supportsOnboard: true, supportsOffboard: true, moduleName: null, buildTier: 1 },
  } as unknown as ClientSystemWithCatalog;
}

test("orders by dependsOn regardless of seq, numbering 1-based", () => {
  // declared out of dependency order; topo-sort must fix it
  const systems = [
    sys({ key: "m365", seq: 0, dependsOn: ["directory-sync"] }),
    sys({ key: "directory-sync", seq: 1, dependsOn: ["active-directory"] }),
    sys({ key: "active-directory", seq: 2, dependsOn: ["servicenow"] }),
    sys({ key: "servicenow", seq: 3 }),
  ];
  const items = buildRunbook(systems, "onboard");
  assert.deepEqual(
    items.map((i) => i.systemKey),
    ["servicenow", "active-directory", "directory-sync", "m365"]
  );
  assert.deepEqual(items.map((i) => i.stepNumber), [1, 2, 3, 4]);
  // dep badge filtered to in-action systems
  assert.deepEqual(items.find((i) => i.systemKey === "m365")!.dependsOn, ["directory-sync"]);
});

test("excludes never, includes + badges on_request, flags manual as human", () => {
  const systems = [
    sys({ key: "servicenow", seq: 0 }),
    sys({ key: "teams", seq: 1, onboardWhen: "on_request" }),
    sys({ key: "welcome-letter", seq: 2, mode: "manual" }),
    sys({ key: "exchange", seq: 3, onboardWhen: "never" }),
  ];
  const items = buildRunbook(systems, "onboard");
  const keys = items.map((i) => i.systemKey);
  assert.ok(!keys.includes("exchange"), "never lane excluded");
  assert.equal(items.find((i) => i.systemKey === "teams")!.when, "on_request");
  const welcome = items.find((i) => i.systemKey === "welcome-letter")!;
  assert.equal(welcome.automated, false);
});

test("summarizes m365 licenses/groups into human lines", () => {
  const systems = [
    sys({ key: "m365", seq: 0, config: { onboard: { licenses: ["E3", "E5"], groups: ["G1"] } } }),
  ];
  const [item] = buildRunbook(systems, "onboard");
  assert.ok(item.steps.some((s) => s.includes("Assign 2 license(s)")));
  assert.ok(item.steps.some((s) => s.includes("Add to group(s): G1")));
});
