"use client";

// Paste or type a runbook for a client with no ServiceNow KB (e.g. Coretelligent — process lives in
// an internal script). The text is parsed into ordered sections + steps; section headers that match a
// known system (Active Directory, Microsoft 365, Exchange…) get wired to that system automatically.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { COMMON_LICENSES, COMMON_USERNAME_PATTERNS } from "@/lib/m365/license-catalog";
import { headerToSystemKey } from "@/lib/generator/system-map";

type Section = { seq: number; systemKey: string | null; title: string; status: string; steps: string[] };

type KbRef = { number: string; action: "onboard" | "offboard" };

// Compact ▲▼ reorder control used on sections and steps in the preview.
function Arrows({ up, down, disUp, disDown, title }: { up: () => void; down: () => void; disUp: boolean; disDown: boolean; title: string }) {
  const btn: React.CSSProperties = { padding: "0 4px", fontSize: 10, lineHeight: 1.1, minWidth: 0 };
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", marginRight: 2 }}>
      <button type="button" style={btn} disabled={disUp} title={`Move ${title} up`} onClick={up}>▲</button>
      <button type="button" style={btn} disabled={disDown} title={`Move ${title} down`} onClick={down}>▼</button>
    </span>
  );
}

export function RunbookEditor({ slug, kbArticles = [], current }: { slug: string; kbArticles?: KbRef[]; current?: { onboard: Section[]; offboard: Section[] } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<"onboard" | "offboard">("onboard");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<Section[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<{ number: string; title: string; text: string }[] | null>(null);
  const [useAI, setUseAI] = useState(true);
  const [usedAI, setUsedAI] = useState(false);
  // The action this content was fetched/detected as — auto-selected, and the basis for the
  // override warning so a KB isn't accidentally saved to the wrong action's runbook.
  const [detectedAction, setDetectedAction] = useState<"onboard" | "offboard" | null>(null);
  // The source KB number for the loaded content (from a fetch or import) — stamped onto the saved
  // sections so the KB association (and its Fetch button) survives the re-save.
  const [kbNumber, setKbNumber] = useState<string | null>(null);

  async function call(persist: boolean, overrideText?: string, overrideAction?: "onboard" | "offboard") {
    const t = overrideText ?? text;
    const a = overrideAction ?? action;
    setBusy(true); setError(null);
    const r = await fetch(`/api/clients/${slug}/runbook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: a, text: t, preview: !persist, useAI, kbArticle: kbNumber ?? undefined }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
    setUsedAI(Boolean(d.usedAI));
    if (persist) { setOpen(false); setPreview(null); router.refresh(); }
    else setPreview(d.sections ?? []);
  }

  // Persist the (possibly reordered) previewed sections directly — so reordering survives save
  // instead of being lost to a re-parse of the stale text.
  async function saveEdited() {
    if (!preview) return call(true);
    setBusy(true); setError(null);
    const r = await fetch(`/api/clients/${slug}/runbook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, sections: preview, kbArticle: kbNumber ?? undefined }),
    });
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
    setOpen(false); setPreview(null); router.refresh();
  }

  // Reorder controls operate on the previewed sections (by index).
  function moveSection(i: number, dir: -1 | 1) {
    setPreview((p) => {
      if (!p) return p;
      const j = i + dir; if (j < 0 || j >= p.length) return p;
      const next = [...p]; [next[i], next[j]] = [next[j], next[i]];
      return next.map((s, k) => ({ ...s, seq: k }));
    });
  }
  function moveStep(si: number, ti: number, dir: -1 | 1) {
    setPreview((p) => {
      if (!p) return p;
      const steps = [...p[si].steps]; const tj = ti + dir;
      if (tj < 0 || tj >= steps.length) return p;
      [steps[ti], steps[tj]] = [steps[tj], steps[ti]];
      const next = [...p]; next[si] = { ...next[si], steps };
      return next;
    });
  }
  // Inline edits to the previewed sections — fix a wrong username/license line, drop a step, add one,
  // or rename a section. Saved verbatim by saveEdited (blank steps are dropped server-side).
  function editStep(si: number, ti: number, value: string) {
    setPreview((p) => { if (!p) return p; const steps = [...p[si].steps]; steps[ti] = value; const next = [...p]; next[si] = { ...next[si], steps }; return next; });
  }
  function removeStep(si: number, ti: number) {
    setPreview((p) => { if (!p) return p; const steps = p[si].steps.filter((_, k) => k !== ti); const next = [...p]; next[si] = { ...next[si], steps }; return next; });
  }
  function addStep(si: number) {
    setPreview((p) => { if (!p) return p; const next = [...p]; next[si] = { ...next[si], steps: [...next[si].steps, ""] }; return next; });
  }
  function editTitle(si: number, value: string) {
    setPreview((p) => { if (!p) return p; const next = [...p]; next[si] = { ...next[si], title: value }; return next; });
  }
  function removeSection(si: number) {
    setPreview((p) => { if (!p) return p; return p.filter((_, k) => k !== si).map((s, k) => ({ ...s, seq: k })); });
  }

  // Promote a step LINE into its own section, placed right after the current one. Its title maps to a
  // system automatically (e.g. "Setup Salesforce Account" -> salesforce). Any lines nested UNDER it
  // (greater indent) move along as the new section's steps. This is how a lumped section like "LOB
  // Applications" gets split so each app becomes its own modeled section.
  function promoteStep(si: number, ti: number) {
    setPreview((p) => {
      if (!p) return p;
      const sec = p[si];
      const line = sec.steps[ti] ?? "";
      const title = line.trim();
      if (!title) return p;
      const indent = line.match(/^ */)?.[0].length ?? 0;
      // children = the immediately-following lines indented deeper than this one
      let end = ti + 1;
      while (end < sec.steps.length && (sec.steps[end].match(/^ */)?.[0].length ?? 0) > indent) end++;
      const children = sec.steps.slice(ti + 1, end).map((s) => s.replace(new RegExp(`^ {0,${indent}}`), ""));
      const remaining = [...sec.steps.slice(0, ti), ...sec.steps.slice(end)];
      const systemKey = headerToSystemKey(title);
      const newSection: Section = { seq: 0, systemKey, title, status: systemKey ? "automated" : "unmodeled", steps: children };
      const next = [...p];
      next[si] = { ...sec, steps: remaining };
      next.splice(si + 1, 0, newSection);
      return next.map((s, k) => ({ ...s, seq: k }));
    });
  }

  // Load the client's CURRENT saved runbook (for the selected action) into the editor — so an
  // already-modeled runbook can be restructured (promote lines, reorder, rename) without re-fetching.
  function loadCurrent() {
    const secs = current?.[action] ?? [];
    setPreview(secs.map((s, k) => ({ ...s, seq: k, steps: [...s.steps] })));
    setError(null);
  }

  // Pull the article's CURRENT body from ServiceNow into the textarea — then the normal
  // parse-preview -> save flow applies (a KB edit never silently rewrites the client).
  async function fetchKb(kb: KbRef) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/runbook/kb-text?article=${encodeURIComponent(kb.number)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setText(d.text ?? "");
      setAction(kb.action);          // this KB belongs to that action — select it automatically
      setDetectedAction(kb.action);  // and remember it, so flipping the action warns
      setKbNumber(kb.number);        // keep the KB linked on save
      setPreview(null); setImported(null);
    } finally {
      setBusy(false);
    }
  }

  // Fetch a specific KB by number (typed in) — for a client with no associated KB (e.g. a child
  // account with no model of its own). Detects onboard/offboard from the article and links the KB.
  const [kbInput, setKbInput] = useState("");
  async function fetchByNumber(num: string) {
    const article = num.trim().toUpperCase();
    if (!/^KB\d{4,12}$/.test(article)) { setError("enter a KB number like KB0012345"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/runbook/kb-text?article=${encodeURIComponent(article)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      setText(d.text ?? "");
      setKbNumber(article);
      const det = (d.detectedAction ?? null) as "onboard" | "offboard" | null;
      setDetectedAction(det);
      const act = det ?? action;
      if (det) setAction(det);
      setImported(null); setPreview(null);
      if ((d.text ?? "").trim()) await call(false, d.text, act);
    } finally {
      setBusy(false);
    }
  }

  // Import the KB body from an uploaded ServiceNow JSON export (records[].text) — same parse-preview
  // -> save flow, but sourced from a file when the integration account can't read kb_knowledge.
  async function importJson(file: File) {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/clients/${slug}/runbook/kb-json`, { method: "POST", body: await file.text() });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error ?? `failed (${r.status})`); return; }
      const records: { number: string; title: string; text: string; detectedAction?: "onboard" | "offboard" | null }[] = d.records ?? [];
      setImported(records);
      const t = records[0]?.text ?? "";
      setText(t);
      setKbNumber(records[0]?.number || null); // stamp the imported KB number onto the saved sections
      setPreview(null);
      // Auto-select the detected action (onboard/offboard) so the KB isn't saved to the wrong one.
      const det = records[0]?.detectedAction ?? null;
      setDetectedAction(det);
      const act = det ?? action;
      if (det) setAction(det);
      // Immediately show the structured preview (AI when enabled) so the operator sees the result.
      if (t.trim()) await call(false, t, act);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <button onClick={() => setOpen(true)} style={{ marginTop: "0.5rem" }}>Paste / edit runbook</button>;
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 4, padding: "0.75rem", marginTop: "0.5rem" }}>
      {kbArticles.length > 0 && (
        <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
          <span className="note">KB changed in ServiceNow?</span>
          {kbArticles.map((a) => (
            <button key={a.number} disabled={busy} onClick={() => fetchKb(a)} title={`Fetch ${a.number} (${a.action}) from ServiceNow into the editor`}>
              ⟳ Fetch {a.number} <span className="note" style={{ fontSize: 10 }}>({a.action})</span>
            </button>
          ))}
          <span className="note muted">then Preview the parse and Save to update the runbook + systems</span>
        </div>
      )}
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <span className="note">Use a specific KB:</span>
        <input value={kbInput} onChange={(e) => setKbInput(e.target.value)} placeholder="KB0012345" style={{ width: 120, fontSize: 12 }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fetchByNumber(kbInput); } }} />
        <button disabled={busy || !kbInput.trim()} onClick={() => fetchByNumber(kbInput)}>⟳ Fetch</button>
        <span className="note muted">type a KB number to use for this client (e.g. a child with no model of its own)</span>
      </div>
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <span className="note">Can&rsquo;t read the KB? Import a ServiceNow JSON export:</span>
        <label className="button" style={{ display: "inline-flex", alignItems: "center", padding: "0.26rem 0.6rem", fontSize: 12, border: "1px solid var(--line-2)", borderRadius: 8, cursor: busy ? "default" : "pointer", background: "var(--bg)" }}>
          ⬆ Import KB JSON
          <input type="file" accept=".json,application/json" disabled={busy} style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ""; }} />
        </label>
        {imported && imported.length > 1 && (
          <select disabled={busy} style={{ width: "auto", fontSize: 12 }} onChange={(e) => { const r = imported[Number(e.target.value)]; setText(r?.text ?? ""); setKbNumber(r?.number || null); setPreview(null); }}>
            {imported.map((r, i) => <option key={i} value={i}>{r.number || `record ${i + 1}`}{r.title ? ` — ${r.title}` : ""}</option>)}
          </select>
        )}
        {imported && <span className="note muted">loaded {imported[0]?.number || "KB"}{imported.length > 1 ? ` (+${imported.length - 1} more — pick above)` : ""} — Preview &amp; Save below</span>}
      </div>
      <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
        <label htmlFor="rb-action">Action</label>
        <select id="rb-action" value={action} onChange={(e) => { setAction(e.target.value as never); setPreview(null); }}>
          <option value="onboard">onboard</option>
          <option value="offboard">offboard</option>
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, margin: 0, color: "var(--fg)" }} title="Use Azure OpenAI to structure messy KB text into sections mapped to systems (recommended for imported KBs)">
          <input type="checkbox" checked={useAI} onChange={(e) => { setUseAI(e.target.checked); setPreview(null); }} style={{ width: "auto" }} />
          ✨ Use AI to detect sections
        </label>
        <span className="note">Headers like “Active Directory”, “Microsoft 365”, “Exchange” auto-map to a system.</span>
      </div>
      {current && (current[action]?.length ?? 0) > 0 && (
        <div className="toolbar" style={{ marginBottom: "0.5rem" }}>
          <button onClick={loadCurrent} disabled={busy} title={`Load this client's saved ${action} runbook into the editor to restructure it`}>
            ✎ Edit current {action} runbook
          </button>
          <span className="note muted">load the saved sections, then use <b>↥ section</b> on a line to split it out (e.g. each app under “LOB Applications”), reorder, and Save.</span>
        </div>
      )}
      {detectedAction && action !== detectedAction && (
        <p className="note" style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "0.45rem 0.65rem", margin: "0 0 0.5rem" }}>
          ⚠ This article looks like an <b>{detectedAction}</b> runbook, but you’ve set the action to <b>{action}</b>.
          Saving will write it to the <b>{action}</b> runbook — switch back to <b>{detectedAction}</b> unless this is intentional.
        </p>
      )}
      <textarea value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} rows={12}
        placeholder={`Active Directory\n- create the user in OU=...\n- add to base groups\n\nMicrosoft 365\n- assign the license\n\nOrder equipment\n- email procurement`}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} />
      {error && <p className="note danger">{error}</p>}
      <div className="toolbar" style={{ marginTop: "0.5rem" }}>
        <button onClick={() => call(false)} disabled={busy || !text.trim()}>Preview</button>
        <button className="primary" onClick={saveEdited} disabled={busy || (!text.trim() && !preview)}>{busy ? "Saving…" : preview ? "Save runbook (with your order)" : "Save runbook"}</button>
        <span className="grow" />
        <button onClick={() => { setOpen(false); setPreview(null); }}>Cancel</button>
      </div>
      {preview && (
        <div style={{ marginTop: "0.6rem" }}>
          {/* Suggestions for license / username lines — free text still allowed. */}
          <datalist id="rb-suggest">
            {[...COMMON_LICENSES, ...COMMON_USERNAME_PATTERNS].map((v) => <option key={v} value={v} />)}
          </datalist>
          <p className="note">Preview — {preview.length} section{preview.length === 1 ? "" : "s"} ({preview.filter((s) => s.systemKey).length} mapped to a system){usedAI ? " · ✨ structured by AI" : useAI ? " · AI unavailable, used heuristic parse" : ""}. Edit any line (fix a username or license), ✕ to remove, + add a step, ▲▼ to reorder — then Save.</p>
          {preview.map((s, si) => (
            <div key={si} style={{ margin: "0.4rem 0", paddingLeft: "0.4rem", borderLeft: "2px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Arrows up={() => moveSection(si, -1)} down={() => moveSection(si, 1)} disUp={si === 0} disDown={si === preview.length - 1} title="section" />
                <span style={{ fontWeight: 700 }}>{si + 1}.</span>
                <input value={s.title} onChange={(e) => editTitle(si, e.target.value)} aria-label="section title"
                  style={{ fontWeight: 700, fontSize: 13, flex: 1, minWidth: 0, maxWidth: 320 }} />
                <span className="badge" style={{ color: s.systemKey ? "#2e7d32" : "var(--muted)" }}>{s.systemKey ?? "unmodeled"}</span>
                <button onClick={() => removeSection(si)} title="remove this whole section" style={{ fontSize: 11, color: "#b91c1c" }}>✕ section</button>
              </div>
              <ul style={{ margin: "0.2rem 0", listStyle: "none", paddingLeft: 0 }}>
                {s.steps.map((st, ti) => (
                  <li key={ti} style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: (st.match(/^ */)?.[0].length ?? 0) * 6, marginBottom: 2 }}>
                    <Arrows up={() => moveStep(si, ti, -1)} down={() => moveStep(si, ti, 1)} disUp={ti === 0} disDown={ti === s.steps.length - 1} title="step" />
                    <input value={st} onChange={(e) => editStep(si, ti, e.target.value)} list="rb-suggest" aria-label="step"
                      style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "monospace" }} />
                    <button onClick={() => promoteStep(si, ti)} title="make this line its own section (auto-maps to a system if the name is recognized, e.g. Salesforce, Zoom)" style={{ fontSize: 11, padding: "0 6px", whiteSpace: "nowrap" }}>↥ section</button>
                    <button onClick={() => removeStep(si, ti)} title="remove this step" style={{ fontSize: 12, color: "#b91c1c", padding: "0 6px" }}>✕</button>
                  </li>
                ))}
                <li style={{ marginTop: 2 }}>
                  <button onClick={() => addStep(si)} style={{ fontSize: 12 }}>+ add step</button>
                </li>
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
