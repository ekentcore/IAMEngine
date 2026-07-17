"use client";

// The connector builder. One state array of connectors drives the list; an editor panel opens for a
// new draft or an existing row. The editor is intentionally a validated JSON surface, not a dozen
// bespoke sub-forms: the definition schema is the contract (docs/CONNECTOR_BUILDER.md), the server
// re-validates on every save, and a HAR import / example fills the box so nobody starts from blank.
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ConnectorRow } from "../_lib/loader";
import { HTTP_EXAMPLE, BROWSER_EXAMPLE } from "./examples";
import { HarImport } from "./har-import";
import { CodegenImport } from "./codegen-import";

type EditorState = {
  id: string | null; // null = a new draft
  key: string;
  name: string;
  kind: "http" | "browser";
  notes: string;
  json: string;
};

async function send(url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const errs = Array.isArray(data.errors) ? data.errors.join("\n") : (data.error ?? `HTTP ${res.status}`);
    throw new Error(String(errs));
  }
  return data;
}

function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = { published: "var(--ok, #15803d)", draft: "var(--muted, #6b7280)", archived: "var(--warn, #b45309)" };
  return (
    <span className="mono" style={{ fontSize: "0.75rem", padding: "0.1rem 0.4rem", borderRadius: 4, border: `1px solid ${tone[status] ?? "var(--line)"}`, color: tone[status] ?? "inherit" }}>
      {status}
    </span>
  );
}

export function ConnectorsAdmin({ initial }: { initial: ConnectorRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<ConnectorRow[]>(initial);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => router.refresh();

  const openNew = (kind: "http" | "browser") =>
    setEditor({ id: null, key: "custom-", name: "", kind, notes: "", json: JSON.stringify(kind === "http" ? HTTP_EXAMPLE : BROWSER_EXAMPLE, null, 2) });

  const openEdit = (c: ConnectorRow) =>
    setEditor({ id: c.id, key: c.key, name: c.name, kind: c.kind as "http" | "browser", notes: c.notes ?? "", json: JSON.stringify(c.definition, null, 2) });

  const close = () => { setEditor(null); setErr(null); setMsg(null); };

  const save = async () => {
    if (!editor) return;
    setErr(null); setMsg(null);
    let definition: unknown;
    try {
      definition = JSON.parse(editor.json);
    } catch (e) {
      setErr(`definition is not valid JSON: ${(e as Error).message}`);
      return;
    }
    setBusy(true);
    try {
      if (editor.id) {
        const updated = await send(`/api/connectors/${editor.id}`, "PATCH", { name: editor.name, definition, notes: editor.notes });
        setRows((r) => r.map((x) => (x.id === editor.id ? { ...x, ...(updated as object) } as ConnectorRow : x)));
        setMsg("Saved.");
      } else {
        const created = await send("/api/connectors", "POST", { key: editor.key.trim(), name: editor.name, kind: editor.kind, definition, notes: editor.notes });
        setRows((r) => [created as unknown as ConnectorRow, ...r]);
        setEditor((s) => (s ? { ...s, id: (created as { id: string }).id } : s));
        setMsg("Draft created.");
      }
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (c: ConnectorRow, kind: "publish" | "archive") => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const url = kind === "publish" ? `/api/connectors/${c.id}/publish` : `/api/connectors/${c.id}`;
      const updated = await send(url, kind === "publish" ? "POST" : "DELETE");
      setRows((r) => r.map((x) => (x.id === c.id ? { ...x, ...(updated as object) } as ConnectorRow : x)));
      setMsg(kind === "publish" ? `Published — clients can now attach "${c.key}".` : `Archived "${c.key}".`);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, margin: "0.8rem 0", flexWrap: "wrap" }}>
        <button type="button" onClick={() => openNew("http")}>New REST connector</button>
        <button type="button" onClick={() => openNew("browser")}>New browser connector</button>
      </div>

      {rows.length === 0 ? (
        <p className="note">No connectors yet. Start one from an example above, or import a HAR capture inside the editor.</p>
      ) : (
        <div>
          {rows.map((c) => (
            <div key={c.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginBottom: "0.6rem" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span className="mono note">{c.key}</span>
                <StatusBadge status={c.status} />
                <strong>{c.name}</strong>
                <span className="note">{c.kind} · {c.secretNames.join(", ") || "no secret"}</span>
              </div>
              {c.notes && <p className="note" style={{ margin: "0.35rem 0 0" }}>{c.notes}</p>}
              <div style={{ display: "flex", gap: 8, marginTop: "0.55rem", flexWrap: "wrap" }}>
                <button type="button" onClick={() => openEdit(c)} disabled={busy}>Edit</button>
                {c.status !== "published" && <button type="button" onClick={() => act(c, "publish")} disabled={busy}>Publish</button>}
                {c.status === "published" && <button type="button" onClick={() => act(c, "publish")} disabled={busy}>Re-publish</button>}
                {c.status !== "archived" && <button type="button" onClick={() => act(c, "archive")} disabled={busy}>Archive</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {editor && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.9rem", marginTop: "0.6rem", background: "var(--panel, transparent)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>{editor.id ? "Edit connector" : "New connector"}</h2>
            <span className="note">{editor.kind}</span>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "0.6rem 0" }}>
            <label style={{ flex: "1 1 200px" }}>
              <div className="note">Key (custom-…)</div>
              <input value={editor.key} disabled={!!editor.id} onChange={(e) => setEditor({ ...editor, key: e.target.value })} placeholder="custom-notion" style={{ width: "100%" }} />
            </label>
            <label style={{ flex: "1 1 200px" }}>
              <div className="note">Name</div>
              <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} placeholder="Notion" style={{ width: "100%" }} />
            </label>
          </div>

          <label style={{ display: "block", margin: "0.4rem 0" }}>
            <div className="note">Notes (optional)</div>
            <input value={editor.notes} onChange={(e) => setEditor({ ...editor, notes: e.target.value })} style={{ width: "100%" }} />
          </label>

          {editor.kind === "http" && (
            <HarImport
              onApply={(def) => setEditor((s) => (s ? { ...s, json: JSON.stringify(def, null, 2) } : s))}
              currentJson={editor.json}
            />
          )}
          {editor.kind === "browser" && (
            <CodegenImport
              onApply={(def) => setEditor((s) => (s ? { ...s, json: JSON.stringify(def, null, 2) } : s))}
              currentJson={editor.json}
            />
          )}

          <label style={{ display: "block", margin: "0.4rem 0" }}>
            <div className="note">Definition (JSON) — validated on save; see the Help page for the schema</div>
            <textarea
              value={editor.json}
              onChange={(e) => setEditor({ ...editor, json: e.target.value })}
              spellCheck={false}
              className="mono"
              style={{ width: "100%", minHeight: 320, fontSize: "0.8rem" }}
            />
          </label>

          {err && <p style={{ color: "var(--err, #b91c1c)", whiteSpace: "pre-wrap" }}>{err}</p>}
          {msg && <p className="note">{msg}</p>}

          <div style={{ display: "flex", gap: 8, marginTop: "0.4rem" }}>
            <button type="button" onClick={save} disabled={busy}>{editor.id ? "Save draft" : "Create draft"}</button>
            <button type="button" onClick={close} disabled={busy}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
