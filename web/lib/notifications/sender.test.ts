import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText, sendWebhook, sendZoom, sendTest, resolveWebhookDests, resolveEmailDests } from "./sender";
import { normalizeSettings, parseClientOverride, type NotificationEvent } from "./types";

const ev: NotificationEvent = {
  event: "caseFailed",
  title: "Case failed: UM0028740 (Acme)",
  caseNumber: "UM0028740",
  clientName: "Acme",
  systemKey: "m365",
  detail: "boom",
  url: "https://app/cases/x",
};

// build a channels config with a default + restricted zoom
const cfg = normalizeSettings({
  channels: {
    zoom: { default: { enabled: true, webhookUrl: "https://iam", token: "t1" }, restricted: { enabled: true, webhookUrl: "https://internal", token: "t2" } },
    email: { default: { enabled: true, recipients: ["ops@core.tech"] }, restricted: { enabled: true, recipients: ["sec@core.tech"] } },
  },
}).channels;

test("messageText includes title, client, case, system, detail, url", () => {
  const t = messageText(ev);
  for (const s of ["Case failed", "Acme", "UM0028740", "m365", "boom", "https://app/cases/x"]) assert.match(t, new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("normalizeSettings migrates the OLD flat shape (zoom + zoomRestricted -> zoom.default/restricted)", () => {
  const s = normalizeSettings({
    enabled: true,
    channels: {
      teams: { enabled: true, webhookUrl: "https://teams" }, // old flat -> default
      zoom: { enabled: true, webhookUrl: "https://iam", token: "z" },
      zoomRestricted: { enabled: true, webhookUrl: "https://internal", token: "zr" },
    },
  });
  assert.equal(s.channels.teams.default.webhookUrl, "https://teams");
  assert.equal(s.channels.teams.restricted.webhookUrl, ""); // no old restricted teams
  assert.equal(s.channels.zoom.default.webhookUrl, "https://iam");
  assert.equal(s.channels.zoom.restricted.webhookUrl, "https://internal"); // migrated from zoomRestricted
});

test("resolveWebhookDests: restricted -> restricted dest; non-restricted -> default (no leak)", () => {
  assert.deepEqual(resolveWebhookDests(cfg.zoom, false).map((d) => d.webhookUrl), ["https://iam"]);
  assert.deepEqual(resolveWebhookDests(cfg.zoom, true).map((d) => d.webhookUrl), ["https://internal"]);
});

test("resolveWebhookDests: restricted with no restricted dest sends nowhere (never falls back to default)", () => {
  const c = normalizeSettings({ channels: { zoom: { default: { enabled: true, webhookUrl: "https://iam" }, restricted: { enabled: false, webhookUrl: "" } } } }).channels;
  assert.deepEqual(resolveWebhookDests(c.zoom, true), []);
});

test("resolveWebhookDests: override 'also' adds the CORRECT base; 'only' replaces it", () => {
  const also = resolveWebhookDests(cfg.zoom, false, { mode: "also", webhookUrl: "https://abc", token: "z" });
  assert.deepEqual(also.map((d) => d.webhookUrl), ["https://abc", "https://iam"]);
  const alsoR = resolveWebhookDests(cfg.zoom, true, { mode: "also", webhookUrl: "https://abc" });
  assert.deepEqual(alsoR.map((d) => d.webhookUrl), ["https://abc", "https://internal"]); // restricted base, NOT iam
  assert.ok(!alsoR.some((d) => d.webhookUrl === "https://iam"));
  const only = resolveWebhookDests(cfg.zoom, false, { mode: "only", webhookUrl: "https://xyz" });
  assert.deepEqual(only.map((d) => d.webhookUrl), ["https://xyz"]);
});

test("resolveEmailDests: restricted vs default + also/only", () => {
  assert.deepEqual(resolveEmailDests(cfg.email, false), [["ops@core.tech"]]);
  assert.deepEqual(resolveEmailDests(cfg.email, true), [["sec@core.tech"]]);
  assert.deepEqual(resolveEmailDests(cfg.email, false, { mode: "also", recipients: ["client@x.com"] }), [["client@x.com"], ["ops@core.tech"]]);
  assert.deepEqual(resolveEmailDests(cfg.email, false, { mode: "only", recipients: ["client@x.com"] }), [["client@x.com"]]);
});

test("parseClientOverride: migrates the OLD flat zoom override + reads the NEW per-channel shape", () => {
  assert.deepEqual(parseClientOverride({ webhookUrl: "https://z", token: "t", mode: "only" }), { zoom: { mode: "only", webhookUrl: "https://z", token: "t" } });
  const nw = parseClientOverride({ teams: { webhookUrl: "https://tm", mode: "also" }, email: { recipients: ["a@x.com"], mode: "only" } });
  assert.deepEqual(nw.teams, { mode: "also", webhookUrl: "https://tm", token: "" });
  assert.deepEqual(nw.email, { mode: "only", recipients: ["a@x.com"] });
});

test("sendWebhook posts { text }", async () => {
  const calls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => { calls.push(String(init?.body)); return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
  try {
    assert.equal((await sendWebhook("https://hook", ev)).ok, true);
    assert.match(calls[0], /"text"/);
  } finally { globalThis.fetch = orig; }
});

test("sendZoom sends Authorization token, ?format=message, and a RAW JSON-string body", async () => {
  const cap: { got?: { url: string; headers: Record<string, string>; body: string } } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => { cap.got = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) }; return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
  try {
    assert.equal((await sendZoom("https://z/abc", "VTOKEN", ev)).ok, true);
    assert.match(cap.got!.url, /[?&]format=message/);
    assert.equal(cap.got!.headers.Authorization, "VTOKEN");
    assert.equal(cap.got!.body, JSON.stringify(messageText(ev)));
    assert.doesNotMatch(cap.got!.body, /"text"/);
  } finally { globalThis.fetch = orig; }
});

test("sendTest routes to the right transport per channel", async () => {
  const hits: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { hits.push(String(url)); return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
  try {
    await sendTest("teams", { webhookUrl: "https://teams" }, ev);
    await sendTest("zoom", { webhookUrl: "https://zoom", token: "t" }, ev);
    assert.match(hits[0], /teams/);
    assert.match(hits[1], /zoom.*format=message/);
    const email = await sendTest("email", { recipients: ["x@y.com"] }, ev); // no NOTIFY_GRAPH env
    assert.equal(email.ok, false); // email not configured -> clean failure, not a throw
  } finally { globalThis.fetch = orig; }
});
