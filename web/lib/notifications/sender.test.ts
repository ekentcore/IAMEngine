import { test } from "node:test";
import assert from "node:assert/strict";
import { messageText, sendWebhook, sendZoom, sendTest, resolveWebhookDests, resolveEmailDests, zoomParts } from "./sender";
import { ZOOM_MESSAGE_BUDGET } from "./chunk";
import { normalizeSettings, parseClientOverride, DEFAULT_NOTIFICATIONS, NOTIF_EVENTS, type NotificationEvent } from "./types";

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

test("messageText adds 'Ran by' + a readable UTC 'At' when actor/timestamp are present", () => {
  const t = messageText({ ...ev, actor: "Jane Doe", at: "2026-07-10T14:32:09.000Z" });
  assert.match(t, /Ran by: Jane Doe/);
  assert.match(t, /At: 2026-07-10 14:32 UTC/); // formatted, not a raw ISO string
  assert.doesNotMatch(messageText(ev), /Ran by:/); // omitted when absent
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
  // no-leak for email too: restricted + "also" adds the RESTRICTED base, never the default recipients
  assert.deepEqual(resolveEmailDests(cfg.email, true, { mode: "also", recipients: ["client@x.com"] }), [["client@x.com"], ["sec@core.tech"]]);
  assert.ok(!resolveEmailDests(cfg.email, true, { mode: "also", recipients: ["client@x.com"] }).some((r) => r.includes("ops@core.tech")));
});

test("parseClientOverride: migrates the OLD flat zoom override + reads the NEW per-channel shape", () => {
  assert.deepEqual(parseClientOverride({ webhookUrl: "https://z", token: "t", mode: "only" }), { zoom: { mode: "only", webhookUrl: "https://z", token: "t" } });
  const nw = parseClientOverride({ teams: { webhookUrl: "https://tm", mode: "also" }, email: { recipients: ["a@x.com"], mode: "only" } });
  assert.deepEqual(nw.teams, { mode: "also", webhookUrl: "https://tm", token: "" });
  assert.deepEqual(nw.email, { mode: "only", recipients: ["a@x.com"] });
});

test("stepWarning is a real, operator-toggleable event that defaults ON", () => {
  // A job that SUCCEEDS with a failed validation read-back is a "warning" verdict. Without this event
  // a warning can never reach a chat room, no matter how the channels are configured.
  assert.equal(DEFAULT_NOTIFICATIONS.events.stepWarning, true);
  assert.ok(NOTIF_EVENTS.some((e) => e.key === "stepWarning"), "stepWarning must be toggleable in Settings");
});

test("normalizeSettings trims whitespace around webhook URLs and Zoom tokens", () => {
  // A pasted token/URL routinely carries a leading space; Zoom then rejects the Authorization header.
  const s = normalizeSettings({
    channels: { zoom: { default: { enabled: true, webhookUrl: " https://z/abc ", token: " k7kap69 " }, restricted: {} } },
  });
  assert.equal(s.channels.zoom.default.webhookUrl, "https://z/abc");
  assert.equal(s.channels.zoom.default.token, "k7kap69");
});

