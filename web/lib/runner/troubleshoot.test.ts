import { test } from "node:test";
import assert from "node:assert/strict";
import { troubleshootScript } from "./troubleshoot";

const APP = "https://iam.example.com";
const AGENT = "cku1234567890abcdef";

test("bakes the app url and agent id into the script", () => {
  const s = troubleshootScript(APP, AGENT);
  assert.ok(s.includes(`'${APP}'`));
  assert.ok(s.includes(`'${AGENT}'`));
});

test("auth probe never uses the real agent id (must not consume a queued update)", () => {
  const s = troubleshootScript(APP, AGENT);
  const probeLine = s.split("\n").find((l) => l.includes("/api/agents/heartbeat"));
  assert.ok(probeLine, "script probes the heartbeat endpoint");
  assert.ok(!probeLine!.includes(AGENT), "heartbeat probe must use a fake agent id");
  assert.ok(s.includes("troubleshoot-probe"));
});

test("foreground run passes the real agent id and the machine token", () => {
  const s = troubleshootScript(APP, AGENT);
  const runLine = s.split("\n").find((l) => l.includes("Start-IamRunner.ps1") && l.includes("-AgentId"));
  assert.ok(runLine, "script offers a foreground run");
  assert.ok(runLine!.includes("-ApiToken"));
});

test("single quotes in inputs cannot break out of the PS string literal", () => {
  const s = troubleshootScript("https://x'; Remove-Item /", "id'; bad");
  // In a PS single-quoted literal '' is a literal quote — the whole input must stay inside one string.
  assert.ok(s.includes("$App = 'https://x''; Remove-Item /'"));
  assert.ok(s.includes("$AgentId = 'id''; bad'"));
});
