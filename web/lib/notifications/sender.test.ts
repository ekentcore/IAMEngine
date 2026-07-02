import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText, sendWebhook, sendZoom, sendToChannels, resolveZoomTargets } from "./sender";
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
  // container object avoids TS narrowing a closure-written `let` to `never`
  const cap: { got?: { url: string; headers: Record<string, string>; body: string } } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    cap.got = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) };
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  try {
    const r = await sendZoom("https://integrations.zoom.us/chat/webhooks/incomingwebhook/abc", "VTOKEN123", ev);
    assert.equal(r.ok, true);
    assert.ok(cap.got);
    assert.match(cap.got.url, /[?&]format=message/); // format param appended
    assert.equal(cap.got.headers.Authorization, "VTOKEN123"); // verification token
    assert.equal(cap.got.body, JSON.stringify(messageText(ev))); // RAW JSON string, not { text }
    assert.doesNotMatch(cap.got.body, /"text"/);
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

test("resolveZoomTargets: restricted client routes to the restricted channel (no leak to default)", () => {
  const ch = normalizeSettings({
    channels: {
      zoom: { enabled: true, webhookUrl: "https://iam", token: "t1" },
      zoomRestricted: { enabled: true, webhookUrl: "https://internal", token: "t2" },
    },
  } as never).channels;
  assert.deepEqual(resolveZoomTargets(ch, { ...ev, restricted: false }).map((t) => t.webhookUrl), ["https://iam"]);
  assert.deepEqual(resolveZoomTargets(ch, { ...ev, restricted: true }).map((t) => t.webhookUrl), ["https://internal"]);
});

test("resolveZoomTargets: restricted with NO restricted channel sends nowhere (never falls back to default)", () => {
  const ch = normalizeSettings({ channels: { zoom: { enabled: true, webhookUrl: "https://iam", token: "t1" } } } as never).channels;
  assert.deepEqual(resolveZoomTargets(ch, { ...ev, restricted: true }), []);
});

test("resolveZoomTargets: per-client override 'also' hits override + base; 'only' hits override alone", () => {
  const ch = normalizeSettings({ channels: { zoom: { enabled: true, webhookUrl: "https://iam", token: "t1" } } } as never).channels;
  const also = resolveZoomTargets(ch, { ...ev, restricted: false, zoomOverride: { webhookUrl: "https://abc", token: "z", mode: "also" } });
  assert.deepEqual(also.map((t) => t.webhookUrl), ["https://abc", "https://iam"]);
  const only = resolveZoomTargets(ch, { ...ev, restricted: false, zoomOverride: { webhookUrl: "https://xyz", token: "z", mode: "only" } });
  assert.deepEqual(only.map((t) => t.webhookUrl), ["https://xyz"]);
});

test("resolveZoomTargets: de-dups when the override URL equals the base", () => {
  const ch = normalizeSettings({ channels: { zoom: { enabled: true, webhookUrl: "https://iam", token: "t1" } } } as never).channels;
  const r = resolveZoomTargets(ch, { ...ev, zoomOverride: { webhookUrl: "https://iam", token: "z", mode: "also" } });
  assert.deepEqual(r.map((t) => t.webhookUrl), ["https://iam"]);
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
