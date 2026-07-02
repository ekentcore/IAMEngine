import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText, sendWebhook, sendToChannels } from "./sender";
import { normalizeSettings, type NotificationEvent } from "./types";

const ev: NotificationEvent = {
  event: "caseFailed",
  title: "Case failed: UM0028740 (Acme)",
  caseNumber: "UM0028740",
  clientName: "Acme",
  systemKey: "m365",
  detail: "boom",
  url: "https://app/cases/x",
};

test("messageText includes title, client, case, system, detail, url", () => {
  const t = messageText(ev);
  for (const s of ["Case failed", "Acme", "UM0028740", "m365", "boom", "https://app/cases/x"]) {
    assert.match(t, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("normalizeSettings fills defaults from a partial blob", () => {
  const s = normalizeSettings({ enabled: true, channels: { teams: { enabled: true, webhookUrl: "u" } } } as never);
  assert.equal(s.enabled, true);
  assert.equal(s.channels.teams.enabled, true);
  assert.equal(s.channels.slack.enabled, false); // filled from default
  assert.deepEqual(s.channels.email.recipients, []);
  assert.equal(s.events.caseFailed, true); // default event set
});

test("sendWebhook posts { text } and reports ok/!ok", async () => {
  const calls: { url: string; body: string }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  try {
    const r = await sendWebhook("https://hook", ev);
    assert.equal(r.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /"text"/);
    assert.match(calls[0].body, /UM0028740/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("sendToChannels only hits ENABLED channels with a url", async () => {
  const hit: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    hit.push(String(url));
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  try {
    const settings = normalizeSettings({
      enabled: true,
      channels: {
        teams: { enabled: true, webhookUrl: "https://teams" },
        slack: { enabled: false, webhookUrl: "https://slack" }, // disabled -> skipped
        zoom: { enabled: true, webhookUrl: "" }, // no url -> skipped
      },
    } as never);
    const results = await sendToChannels(settings, ev);
    assert.equal(results.length, 1);
    assert.equal(results[0].channel, "teams");
    assert.deepEqual(hit, ["https://teams"]);
  } finally {
    globalThis.fetch = orig;
  }
});
