"use client";

// Playwright codegen paste for browser connectors. Run `npx playwright codegen <portal>`, do the task
// once, paste the generated script here; we parse it into declarative steps (pure client-side — the
// parser is a plain function) and assemble a starter browser definition into the editor. The author
// then adds {{templates}} (e.g. {{secret.username}}, {{user.email}}), marks the password step secret,
// and inserts a totp step if there's MFA.
import { useState } from "react";
import { importCodegen } from "@/lib/connectors/import-codegen";

export function CodegenImport({ onApply, currentJson }: { onApply: (def: unknown) => void; currentJson: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const build = () => {
    setErr(null); setInfo(null);
    const r = importCodegen(text);
    if (r.steps.length === 0) { setErr("no recognizable Playwright steps found — paste the script from `npx playwright codegen`"); return; }
    // Preserve an existing startUrl/credentials block if the author already set one.
    let startUrl = r.startUrl ?? "https://portal.vendor.com/login";
    let credentials: unknown = { secretName: "custom-vendor-portal" };
    try {
      const cur = JSON.parse(currentJson);
      if (cur?.startUrl) startUrl = cur.startUrl;
      if (cur?.credentials) credentials = cur.credentials;
    } catch { /* ignore */ }
    const def = {
      version: 1,
      kind: "browser",
      startUrl,
      credentials,
      lanes: { offboard: r.steps.filter((s) => s.type !== "goto" || s.url) },
    };
    onApply(def);
    const notes: string[] = [`${r.steps.length} step(s) imported into the offboard lane`];
    if (r.unrecognized.length) notes.push(`${r.unrecognized.length} line(s) could not be parsed — check the JSON`);
    notes.push("Now: add {{secret.username}}/{{secret.password}} to the login fills, mark the password step \"secret\": true, add a totp step if there's MFA, and template the user fields.");
    setInfo(notes.join(" · "));
    setOpen(false);
  };

  return (
    <div style={{ border: "1px dashed var(--line)", borderRadius: 8, padding: "0.6rem 0.8rem", margin: "0.5rem 0" }}>
      <button type="button" onClick={() => setOpen((v) => !v)}>{open ? "Hide codegen paste" : "Import from Playwright codegen"}</button>
      {open && (
        <div style={{ marginTop: "0.5rem" }}>
          <p className="note" style={{ marginTop: 0 }}>
            Run <code>npx playwright codegen https://your-portal</code>, perform the task once, then paste the generated script.
          </p>
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="mono"
            placeholder="await page.goto('https://portal…');  await page.getByLabel('Email').fill('…');  …"
            style={{ width: "100%", minHeight: 160, fontSize: "0.78rem" }} />
          {err && <p style={{ color: "var(--err, #b91c1c)" }}>{err}</p>}
          <button type="button" onClick={build} style={{ marginTop: "0.4rem" }}>Build steps from script</button>
        </div>
      )}
      {info && <p className="note">{info}</p>}
    </div>
  );
}
