"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type SecretRowVM = {
  name: string;
  externalId: string;
  label: string | null;
  provider: string;
  referencedBy: string[];
  isSet: boolean;
};

type TestState = { status: "idle" | "testing" | "ok" | "fail"; label?: string; error?: string };

// Per-client secret wiring: map each secretName the systems reference to a Delinea secret id, and
// preflight each one ("test connection") so a tenant is verified before a real run. The app stores
// and shows only references (ids) — never the secret value.
export function SecretsPanel({
  slug,
  initialRows,
  delineaConfigured,
}: {
  slug: string;
  initialRows: SecretRowVM[];
  delineaConfigured: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  function edit(name: string, field: "externalId" | "label", value: string) {
    setRows((rs) => rs.map((r) => (r.name === name ? { ...r, [field]: value } : r)));
    setDirty(true);
    setSaveMsg(null);
  }

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/clients/${slug}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: rows.map((r) => ({ name: r.name, externalId: r.externalId, label: r.label })) }),
      });
      const data = await res.json();
      if (!res.ok) setSaveMsg(data.error ?? res.statusText);
      else {
        setDirty(false);
        router.refresh();
      }
    } catch (e) {
      setSaveMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function test(names: string[]) {
    const targets = rows.filter((r) => names.includes(r.name));
    setTests((t) => {
      const next = { ...t };
      for (const r of targets) next[r.name] = { status: "testing" };
      return next;
    });
    try {
      const res = await fetch(`/api/clients/${slug}/secrets/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: targets.map((r) => ({ name: r.name, externalId: r.externalId })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      setTests((t) => {
        const next = { ...t };
        for (const r of data.results as { name: string; ok: boolean; label?: string; error?: string }[]) {
          next[r.name] = r.ok ? { status: "ok", label: r.label } : { status: "fail", error: r.error };
        }
        return next;
      });
    } catch (e) {
      setTests((t) => {
        const next = { ...t };
        for (const r of targets) next[r.name] = { status: "fail", error: (e as Error).message };
        return next;
      });
    }
  }

  if (rows.length === 0) {
    return <p className="note">No systems reference a secret yet — add systems with secret references first.</p>;
  }

  return (
    <div>
      <p className="note">
        Map each secret to its Delinea id, then test that the app can read it. Stores references only —
        the value stays in Delinea and is fetched by the runner at run time.
        {!delineaConfigured && <> · <span className="danger">Test is disabled until DELINEA_* is set on the app.</span></>}
      </p>
      <table>
        <thead>
          <tr>
            <th>Secret</th>
            <th>Used by</th>
            <th>Delinea id</th>
            <th>Label</th>
            <th>Test</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = tests[r.name] ?? { status: "idle" as const };
            return (
              <tr key={r.name}>
                <td><code>{r.name}</code></td>
                <td className="muted">
                  {r.referencedBy.length > 0 ? r.referencedBy.join(", ") : <span title="No system references this secret — orphaned mapping">unused</span>}
                </td>
                <td>
                  <input
                    value={r.externalId}
                    onChange={(e) => edit(r.name, "externalId", e.target.value)}
                    placeholder="REPLACE_ME"
                    style={{ width: 140, fontFamily: "var(--mono, monospace)" }}
                  />
                </td>
                <td>
                  <input
                    value={r.label ?? ""}
                    onChange={(e) => edit(r.name, "label", e.target.value)}
                    placeholder="—"
                    style={{ width: 160 }}
                  />
                </td>
                <td>
                  <button onClick={() => test([r.name])} disabled={!delineaConfigured || t.status === "testing"} style={{ marginRight: 8 }}>
                    {t.status === "testing" ? "…" : "Test"}
                  </button>
                  {t.status === "ok" && <span className="badge" title={t.label}>✓ {t.label ?? "fetched"}</span>}
                  {t.status === "fail" && <span className="badge archived" title={t.error}>✗ {t.error}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="dialog-actions" style={{ justifyContent: "flex-start", marginTop: "0.75rem" }}>
        <button className="primary" onClick={save} disabled={!dirty || saving}>{saving ? "Saving…" : "Save"}</button>
        <button onClick={() => test(rows.map((r) => r.name))} disabled={!delineaConfigured}>Test all connections</button>
        {saveMsg && <span className="note danger">{saveMsg}</span>}
        {dirty && !saveMsg && <span className="note muted">Unsaved changes</span>}
      </div>
    </div>
  );
}
