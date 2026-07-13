import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRunbookAI } from "./runbook-extract";

// azureChatJson is driven through global fetch — stub it to return a fixed sections payload.
function withAzure(content: unknown, fn: () => Promise<void>) {
  return async () => {
    const env = process.env;
    const saved = { AZUREAI_BASE: env.AZUREAI_BASE, AZUREAI_API: env.AZUREAI_API, AZUREAI_DEPLOYMENT: env.AZUREAI_DEPLOYMENT };
    Object.assign(env, { AZUREAI_BASE: "https://x", AZUREAI_API: "k", AZUREAI_DEPLOYMENT: "d" });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) }) as Response) as typeof fetch;
    try { await fn(); } finally {
      globalThis.fetch = original;
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; }
    }
  };
}

test("drops a near-miss systemKey the section never names (Dashlane is not 1password)", withAzure(
  { sections: [{ title: "Dashlane", systemKey: "1password", steps: ["Invite user to Dashlane through the admin console."] }] },
  async () => {
    const out = await extractRunbookAI("Dashlane\n- Invite user", "onboard");
    assert.equal(out![0].systemKey, null);
    assert.equal(out![0].status, "unmodeled");
  }
));

test("keeps a model mapping the steps substantiate even when the title does not", withAzure(
  { sections: [{ title: "Email security", systemKey: "mimecast", steps: ["Login to the Mimecast Admin Console."] }] },
  async () => {
    const out = await extractRunbookAI("Email security\n- Login to the Mimecast Admin Console.", "onboard");
    assert.equal(out![0].systemKey, "mimecast");
  }
));

test("header rules override a model mapping that contradicts the title", withAzure(
  { sections: [{ title: "KnowBe4", systemKey: "zoom", steps: ["Add the user to the DCG Users group."] }] },
  async () => {
    const out = await extractRunbookAI("KnowBe4\n- Add user", "onboard");
    assert.equal(out![0].systemKey, "knowbe4");
  }
));

test("retries once when the extract returns far fewer sections than the heuristic sees", async () => {
  const env = process.env;
  const saved = { AZUREAI_BASE: env.AZUREAI_BASE, AZUREAI_API: env.AZUREAI_API, AZUREAI_DEPLOYMENT: env.AZUREAI_DEPLOYMENT };
  Object.assign(env, { AZUREAI_BASE: "https://x", AZUREAI_API: "k", AZUREAI_DEPLOYMENT: "d" });
  const original = globalThis.fetch;
  // heuristic sees 6 sections (TOC-declared); first AI answer has 2, second has 6
  const text = ["Table of Contents", "- A1", "- A2", "- A3", "- A4", "- A5", "- A6", "",
    ...["A1", "A2", "A3", "A4", "A5", "A6"].flatMap((t) => [t, "- do the thing", ""])].join("\n");
  const small = { sections: [{ title: "A1", systemKey: null, steps: ["x"] }, { title: "A2", systemKey: null, steps: ["x"] }] };
  const full = { sections: ["A1", "A2", "A3", "A4", "A5", "A6"].map((t) => ({ title: t, systemKey: null, steps: ["do the thing"] })) };
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const content = JSON.stringify(calls === 1 ? small : full);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
  }) as typeof fetch;
  try {
    const out = await extractRunbookAI(text, "onboard");
    assert.equal(calls, 2, "must retry once");
    assert.equal(out!.length, 6, "keeps the richer answer");
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; }
  }
});

test("does not retry when the extract is in line with the heuristic", async () => {
  const env = process.env;
  const saved = { AZUREAI_BASE: env.AZUREAI_BASE, AZUREAI_API: env.AZUREAI_API, AZUREAI_DEPLOYMENT: env.AZUREAI_DEPLOYMENT };
  Object.assign(env, { AZUREAI_BASE: "https://x", AZUREAI_API: "k", AZUREAI_DEPLOYMENT: "d" });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const content = JSON.stringify({ sections: [{ title: "Mimecast", systemKey: "mimecast", steps: ["sync"] }] });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
  }) as typeof fetch;
  try {
    const out = await extractRunbookAI("Mimecast\n- sync", "onboard");
    assert.equal(calls, 1);
    assert.equal(out!.length, 1);
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete env[k]; else env[k] = v; }
  }
});
