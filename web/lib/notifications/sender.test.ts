import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText, sendWebhook, sendZoom, sendToChannels } from "./sender";
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

test("sendZoom sends the Authorization token, ?format=message, and a raw JSON-string body", async () => {
  let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) };
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  try {
    const r = await sendZoom("https://integrations.zoom.us/chat/webhooks/incomingwebhook/abc", "VTOKEN123", ev);
    assert.equal(r.ok, true);
    assert.ok(captured);
    assert.match(captured!.url, /[?&]format=message/); // format param appended
    assert.equal(captured!.headers.Authorization, "VTOKEN123"); // verification token
    assert.equal(captured!.body, JSON.stringify(messageText(ev))); // RAW JSON string, not { text }
    assert.doesNotMatch(captured!.body, /"text"/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("sendZoom reports a helpful error when the token is missing", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 400 }) as Response) as unknown as typeof fetch;
  try {
    const r = await sendZoom("https://z", "", ev);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /verification token/);
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
