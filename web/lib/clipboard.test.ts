// The property that matters here is not "does it copy" — it's "does it tell the truth about whether
// it copied". Every call site was reporting success unconditionally, over a clipboard the browser had
// never let it write to, and three of those sites copy a one-time-shown password.
import test from "node:test";
import assert from "node:assert/strict";
import { copyText, copyFailureHint } from "./clipboard";

// Minimal DOM stand-ins. The real thing isn't available under `tsx --test`, and the logic under test
// is the DECISION (which path, what to return), not the browser's copy implementation.
type Env = {
  clipboard?: { writeText: (t: string) => Promise<void> };
  execCommand?: (cmd: string) => boolean;
  secure?: boolean;
};
function withDom(env: Env, run: () => Promise<void> | void) {
  const g = globalThis as Record<string, unknown>;
  // defineProperty, not assignment: `globalThis.navigator` is an accessor with no setter in modern
  // Node, so `g.navigator = ...` throws outright.
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(g, "navigator"),
    document: Object.getOwnPropertyDescriptor(g, "document"),
    window: Object.getOwnPropertyDescriptor(g, "window"),
  };
  const set = (k: string, v: unknown) =>
    Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  const appended: unknown[] = [];
  set("navigator", env.clipboard ? { clipboard: env.clipboard } : {});
  set("document", {
    createElement: () => ({
      value: "",
      style: {} as Record<string, string>,
      setAttribute: () => {},
      select: () => {},
      setSelectionRange: () => {},
      focus: () => {},
    }),
    body: { appendChild: (n: unknown) => appended.push(n), removeChild: () => {} },
    getSelection: () => null,
    activeElement: null,
    execCommand: env.execCommand ?? (() => false),
  });
  set("window", { isSecureContext: env.secure ?? true });
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  };
  try {
    const out = run();
    // Async tests must not restore the globals until they've actually finished.
    return out instanceof Promise ? out.finally(restore) : (restore(), out);
  } catch (e) {
    restore();
    throw e;
  }
}

test("returns true when the async clipboard API accepts the write", async () => {
  let written = "";
  await withDom({ clipboard: { writeText: async (t) => { written = t; } } }, async () => {
    assert.equal(await copyText("hello"), true);
    assert.equal(written, "hello");
  });
});

test("insecure origin (no navigator.clipboard at all) falls back and still copies", async () => {
  // This is the reported bug: on http://<lan-ip>:3000 the API is undefined for every client except
  // the host. Before, `navigator.clipboard?.writeText(...)` no-opped and the UI claimed success.
  let called = "";
  await withDom({ execCommand: (cmd) => { called = cmd; return true; }, secure: false }, async () => {
    assert.equal(await copyText("from a LAN client"), true);
    assert.equal(called, "copy");
  });
});

test("returns FALSE when there is no clipboard API and the fallback fails", async () => {
  // The whole point: a caller must be able to tell it failed, so it can stop saying "Copied ✓".
  await withDom({ execCommand: () => false, secure: false }, async () => {
    assert.equal(await copyText("nope"), false);
  });
});

test("a rejected async write falls back rather than failing outright", async () => {
  // Safari rejects writes it decides are too far from the user gesture; execCommand often still works.
  let fellBack = false;
  await withDom(
    { clipboard: { writeText: async () => { throw new Error("NotAllowedError"); } }, execCommand: () => { fellBack = true; return true; } },
    async () => {
      assert.equal(await copyText("x"), true);
      assert.equal(fellBack, true);
    },
  );
});

test("returns false when both paths fail", async () => {
  await withDom(
    { clipboard: { writeText: async () => { throw new Error("blocked"); } }, execCommand: () => false },
    async () => { assert.equal(await copyText("x"), false); },
  );
});

test("execCommand throwing is a failure, not an exception", async () => {
  await withDom({ execCommand: () => { throw new Error("boom"); }, secure: false }, async () => {
    assert.equal(await copyText("x"), false);
  });
});

test("the hint names HTTP only when the page really is insecure", () => {
  withDom({ secure: false }, () => {
    assert.match(copyFailureHint(), /plain HTTP/);
  });
  withDom({ secure: true }, () => {
    // On an https page the cause is something else — saying "it's HTTP" would send them somewhere wrong.
    assert.doesNotMatch(copyFailureHint(), /plain HTTP/);
    assert.match(copyFailureHint(), /blocked the clipboard/);
  });
});
