"use client";

// Set which groups new users get added to (config.onboard.groups — the executed value, not the doc).
// Each group can carry a type hint from the KB (DL / Security / 365); the runner verifies the real
// type in Entra and narrates it. "Auto-detect" leaves it to the runner.
import { useState } from "react";
import { useRouter } from "next/navigation";

type GroupRow = { name: string; type: "auto" | "dl" | "security" | "m365" };
const TYPE_LABEL: Record<GroupRow["type"], string> = { auto: "Auto-detect", dl: "Distribution list", security: "Security", m365: "365 Group" };

export function M365GroupsEditor({ slug, current, everyUserGroups = [], groupOptions = [] }: { slug: string; current: { name: string; type?: string }[]; everyUserGroups?: string[]; groupOptions?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function start() {
    setRows(current.length ? current.map((g) => ({ name: g.name, type: (["dl", "security", "m365"].includes(g.type ?? "") ? g.type : "auto") as GroupRow["type"] })) : [{ name: "", type: "auto" }]);
    setMsg(null); setOpen(true);
  }

  // Groups that ALSO apply from the every-user rules but aren't listed here (so this list doesn't look
  // like it's missing them). Don't repeat ones already configured here.
  const extra = everyUserGroups.filter((g) => !current.some((c) => c.name.toLowerCase() === g.toLowerCase()));
  // Autocomplete pool: discovered/known groups + the every-user ones + whatever's already set.
  const datalistId = `m365-group-options-${slug}`;
  const options = [...new Set([...groupOptions, ...everyUserGroups, ...current.map((c) => c.name)].filter(Boolean))];

  const everyUserNote = extra.length > 0 && (
    <p className="note" style={{ margin: "0.2rem 0 0", color: "var(--muted)" }}>
      + {extra.length} every-user group{extra.length === 1 ? "" : "s"} from <a href={`/clients/${slug}#rules`}>Roles &amp; rules</a> also apply: {extra.join(", ")} — no need to add them here.
    </p>
  );

  if (!open) {
    return (
      <div className="note" style={{ marginTop: "0.4rem" }}>
        Onboarding groups: <b>{current.length ? current.map((g) => g.name + (g.type ? ` (${g.type})` : "")).join(", ") : "(none set)"}</b>{" "}
        <button style={{ fontSize: 12, marginLeft: 6 }} onClick={start}>Edit groups</button>
        {everyUserNote}
      </div>
    );
  }

  const setRow = (i: number, patch: Partial<GroupRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginTop: "0.4rem", maxWidth: 560 }}>
      <b style={{ fontSize: 14 }}>M365 onboarding groups</b>
      <p className="note" style={{ margin: "0.2rem 0 0.5rem" }}>Groups every new user is added to. The runner determines each group&rsquo;s real type and narrates it; the type hint just helps when the KB is explicit.</p>
      {everyUserNote}
      <datalist id={datalistId}>{options.map((g) => <option key={g} value={g} />)}</datalist>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input value={row.name} list={datalistId} placeholder="group name" onChange={(e) => setRow(i, { name: e.target.value })} style={{ fontSize: 12, flex: 1 }} />
            <select value={row.type} onChange={(e) => setRow(i, { type: e.target.value as GroupRow["type"] })} style={{ width: "auto", fontSize: 12 }} title="Type hint from the KB (runner verifies the real type)">
              {(Object.keys(TYPE_LABEL) as GroupRow["type"][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <button style={{ fontSize: 12 }} onClick={() => setRows((r) => r.filter((_, j) => j !== i))} title="Remove">✕</button>
          </div>
        ))}
      </div>
      <button style={{ fontSize: 12, marginTop: 6 }} onClick={() => setRows((r) => [...r, { name: "", type: "auto" }])}>+ Add group</button>
      {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", marginTop: 6 }}>{msg.text}</p>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const groups = rows.filter((r) => r.name.trim()).map((r) => (r.type === "auto" ? { name: r.name.trim() } : { name: r.name.trim(), type: r.type }));
            const r = await fetch(`/api/clients/${slug}/m365-groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ groups }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
            setMsg({ ok: true, text: "✓ Saved. Re-plan this client's open cases to apply." });
            router.refresh();
          } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
          finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save groups"}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