test("parseClientOverride trims the client's own webhook URL / token / recipients", () => {
  const ov = parseClientOverride({ zoom: { webhookUrl: " https://client-room ", token: " tok ", mode: "only" }, email: { recipients: [" a@x.com "], mode: "also" } });
  assert.deepEqual(ov.zoom, { mode: "only", webhookUrl: "https://client-room", token: "tok" });
  assert.deepEqual(ov.email, { mode: "also", recipients: ["a@x.com"] });
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

test("sendZoom sends Authorization token, ?format=full, and the structured card (one body segment per line)", async () => {
  const cap: { got?: { url: string; headers: Record<string, string>; body: string } } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => { cap.got = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body) }; return { ok: true, status: 200 } as Response; }) as unknown as typeof fetch;
  try {
    assert.equal((await sendZoom("https://z/abc", "VTOKEN", { ...ev, actor: "Jane Doe" })).ok, true);
    assert.match(cap.got!.url, /[?&]format=full/);
    assert.equal(cap.got!.headers.Authorization, "VTOKEN");
    const payload = JSON.parse(cap.got!.body) as { content: { head: { text: string }; body: { type: string; text: string }[] } };
    assert.equal(payload.content.head.text, ev.title); // title becomes the card header
    const texts = payload.content.body.map((s) => s.text);
    assert.ok(texts.includes("Case: UM0028740")); // each fact is its OWN segment → real line break
    assert.ok(texts.includes("Ran by: Jane Doe"));
    assert.ok(texts.includes("boom"));
    assert.ok(payload.content.body.every((s) => s.type === "message"));
    assert.doesNotMatch(cap.got!.body, /\\n/); // no literal "\n" — lines are separate segments
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
    assert.match(hits[1], /zoom.*format=full/);
    const email = await sendTest("email", { recipients: ["x@y.com"] }, ev); // no NOTIFY_GRAPH env
    assert.equal(email.ok, false); // email not configured -> clean failure, not a throw
  } finally { globalThis.fetch = orig; }
});

// ── The Zoom over-length guard ──────────────────────────────────────────────
// Zoom silently cuts a message over its cap (really 4000, budgeted 3800 UTF-8 bytes — see chunk.ts),
// and until now only the fleet report pre-chunked; any OTHER long message lost its tail in the room.
// Every Zoom send is now guarded: over-budget messages split into sequential "(x of y)" parts.

test("zoomParts: a message within budget is one part with the plain title — no (x of y)", () => {
  const parts = zoomParts({ event: "announcement", title: "Short note", detail: "line 1\nline 2" });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].head, "Short note");
  assert.ok(!/\(\d+ of \d+\)/.test(parts[0].head));
  assert.deepEqual(parts[0].lines, ["line 1", "line 2"]);
});

test("zoomParts: an over-budget message splits into (x of y) parts that each fit, losing no line", () => {
  const lines = Array.from({ length: 220 }, (_, i) => `row ${String(i).padStart(3, "0")} — ${"x".repeat(40)} · end`);
  const parts = zoomParts({ event: "announcement", title: "Big report", detail: lines.join("\n") });
  assert.ok(parts.length > 1, "an ~11k-byte message must split");
  for (const [i, p] of parts.entries()) {
    assert.equal(p.head, `Big report (${i + 1} of ${parts.length})`);
    const rendered = [p.head, ...p.lines].join("\n");
    assert.ok(new TextEncoder().encode(rendered).length <= ZOOM_MESSAGE_BUDGET, `part ${i + 1} over budget`);
  }
  assert.deepEqual(parts.flatMap((p) => p.lines), lines, "no line may be lost or reordered");
});

test("zoomParts: a title-only event over budget is hard-cut, never dropped", () => {
  const parts = zoomParts({ event: "announcement", title: `T ${"y".repeat(5000)}` });
  assert.equal(parts.length, 1, "nothing to paginate — but it must still send");
  assert.ok(new TextEncoder().encode(parts[0].head).length <= ZOOM_MESSAGE_BUDGET);
});

test("sendZoom posts every part in order and reports a failed part", async () => {
  const bodies: string[] = [];
  let call = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    call++;
    return { ok: call !== 2, status: call === 2 ? 500 : 200 } as Response; // part 2 fails
  }) as unknown as typeof fetch;
  try {
    const lines = Array.from({ length: 220 }, (_, i) => `row ${i} ${"z".repeat(40)}`);
    const res = await sendZoom("https://hooks.zoom.us/x", "tok", { event: "announcement", title: "Big", detail: lines.join("\n") });
    assert.ok(bodies.length > 2, "every part must still be attempted");
    const heads = bodies.map((b) => (JSON.parse(b) as { content: { head: { text: string } } }).content.head.text);
    assert.equal(heads[0], `Big (1 of ${bodies.length})`);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /part 2\//);
  } finally { globalThis.fetch = orig; }
});
