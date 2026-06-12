import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUnknownsWithAI } from "./ai-resolve";

// The resolver calls azureChatJson via lib/generator/llm, which no-ops without AZURE_* env. These
// tests exercise the deterministic branches (no-config / no-unknowns) without a live LLM. The
// confident-fill path is covered by the planning-service integration with a real tenant.

test("no unknowns -> returns the payload unchanged, nothing resolved", async () => {
  const payload = { firstName: "A", usageLocation: "US", unknownFields: [] };
  const r = await resolveUnknownsWithAI(payload);
  assert.deepEqual(r.resolved, []);
  assert.equal(r.payload, payload);
});

test("unknowns but Azure not configured -> no-op (case still holds)", async () => {
  const orig = { tenant: process.env.AZURE_OPENAI_ENDPOINT, key: process.env.AZURE_OPENAI_KEY, az1: process.env.AZUREAI_BASE, az2: process.env.AZUREAI_API };
  delete process.env.AZURE_OPENAI_ENDPOINT; delete process.env.AZURE_OPENAI_KEY;
  delete process.env.AZUREAI_BASE; delete process.env.AZUREAI_API;
  try {
    const payload = { officeLocation: "Mars", unknownFields: [{ field: "usageLocation", label: "Usage location", note: "?" }] };
    const r = await resolveUnknownsWithAI(payload);
    assert.deepEqual(r.resolved, []);
    assert.equal((r.payload.unknownFields as unknown[]).length, 1); // still unknown -> still holds
  } finally {
    if (orig.tenant) process.env.AZURE_OPENAI_ENDPOINT = orig.tenant;
    if (orig.key) process.env.AZURE_OPENAI_KEY = orig.key;
    if (orig.az1) process.env.AZUREAI_BASE = orig.az1;
    if (orig.az2) process.env.AZUREAI_API = orig.az2;
  }
});
