"use client";

// Settings → LLM providers: the fix lane's provider registry. Presets one-click-fill Claude /
// OpenAI / OpenRouter / Azure AI / Hugging Face; any OpenAI-compatible endpoint works with a
// custom base URL. The API key is write-only — the server only ever returns its last 4 chars.
import { useState } from "react";
import { ADAPTERS, LLM_PROVIDER_PRESETS, type LlmAdapter } from "@/lib/fixes/provider-presets";
import type { MaskedLlmProvider } from "@/lib/fixes/providers";

type FormState = { name: string; adapter: LlmAdapter; baseUrl: string; model: string; apiKey: string };
const EMPTY: FormState = { name: "", adapter: "openai-compatible", baseUrl: "", model: "", apiKey: "" };

const inputStyle = { fontSize: 13, padding: "4px 8px", width: "100%" } as const;

export function LlmProviders({ initial }: { initial: MaskedLlmProvider[] }) {
  const [providers, setProviders] = useState(initial);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null); // null = adding
  const [open, setOpen] = useState(initial.length === 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

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
      const payload = { name: form.name, adapter: form.adapter, baseUrl: form.baseUrl, model: form.model, ...(form.apiKey.trim() ? { apiKey: form.apiKey } : {}) };
      const res = editingId
        ? await call(`/api/admin/llm-providers/${editingId}`, "PATCH", payload)
        : await call("/api/admin/llm-providers", "POST", payload);
      if (!res.ok) return;
      const p = res.data.provider as MaskedLlmProvider;
      setProviders((list) => (editingId ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p]));
      setForm(EMPTY); setEditingId(null); setOpen(false);
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

  async function test(p: MaskedLlmProvider) {
    setTestResult((m) => ({ ...m, [p.id]: "testing…" }));
    const r = await fetch(`/api/admin/llm-providers/${p.id}/test`, { method: "POST" });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; detail?: string; error?: string };
    setTestResult((m) => ({ ...m, [p.id]: data.ok ? `✓ ${data.detail ?? "ok"}` : `✗ ${data.detail ?? data.error ?? `failed (${r.status})`}` }));
  }

  function startEdit(p: MaskedLlmProvider) {
    setEditingId(p.id);
    setForm({ name: p.name, adapter: p.adapter as LlmAdapter, baseUrl: p.baseUrl, model: p.model, apiKey: "" });
    setOpen(true);
    setErr(null);
  }

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
            {providers.map((p) => (
              <tr key={p.id} style={{ borderBottom: "1px solid var(--line-2, #f1f5f9)", verticalAlign: "top" }}>
                <td style={{ padding: "4px 8px" }}>
                  <input type="radio" name="llm-default" checked={p.isDefault} disabled={busy} onChange={() => makeDefault(p)} style={{ width: "auto" }} aria-label={`Make ${p.name} the default provider`} />
                </td>
                <td style={{ padding: "4px 8px" }}><b>{p.name}</b></td>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap" }}>{p.adapter}</td>
                <td style={{ padding: "4px 8px", overflowWrap: "anywhere" }}>{p.model}<span className="note" style={{ display: "block", fontSize: 11, overflowWrap: "anywhere" }}>{p.baseUrl}</span></td>
                <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{p.apiKeyMasked}</td>
                <td style={{ padding: "4px 8px", whiteSpace: "nowrap", textAlign: "right" }}>
                  <button type="button" onClick={() => test(p)} disabled={busy} style={{ fontSize: 12, marginRight: 4 }}>Test</button>
                  <button type="button" onClick={() => startEdit(p)} disabled={busy} style={{ fontSize: 12, marginRight: 4 }}>Edit</button>
                  <button type="button" onClick={() => remove(p)} disabled={busy} style={{ fontSize: 12, color: "var(--err-fg, #b91c1c)" }}>Remove</button>
                  {testResult[p.id] && (
                    <span className="note" style={{ display: "block", fontSize: 11, maxWidth: 320, whiteSpace: "normal", overflowWrap: "anywhere", color: testResult[p.id].startsWith("✓") ? "var(--ok-fg, #15803d)" : testResult[p.id].startsWith("✗") ? "var(--err-fg, #b91c1c)" : undefined }}>
                      {testResult[p.id]}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!open && (
        <button type="button" onClick={() => { setOpen(true); setEditingId(null); setForm(EMPTY); setErr(null); }} style={{ fontSize: 13 }}>
          + Add provider
        </button>
      )}

      {open && (
        <div style={{ border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, padding: "0.75rem 1rem", maxWidth: 560 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <span className="note" style={{ alignSelf: "center" }}>Presets:</span>
            {LLM_PROVIDER_PRESETS.map((preset) => (
              <button key={preset.key} type="button" style={{ fontSize: 12 }}
                onClick={() => set({ name: preset.name, adapter: preset.adapter, baseUrl: preset.baseUrl, model: preset.model })}>
                {preset.name}
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
            <label htmlFor="llm-key">API key</label>
            <input id="llm-key" type="password" autoComplete="off" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} style={inputStyle}
              placeholder={editingId ? "leave blank to keep the current key" : "paste the key — shown only as its last 4 chars afterwards"} />
          </div>
          {form.name && LLM_PROVIDER_PRESETS.some((p) => p.name === form.name) && (
            <p className="note" style={{ marginTop: 6, fontSize: 11 }}>
              Key: {LLM_PROVIDER_PRESETS.find((p) => p.name === form.name)?.keyHint}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
            <button type="button" onClick={save} disabled={busy || !form.name.trim() || !form.baseUrl.trim() || !form.model.trim() || (!editingId && !form.apiKey.trim())} style={{ fontWeight: 600 }}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Add provider"}
            </button>
            <button type="button" onClick={() => { setOpen(false); setEditingId(null); setForm(EMPTY); setErr(null); }} disabled={busy}>Cancel</button>
            {err && <span className="note" style={{ color: "var(--err-fg, #b91c1c)" }}>{err}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
