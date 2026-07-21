import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActor, auditActor, isAutomationOnBehalf } from "./actor";

test("resolveActor pulls the userId out of an AuditActor (so on-behalf attribution survives)", () => {
  assert.deepEqual(resolveActor({ label: "agent:abc", userId: "u1" }), { actor: "agent:abc", userId: "u1" });
  assert.deepEqual(resolveActor("system:auto"), { actor: "system:auto", userId: null }); // a bare string carries no user
  assert.deepEqual(resolveActor(null), { actor: "ui", userId: null });
});

test("auditActor: a real user carries id + user: label; a system caller falls back with no id", () => {
  assert.deepEqual(auditActor({ id: "u1", email: "jane@core.tech" }, "ui"), { label: "user:jane@core.tech", userId: "u1" });
  assert.deepEqual(auditActor({ id: "s", email: "system", system: true }, "system:sweep"), { label: "system:sweep", userId: null });
  assert.deepEqual(auditActor(null, "ui"), { label: "ui", userId: null });
});

test("isAutomationOnBehalf: known user + a runner/system actor label = automation the user kicked off", () => {
  assert.equal(isAutomationOnBehalf("agent:abc", true), true);       // runner did it for the user
  assert.equal(isAutomationOnBehalf("system:m365-setup", true), true);
  assert.equal(isAutomationOnBehalf("user:jane@core.tech", true), false); // a direct user action
  assert.equal(isAutomationOnBehalf("agent:abc", false), false);     // no user known -> pure automation, not "(Automation)"
});
