"use client";

// Settings → LLM providers: the fix lane's provider registry. Presets one-click-fill Claude /
// OpenAI / OpenRouter / Azure AI / Hugging Face; any OpenAI-compatible endpoint works with a
// custom base URL. The API key is write-only — the server only ever returns its last 4 chars.
// (The eye toggle reveals only what YOU just typed into the box, never the stored key.)
import { useState } from "react";
import { ADAPTERS, LLM_PROVIDER_PRESETS, chatCompletionsUrl, type LlmAdapter } from "@/lib/fixes/provider-presets";
import type { MaskedLlmProvider } from "@/lib/fixes/providers";

type FormState = { name: string; adapter: LlmAdapter; baseUrl: string; model: string; apiVersion: string; apiKey: string };
const EMPTY: FormState = { name: "", adapter: "openai-compatible", baseUrl: "", model: "", apiVersion: "", apiKey: "" };

type TestState = { line: string; tone: "pending" | "ok" | "err"; asked?: string; answer?: string };

const inputStyle = { fontSize: 13, padding: "4px 8px", width: "100%" } as const;

// A "reveal" eye — struck through once the value is already visible.
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

export function LlmProviders({ initial }: { initial: MaskedLlmProvider[] }) {
  const [providers, setProviders] = useState(initial);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null); // null = adding
  const [open, setOpen] = useState(initial.length === 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, TestState>>({});
  const [askId, setAskId] = useState<string | null>(null); // provider whose ask box is open
  const [question, setQuestion] = useState("");

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) setErr(typeof data.error === "string" ? data.error : `failed (${r.status})`);
    return { ok: r.ok, data };
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const payload = {
        name: form.name,
        adapter: form.adapter,
        baseUrl: form.baseUrl,
        model: form.model,
        // Always sent, so clearing the box clears the pinned version server-side.
        apiVersion: form.adapter === "openai-compatible" ? form.apiVersion : "",
        ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}),
      };
      const res = editingId
        ? await call(`/api/admin/llm-providers/${editingId}`, "PATCH", payload)
        : await call("/api/admin/llm-providers", "POST", payload);
      if (!res.ok) return;
      const p = res.data.provider as MaskedLlmProvider;
      setProviders((list) => (editingId ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
      setForm(EMPTY); setEditingId(null); setOpen(false); setShowKey(false);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: MaskedLlmProvider) {
    if (!confirm(`Remove provider "${p.name}"? Its stored API key is deleted.`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await call(`/api/admin/llm-providers/${p.id}`, "DELETE");
      if (!res.ok) return;
      setProviders((list) => {
        const rest = list.filter((x) => x.id !== p.id);
        // Mirror the server: deleting the default promotes the oldest remaining provider.
        if (p.isDefault && rest.length > 0 && !rest.some((x) => x.isDefault)) rest[0] = { ...rest[0], isDefault: true };
        return rest;
      });
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(p: MaskedLlmProvider) {
    setBusy(true); setErr(null);
    try {
      const res = await call(`/api/admin/llm-providers/${p.id}`, "PATCH", { isDefault: true });
      if (!res.ok) return;
      setProviders((list) => list.map((x) => ({ ...x, isDefault: x.id === p.id })));
    } finally {
      setBusy(false);
    }
  }

  // No question → a 1-token "ping" that only proves the endpoint, key and model resolve.
  // A question → the model actually answers it, and the reply is shown.
  async function test(p: MaskedLlmProvider, ask?: string) {
    const q = (ask ?? "").trim();
    setTestResult((m) => ({ ...m, [p.id]: { line: q ? "asking…" : "testing…", tone: "pending" } }));
    const r = await fetch(`/api/admin/llm-providers/${p.id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(q ? { question: q } : {}),
    });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; detail?: string; error?: string; answer?: string; asked?: string };
    setTestResult((m) => ({
      ...m,
      [p.id]: data.ok
        ? { line: `✓ ${data.detail ?? "ok"}`, tone: "ok", asked: data.asked, answer: data.answer }
        : { line: `✗ ${data.detail ?? data.error ?? `failed (${r.status})`}`, tone: "err" },
    }));
  }

  function startEdit(p: MaskedLlmProvider) {
    setEditingId(p.id);
    setForm({ name: p.name, adapter: p.adapter as LlmAdapter, baseUrl: p.baseUrl, model: p.model, apiVersion: p.apiVersion ?? "", apiKey: "" });
    setOpen(true);
    setShowKey(false);
    setErr(null);
  }

  const preset = LLM_PROVIDER_PRESETS.find((x) => x.name === form.name);
  const toneColor = (t: TestState["tone"]) => (t === "ok" ? "var(--ok-fg, #15803d)" : t === "err" ? "var(--err-fg, #b91c1c)" : undefined);

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2>LLM providers</h2>
      <p className="note" style={{ marginBottom: "0.75rem" }}>
        The self-healing fix lane analyzes failures with one of these providers (the <b>default</b> one).
        Keys are entered here, stored server-side, and never shown again — only their last 4 characters.
      </p>

      {providers.length > 0 && (
        <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", marginBottom: "0.75rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line, #e5e7eb)" }}>
              <th style={{ padding: "4px 8px" }}>Default</th>
              <th style={{ padding: "4px 8px" }}>Name</th>
              <th style={{ padding: "4px 8px" }}>Adapter</th>
              <th style={{ padding: "4px 8px" }}>Model</th>
              <th style={{ padding: "4px 8px" }}>API key</th>
              <th style={{ padding: "4px 8px" }} />
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const res = testResult[p.id];
              return (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top" }}>
                  <td style={{ padding: "4px 8px" }}>
                    <input type="radio" name="llm-default" checked={p.isDefault} disabled={busy} onChange={() => makeDefault(p)} style={{ width: "auto" }} aria-label={`Make ${p.name} the default provider`} />
                  </td>
                  <td style={{ padding: "4px 8px" }}><b>{p.name}</b></td>
                  <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{p.adapter}</td>
                  <td style={{ padding: "4px 8px", overflowWrap: "anywhere" }}>
                    {p.model}
                    <span className="note" style={{ display: "block", fontSize: 11, overflowWrap: "anywhere" }}>{p.baseUrl}</span>
                    {p.apiVersion && <span className="note" style={{ display: "block", fontSize: 11 }}>api-version {p.apiVersion}</span>}
                  </td>
                  <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{p.apiKeyMasked}</td>
                  <td style={{ padding: "4px 8px", whiteSpace: "nowrap", textAlign: "right" }}>
                    <button type="button" onClick={() => test(p)} disabled={busy} style={{ fontSize: 12, marginRight: 4 }}>Test</button>
                    <button type="button" onClick={() => { setAskId(askId === p.id ? null : p.id); setQuestion(""); }} disabled={busy} style={{ fontSize: 12, marginRight: 4 }}>
                      {askId === p.id ? "Close" : "Ask…"}
                    </button>
                    <button type="button" onClick={() => startEdit(p)} disabled={busy} style={{ fontSize: 12, marginRight: 4 }}>Edit</button>
                    <button type="button" onClick={() => remove(p)} disabled={busy} style={{ fontSize: 12, color: "var(--err-fg, #b91c1c)" }}>Remove</button>

                    {askId === p.id && (
                      <div style={{ marginTop: 6, textAlign: "left", maxWidth: 360, marginLeft: "auto" }}>
                        <textarea
                          value={question}
                          onChange={(e) => setQuestion(e.target.value)}
                          rows={2}
                          maxLength={2000}
                          placeholder="Ask this model anything — e.g. “which model are you?”"
                          style={{ ...inputStyle, resize: "vertical" }}
                          aria-label={`Question to send to ${p.name}`}
                        />
                        <button type="button" onClick={() => test(p, question)} disabled={busy || !question.trim() || res?.tone === "pending"} style={{ fontSize: 12, marginTop: 4 }}>
                          Send question
                        </button>
                      </div>
                    )}

                    {res && (
                      <div style={{ marginTop: 4, textAlign: "left", maxWidth: 360, marginLeft: "auto" }}>
                        <span className="note" style={{ display: "block", fontSize: 11, whiteSpace: "normal", overflowWrap: "anywhere", color: toneColor(res.tone) }}>
                          {res.line}
                        </span>
                        {res.answer && (
                          <div style={{ marginTop: 4, padding: "6px 8px", border: "1px solid var(--line, #e5e7eb)", borderRadius: 6, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 220, overflowY: "auto" }}>
                            {res.asked && <div className="note" style={{ fontSize: 11, marginBottom: 4 }}>asked: {res.asked}</div>}
                            {res.answer}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!open && (
        <button type="button" onClick={() => { setOpen(true); setEditingId(null); setForm(EMPTY); setErr(null); setShowKey(false); }} style={{ fontSize: 13 }}>
          + Add provider
        </button>
      )}

      {open && (
        <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "0.75rem 1rem", maxWidth: 560 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <span className="note" style={{ alignSelf: "center" }}>Presets:</span>
            {LLM_PROVIDER_PRESETS.map((x) => (
              <button key={x.key} type="button" style={{ fontSize: 12 }}
                onClick={() => set({ name: x.name, adapter: x.adapter, baseUrl: x.baseUrl, model: x.model, apiVersion: x.apiVersion ?? "" })}>
                {x.name}
              </button>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: "6px 10px", alignItems: "center", fontSize: 13 }}>
            <label htmlFor="llm-name">Name</label>
            <input id="llm-name" value={form.name} onChange={(e) => set({ name: e.target.value })} style={inputStyle} placeholder="Claude" />
            <label htmlFor="llm-adapter">Adapter</label>
            <select id="llm-adapter" value={form.adapter} onChange={(e) => set({ adapter: e.target.value as LlmAdapter })} style={inputStyle}>
              {ADAPTERS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <label htmlFor="llm-baseurl">Base URL</label>
            <input id="llm-baseurl" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} style={inputStyle} placeholder="https://api.anthropic.com" />
            <label htmlFor="llm-model">Model</label>
            <input id="llm-model" value={form.model} onChange={(e) => set({ model: e.target.value })} style={inputStyle} placeholder="claude-sonnet-5" />

            {/* Anthropic pins its version in a header, not a query param — this field is Azure's. */}
            {form.adapter === "openai-compatible" && (
              <>
                <label htmlFor="llm-apiversion">API version</label>
                <input id="llm-apiversion" value={form.apiVersion} onChange={(e) => set({ apiVersion: e.target.value })} style={inputStyle} placeholder="Azure only — e.g. 2024-10-21 (leave blank otherwise)" />
              </>
            )}

            <label htmlFor="llm-key">API key</label>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                id="llm-key"
                type={showKey ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                value={form.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
                style={inputStyle}
                placeholder={editingId ? "leave blank to keep the current key" : "paste the key — shown only as its last 4 chars afterwards"}
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "Hide the key" : "Show what you typed"}
                aria-label={showKey ? "Hide the key" : "Show what you typed"}
                aria-pressed={showKey}
                style={{ display: "inline-flex", alignItems: "center", padding: "4px 6px", lineHeight: 0 }}
              >
                <EyeIcon off={showKey} />
              </button>
            </div>
          </div>

          {form.adapter === "openai-compatible" && form.baseUrl.trim() && (
            <p className="note" style={{ marginTop: 6, fontSize: 11, overflowWrap: "anywhere" }}>
              Calls: {chatCompletionsUrl(form.baseUrl.trim(), form.apiVersion)}
            </p>
          )}
          {preset && <p className="note" style={{ marginTop: 6, fontSize: 11 }}>Key: {preset.keyHint}</p>}

          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button type="button" onClick={save} disabled={busy || !form.name.trim() || !form.baseUrl.trim() || !form.model.trim() || (!editingId && !form.apiKey.trim())} style={{ fontWeight: 600 }}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Add provider"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setEditingId(null); setForm(EMPTY); setErr(null); setShowKey(false); }} disabled={busy}>Cancel</button>
            {err && <span className="note" style={{ color: "var(--err-fg, #b91c1c)" }}>{err}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
