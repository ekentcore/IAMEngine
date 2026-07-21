import { test } from "node:test";
import assert from "node:assert/strict";
import { planCase } from "./orchestrator";
import type { ClientSystem } from "@prisma/client";

function sys(systemKey: string, over: Partial<ClientSystem> = {}): ClientSystem {
  return {
    id: `id-${systemKey}`,
    clientId: "c1",
    systemKey,
    mode: "api",
    onboardWhen: "always",
    offboardWhen: "never",
    dependsOn: [],
    requiresApproval: false,
    captureEvidence: false,
    secretNames: [],
    config: null,
    ...over,
  } as unknown as ClientSystem;
}

const systems = [
  sys("active-directory"),
  sys("directory-sync"),
  sys("entra"),
  sys("m365"),
  sys("exchange"),
];

test("skipSystems drops the named lanes and the synthetic AD steps", () => {
  const planned = planCase(systems, "onboard", {}, undefined, undefined, undefined,
    new Set(["active-directory", "directory-sync"]));
  const keys = planned.map((j) => j.systemKey);
  assert.ok(!keys.includes("active-directory"));
  assert.ok(!keys.includes("directory-sync"));
  assert.ok(!keys.includes("ad-email-writeback"));
  assert.ok(!keys.includes("ad-consistency-check"));
  assert.ok(keys.includes("entra"));
  assert.ok(keys.includes("m365"));
  assert.ok(keys.includes("exchange"));
});

test("without skipSystems the AD lanes and synthetic steps are present", () => {
  const keys = planCase(systems, "onboard", {}).map((j) => j.systemKey);
  assert.ok(keys.includes("active-directory"));
  assert.ok(keys.includes("ad-email-writeback"));
});
