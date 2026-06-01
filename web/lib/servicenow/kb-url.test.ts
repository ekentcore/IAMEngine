import { test } from "node:test";
import assert from "node:assert/strict";
import { kbUrl } from "@/lib/servicenow/kb-url";

test("kbUrl builds the article link", () => {
  assert.equal(
    kbUrl("https://acme.service-now.com", "KB0037439"),
    "https://acme.service-now.com/kb_view.do?sysparm_article=KB0037439"
  );
});

test("kbUrl trims a trailing slash on the instance url", () => {
  assert.equal(
    kbUrl("https://acme.service-now.com/", "KB1"),
    "https://acme.service-now.com/kb_view.do?sysparm_article=KB1"
  );
});

test("kbUrl returns null when the instance url or number is missing", () => {
  assert.equal(kbUrl(undefined, "KB1"), null);
  assert.equal(kbUrl("https://acme.service-now.com", null), null);
  assert.equal(kbUrl("", "KB1"), null);
});
