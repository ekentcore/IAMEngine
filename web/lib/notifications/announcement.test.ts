import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sendAnnouncement } from "./sender";
import { normalizeSettings, type NotificationSettings } from "./types";

// Capture every webhook POST the announcement fan-out makes (URL + parsed body).
let posts: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  posts = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

function settings(over?: Partial<NotificationSettings["channels"]>): NotificationSettings {
  return normalizeSettings({
    enabled: false, // master switch OFF — announcements are manual and must send anyway
    channels: {
      teams: { default: { enabled: true, webhookUrl: "https://teams/default" }, restricted: { enabled: true, webhookUrl: "https://teams/restricted" } },
      slack: { default: { enabled: true, webhookUrl: "https://slack/default" }, restricted: { enabled: false, webhookUrl: "https://slack/restricted" } },
      zoom: { default: { enabled: false, webhookUrl: "" }, restricted: { enabled: false, webhookUrl: "" } },
      email: { default: { enabled: false, recipients: [] }, restricted: { enabled: false, recipients: [] } },
      ...over,
    },
  });
}

const EVENT = { event: "announcement" as const, title: "iam-engine update — test", detail: "Comment\n\n• built a thing" };

test("audience 'all' sends to each channel's default destination only", async () => {
  const results = await sendAnnouncement(settings(), "all", EVENT);
  assert.deepEqual(posts.map((p) => p.url).sort(), ["https://slack/default", "https://teams/default"]);
  assert.equal(results.every((r) => r.ok), true);
  // Body carries the composed text (title first, then the detail lines).
  assert.match(String(posts[0].body.text), /^iam-engine update — test\n/);
  assert.match(String(posts[0].body.text), /• built a thing/);
});

test("audience 'restricted' sends to enabled restricted destinations only", async () => {
  await sendAnnouncement(settings(), "restricted", EVENT);
  // slack restricted is disabled -> teams restricted only.
  assert.deepEqual(posts.map((p) => p.url), ["https://teams/restricted"]);
});

test("audience 'both' sends to both sides, de-duplicated when a pair shares one webhook", async () => {
  const s = settings({
    teams: { default: { enabled: true, webhookUrl: "https://teams/shared" }, restricted: { enabled: true, webhookUrl: "https://teams/shared" } },
  });
  await sendAnnouncement(s, "both", EVENT);
  assert.deepEqual(posts.map((p) => p.url).sort(), ["https://slack/default", "https://teams/shared"]);
});

test("no configured destinations -> empty results, no requests", async () => {
  const s = normalizeSettings({ enabled: true, channels: {} });
  const results = await sendAnnouncement(s, "both", EVENT);
  assert.equal(results.length, 0);
  assert.equal(posts.length, 0);
});
